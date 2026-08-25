import assert from "node:assert/strict";
import http from "node:http";
import { Transform, Writable } from "node:stream";
import test from "node:test";

import { endStreamedResponse, pipeResponse } from "../src/http-utils.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function controlledResponse(request) {
  let markedDestroyed = false;
  const response = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  Object.defineProperty(response, "destroyed", {
    configurable: true,
    get: () => markedDestroyed,
  });
  response.req = request;
  response.setHeader = () => {};
  response.getHeader = () => undefined;
  return {
    response,
    markDestroyed: () => {
      markedDestroyed = true;
    },
  };
}

async function settlesWithin(promise) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("pipeResponse did not settle")), 200);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function neverEndingUpstream(onCancel) {
  return {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      cancel() {
        onCancel();
      },
    }),
  };
}

test("a pre-aborted signal on a healthy response rejects after cancelling the upstream", async () => {
  const controller = new AbortController();
  controller.abort();
  let cancelled = false;
  const controlled = controlledResponse({ aborted: false });

  await assert.rejects(
    settlesWithin(pipeResponse(neverEndingUpstream(() => {
      cancelled = true;
    }), controlled.response, new Set(), undefined, { signal: controller.signal })),
    (error) => error?.name === "AbortError",
  );

  assert.equal(cancelled, true);
  assert.equal(controlled.response.listenerCount("close"), 0);
  assert.equal(controlled.response.listenerCount("drain"), 0);
});

test("a pre-closed response cancels a never-emitting upstream before pipeline starts", async () => {
  let cancelled = false;
  const controller = new AbortController();
  controller.abort();
  const controlled = controlledResponse({ aborted: false });
  controlled.markDestroyed();

  await settlesWithin(pipeResponse(neverEndingUpstream(() => {
    cancelled = true;
  }), controlled.response, new Set(), undefined, { signal: controller.signal }));

  assert.equal(cancelled, true);
  assert.equal(controlled.response.listenerCount("close"), 0);
  assert.equal(controlled.response.listenerCount("drain"), 0);
});

test("a caller abort signal still settles when a trusted request reports false", async () => {
  const controller = new AbortController();
  const controlled = controlledResponse({ aborted: false });
  const upstream = {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("data: first\n\n"));
        setTimeout(() => {
          controlled.markDestroyed();
          controller.abort();
        }, 10);
      },
    }),
  };

  await pipeResponse(upstream, controlled.response, new Set(), undefined, {
    signal: controller.signal,
  });
});

test("an adapter truncation stays a failure even with aborted request and signal state", async () => {
  let aborted = false;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const controlled = controlledResponse({ aborted: true });
  const adapter = new Transform({
    transform(chunk, _encoding, callback) {
      if (this.seenFirst) {
        const error = new Error("adapter detected truncated stream");
        error.code = "upstream_stream_truncated";
        controlled.markDestroyed();
        aborted = true;
        callback(error);
        return;
      }
      this.seenFirst = true;
      callback(null, chunk);
    },
  });
  const upstream = {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("data: first\n\n"));
        stream.enqueue(new TextEncoder().encode("data: truncated\n\n"));
        stream.close();
      },
    }),
  };

  await assert.rejects(
    pipeResponse(upstream, controlled.response, new Set(), [adapter], {
      signal,
    }),
    (error) => error?.code === "upstream_stream_truncated",
  );
});

test("a response close settles even before its request aborted bit updates", async () => {
  const controlled = controlledResponse({ aborted: false });
  const upstream = {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("data: first\n\n"));
        setTimeout(() => {
          controlled.markDestroyed();
          controlled.response.emit("close");
        }, 10);
      },
    }),
  };

  await pipeResponse(upstream, controlled.response, new Set());
});

// A client that hangs up mid-stream makes the response emit "close" without
// ever emitting "finish" or "error". pipeResponse must still settle, otherwise
// the router's in-flight counter never releases the request.
test("pipeResponse settles when the client disconnects mid-stream", async () => {
  let settled = false;
  let pipeError;
  let callerAborted = false;
  let upstreamCancelled = false;

  const server = http.createServer(async (request, response) => {
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
          // Never closed: the stream stays open like a live SSE upstream.
        },
        cancel() {
          upstreamCancelled = true;
        },
      }),
    };
    try {
      await pipeResponse(upstream, response, new Set());
    } catch (error) {
      pipeError = error;
    }
    callerAborted = request.aborted;
    settled = true;
  });

  const port = await listen(server);

  await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/" }, (response) => {
      response.once("data", () => {
        request.destroy();
        resolve();
      });
    });
    request.once("error", () => resolve());
    request.end();
  });

  const deadline = Date.now() + 2_000;
  while (!settled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await close(server);
  assert.equal(settled, true, "pipeResponse never settled after client disconnect");
  assert.equal(pipeError, undefined);
  assert.equal(callerAborted, true, "the server request did not record the peer abort");
  assert.equal(upstreamCancelled, true, "client abort did not cancel the upstream relay");
});

test("pipeResponse resolves after a complete response", async () => {
  let settled = false;

  const server = http.createServer(async (request, response) => {
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        },
      }),
    };
    await pipeResponse(upstream, response, new Set());
    settled = true;
  });

  const port = await listen(server);
  const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());

  await close(server);
  assert.equal(body, "done");
  assert.equal(settled, true);
});

test("pipeResponse waits for response backpressure before completing the relay", async () => {
  let settledBeforeDrain = false;
  const server = http.createServer(async (_request, response) => {
    const write = response.write.bind(response);
    let firstWrite = true;
    let drained = false;
    response.write = (...args) => {
      const accepted = write(...args);
      if (!firstWrite) return accepted;
      firstWrite = false;
      setTimeout(() => {
        drained = true;
        response.emit("drain");
      }, 10);
      return false;
    };
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("drained"));
          controller.close();
        },
      }),
    };
    await pipeResponse(upstream, response, new Set());
    settledBeforeDrain = !drained;
  });

  const port = await listen(server);
  const body = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  await close(server);

  assert.equal(body, "drained");
  assert.equal(settledBeforeDrain, false, "relay completed before response drain");
});

test("pipeResponse leaves the response writable when requested", async () => {
  const server = http.createServer(async (_request, response) => {
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
          controller.close();
        },
      }),
    };
    await pipeResponse(upstream, response, new Set(), undefined, { leaveOpen: true });
    assert.equal(response.writableEnded, false);
    response.end(" second");
  });

  const port = await listen(server);
  const body = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  await close(server);

  assert.equal(body, "first second");
});

// Read a response with the raw client so a socket reset is distinguishable
// from a complete message: a reset mid-chunked-body emits "aborted"/"error"
// and never "end", which is exactly what a reqwest client reports as
// "error decoding response body".
function readRaw(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/" }, (response) => {
      let body = "";
      let aborted = false;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("aborted", () => {
        aborted = true;
      });
      response.once("error", () => {
        aborted = true;
      });
      response.once("end", () => resolve({ body, aborted, complete: response.complete }));
      response.once("close", () => {
        if (!response.complete) resolve({ body, aborted: true, complete: false });
      });
    });
    request.once("error", reject);
    request.end();
  });
}

function failingSseUpstream(message) {
  return {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        setTimeout(() => controller.error(new Error(message)), 10);
      },
    }),
  };
}

// `.pipe()` forwards neither errors nor destroy, so an upstream body that
// failed mid-stream left the response half-written and open; the router then
// reset the socket, and the client saw only a transport decode failure with no
// cause. `pipeline` must surface the error with its message so the router can
// log it, and must leave the response endable so the chunked body terminates.
test("an upstream body that fails mid-stream ends the chunked body instead of resetting", async () => {
  let pipeError;
  let headersCommitted;
  const logged = [];
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });

  const server = http.createServer(async (request, response) => {
    try {
      await pipeResponse(
        failingSseUpstream("upstream exploded"),
        response,
        new Set(),
        [transform],
      );
    } catch (error) {
      pipeError = error;
      // The router keys its meter off this: an upstream failure after the
      // head was committed must record an abort, not the committed 200.
      headersCommitted = response.headersSent;
      // The router's top-level handler: log the cause, then terminate the
      // stream gracefully rather than destroying the socket.
      logged.push(
        `[codex-router] request failed: ${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }`,
      );
      endStreamedResponse(response);
    }
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(pipeError instanceof Error, true, "the upstream failure must surface");
  assert.equal(pipeError.message, "upstream exploded");
  assert.equal(
    headersCommitted,
    true,
    "the failure surfaced after the 200 head was already committed",
  );
  // The message is what made this diagnosable at all; the old handler logged a
  // bare string with no error attached.
  assert.deepEqual(logged, ["[codex-router] request failed: Error: upstream exploded"]);

  assert.equal(result.aborted, false, "the socket was reset instead of ending the body");
  assert.equal(result.complete, true, "the chunked body never reached its terminator");
  assert.match(result.body, /data: first/);
  // A silently truncated SSE stream reads to the client as a short successful
  // turn, so the failure is stated as a terminal event before the clean end.
  assert.match(result.body, /event: error/);
  assert.match(result.body, /local_router_stream_failed/);

  // `pipeline` tears the whole chain down; `.pipe()` left the transform alive.
  assert.equal(transform.destroyed, true, "the failure did not destroy the chain");
});

test("an adapter truncation leaves the real response writable for a terminal error", async () => {
  let pipeError;
  let destroyedAtCatch;
  const adapter = new Transform({
    transform(chunk, _encoding, callback) {
      if (this.seenFirst) {
        const error = new Error("adapter detected truncated stream");
        error.code = "upstream_stream_truncated";
        callback(error);
        return;
      }
      this.seenFirst = true;
      callback(null, chunk);
    },
  });
  const upstream = {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("data: truncated\n\n"));
          controller.close();
        }, 10);
      },
    }),
  };
  const server = http.createServer(async (_request, response) => {
    try {
      await pipeResponse(upstream, response, new Set(), [adapter]);
    } catch (error) {
      pipeError = error;
      destroyedAtCatch = response.destroyed;
      endStreamedResponse(response);
    }
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(pipeError?.code, "upstream_stream_truncated");
  assert.equal(destroyedAtCatch, false, "pipeline destroyed the real ServerResponse");
  assert.equal(result.aborted, false, "adapter failure reset the caller socket");
  assert.equal(result.complete, true, "terminal error did not finish the chunked body");
  assert.match(result.body, /data: first/);
  assert.match(result.body, /local_router_stream_failed/);
});

// A local ServerResponse destroy also marks its IncomingMessage as aborted.
// That is indistinguishable from a peer cancellation if pipeResponse ignores
// the pipeline error's ownership. Reproduce that HTTP state, then control the
// writable teardown ordering so the delayed adapter failure is observable.
test("an adapter truncation rejects after local response destroy marks the request aborted", async () => {
  let pipeError;
  let serverSettled = false;
  const server = http.createServer(async (request, response) => {
    response.write("data: first\n\n");
    const aborted = new Promise((resolve) => request.once("aborted", resolve));
    response.destroy();
    await aborted;
    const controlled = controlledResponse(request);
    const adapter = new Transform({
      transform(chunk, _encoding, callback) {
        if (this.seenFirst) {
          const error = new Error("adapter detected truncated stream");
          error.code = "upstream_stream_truncated";
          // Pipeline must attach the writable while it is healthy. This is the
          // post-first-frame state the adapter sees when its own failure then
          // tears the destination down.
          controlled.markDestroyed();
          setImmediate(() => callback(error));
          return;
        }
        this.seenFirst = true;
        callback(null, chunk);
      },
    });
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: relayed\n\n"));
          controller.enqueue(new TextEncoder().encode("data: truncated\n\n"));
          controller.close();
        },
      }),
    };
    try {
      await pipeResponse(upstream, controlled.response, new Set(), [adapter]);
    } catch (error) {
      pipeError = error;
    }
    serverSettled = true;
  });

  const port = await listen(server);
  await new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/" }, (response) => {
      response.resume();
      response.once("close", resolve);
    });
    request.once("error", resolve);
    request.end();
  });
  const deadline = Date.now() + 2_000;
  while (!serverSettled && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await close(server);

  assert.equal(serverSettled, true, "server did not observe the local response teardown");
  assert.equal(pipeError?.code, "upstream_stream_truncated");
  assert.equal(pipeError?.message, "adapter detected truncated stream");
});

// The case above fails between two complete events, which is the lucky one. A
// real reset lands wherever it lands, and transforms forward upstream's chunk
// boundaries verbatim, so the client is often left holding an unterminated
// `data:` line. Writing the terminal frame straight onto it produces no error
// event at all: a conforming parser reads `event: error` as more of the
// previous event's data, so the one signal saying the router lost the stream
// becomes garbage glued to the last delta.
test("a mid-line upstream failure still yields a parseable terminal error event", async () => {
  const partial = 'data: {"type":"response.output_text.delta","delta":"unterminated';
  const upstream = {
    status: 200,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: new ReadableStream({
      start(controller) {
        // No trailing newline: the stream dies mid-field.
        controller.enqueue(new TextEncoder().encode(partial));
        setTimeout(() => controller.error(new Error("reset mid-line")), 10);
      },
    }),
  };

  const server = http.createServer(async (request, response) => {
    try {
      await pipeResponse(upstream, response, new Set(), []);
    } catch {
      endStreamedResponse(response);
    }
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(result.complete, true, "the chunked body never reached its terminator");

  // The field name must begin a line of its own. Without the blank-line prefix
  // this assertion fails: the body reads "...unterminatedevent: error".
  assert.match(
    result.body,
    /\nevent: error\n/,
    "the terminal frame was glued onto the unterminated data line",
  );

  // And the frame must survive an actual SSE parse rather than merely appearing
  // in the bytes: split on the blank-line dispatch boundary and require an
  // event whose own `event:` field is `error` and whose data parses.
  const events = result.body.split(/\r?\n\r?\n/).filter((block) => block.trim());
  const errorEvent = events.find((block) => /^event: error$/m.test(block));
  assert.ok(errorEvent, "no dispatched event declared itself an error");
  const dataLine = errorEvent.split(/\r?\n/).find((line) => line.startsWith("data: "));
  assert.equal(
    JSON.parse(dataLine.slice(6)).code,
    "local_router_stream_failed",
    "the terminal frame did not carry the router's failure code",
  );

  // The truncated delta is unavoidable -- upstream died there -- but it must
  // not have absorbed the router's frame.
  assert.equal(
    /unterminatedevent/.test(result.body),
    false,
    "router protocol text leaked into the model's output span",
  );
});

// Only SSE gets a terminal event. Injecting one into a JSON body would corrupt
// it; a truncated JSON body already fails the client's parser, and a clean end
// still beats a reset because the failure is a parse error rather than an
// unexplained transport reset.
test("a non-SSE body is ended without an injected event frame", async () => {
  let pipeError;

  const server = http.createServer(async (request, response) => {
    const upstream = {
      status: 200,
      headers: new Map([["content-type", "application/json"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          setTimeout(() => controller.error(new Error("upstream exploded")), 10);
        },
      }),
    };
    try {
      await pipeResponse(upstream, response, new Set());
    } catch (error) {
      pipeError = error;
      endStreamedResponse(response);
    }
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(pipeError.message, "upstream exploded");
  assert.equal(result.aborted, false);
  assert.equal(result.complete, true);
  assert.equal(result.body, '{"partial":');
});

// A response that already ended, or whose client is gone, must not be written
// to again.
test("endStreamedResponse is a no-op on a finished or destroyed response", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/event-stream");
    response.end("data: done\n\n");
    endStreamedResponse(response);
    response.destroy();
    endStreamedResponse(response);
  });

  const port = await listen(server);
  const result = await readRaw(port);
  await close(server);

  assert.equal(result.body, "data: done\n\n");
});
