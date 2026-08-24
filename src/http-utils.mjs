import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";

import { secretEqual } from "./caller-auth.mjs";
import { TARGET } from "./paths.mjs";

// Some Responses -> Chat Completions bridges emit one
// assistant message per Responses item, so a stored turn of
// `function_call`, assistant commentary `message`, `function_call_output`
// arrives here as `assistant(tool_calls)`, `assistant(text)`, `tool`.
// Strict chat-completions providers (Kimi K3 among them) reject that: a
// message carrying tool_calls must be followed immediately by its tool
// messages. Folding alone is not enough when the calling message holds
// several tool_calls whose results are split by another calling message --
// which the router's own subagent closer produces when it splices an
// interrupt_agent call into the model's wait_agent message. In that shape
// the first results answer only the leading calls; the trailing calls must
// move down next to their own results. This pass does both: fold intervening
// assistant text into the calling message, then re-seat any tool_calls whose
// results are not adjacent. Messages are only ever split or merged, never
// reordered, so the conversation's reading order is preserved.
export function foldInterveningAssistantMessages(messages) {
  if (!Array.isArray(messages)) return;
  // Pass 1: merge assistant text that sits between a calling message and its
  // results into the calling message.
  for (let index = 0; index < messages.length; index += 1) {
    const callingMessage = messages[index];
    const callIds = new Set(
      Array.isArray(callingMessage?.tool_calls)
        ? callingMessage.tool_calls.map((call) => call?.id).filter(Boolean)
        : [],
    );
    if (callingMessage?.role !== "assistant" || callIds.size === 0) continue;
    let cursor = index + 1;
    const intervening = [];
    while (
      messages[cursor]?.role === "assistant" &&
      !Array.isArray(messages[cursor]?.tool_calls)
    ) {
      intervening.push(messages[cursor]);
      cursor += 1;
    }
    if (intervening.length === 0) continue;
    const followingIds = new Set();
    while (messages[cursor]?.role === "tool") {
      if (messages[cursor]?.tool_call_id) followingIds.add(messages[cursor].tool_call_id);
      cursor += 1;
    }
    if (![...callIds].every((id) => followingIds.has(id))) continue;
    const merged = mergeAssistantRun([callingMessage, ...intervening]);
    // Unknown or conflicting metadata cannot be represented on one Chat
    // Completions message without guessing. Preserve that malformed history
    // for a named upstream rejection instead of silently discarding fields.
    if (!merged) continue;
    messages[index] = merged;
    messages.splice(index + 1, intervening.length);
  }
  // The re-seated call may now be adjacent to assistant prose that originally
  // preceded it (or to another assistant item emitted by the bridge). Strict
  // chat-completions providers reject consecutive assistant messages just as
  // they reject a tool result in the wrong place, so coalesce any assistant
  // run that contains calls before deciding which calls are orphans. This also
  // gives a later pass a single calling message when a bridge emitted one
  // Responses function_call per assistant item.
  coalesceAssistantRuns(messages);
  const duplicateCallIds = duplicateIds(messages, "call");
  const duplicateToolResultIds = duplicateIds(messages, "result");
  // Pass 2: re-seat tool_calls whose results are not immediately after their
  // message. Each contiguous run of tool messages is claimed by the nearest
  // preceding calling message; calls a run cannot answer move to a new
  // assistant message inserted directly in front of their own results.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }
    // The tool run directly after this message is only answerable by this
    // message when no other calling message sits in between. If one does,
    // the run belongs to that nearer message and every call here is an
    // orphan to be re-seated.
    const next = messages[index + 1];
    const nearerCaller =
      next?.role === "assistant" && Array.isArray(next.tool_calls) && next.tool_calls.length > 0;
    const runIds = new Set();
    if (!nearerCaller) {
      let cursor = index + 1;
      while (messages[cursor]?.role === "tool") {
        if (messages[cursor].tool_call_id) runIds.add(messages[cursor].tool_call_id);
        cursor += 1;
      }
    }
    const keep = [];
    const orphans = [];
    for (const call of message.tool_calls) {
      // A call with no usable id can never be paired with a result, so it must
      // never be treated as an orphan: `undefined === undefined` would match
      // any tool message that also lacks a tool_call_id, the call would be
      // "re-seated" in front of it, and the very next turn of the outer loop
      // would find the same unmatched call again -- splicing forever and
      // growing the array without bound. Duplicate call/result ids are just as
      // ambiguous: moving either duplicate can create two adjacent wrappers
      // that keep re-seating each other. Leave all of those calls where they
      // are rather than guessing which result belongs to which call.
      if (!call?.id || duplicateCallIds.has(call.id) || duplicateToolResultIds.has(call.id)) {
        keep.push(call);
        continue;
      }
      (runIds.has(call.id) ? keep : orphans).push(call);
    }
    if (orphans.length === 0) continue;
    // A later calling message owns the intervening results, so each orphan's
    // results live further down. Split the message: the leading calls stay,
    // the orphans move to a new message directly in front of their results.
    const reseatable = [];
    for (const orphan of orphans) {
      const resultIndex = messages.findIndex(
        (candidate, at) =>
          at > index &&
          candidate?.role === "tool" &&
          // Require a usable id on the result too, so a tool message missing
          // its tool_call_id can never be claimed by an unrelated call.
          Boolean(candidate.tool_call_id) &&
          candidate.tool_call_id === orphan.id,
      );
      if (resultIndex === -1) {
        // No result anywhere: leave the call in place. Dropping it would
        // rewrite history the provider may legitimately answer.
        keep.push(orphan);
      } else {
        reseatable.push({ orphan, resultIndex });
      }
    }
    if (reseatable.length === 0) continue;
    // Splitting a message also splits the association between its calls and
    // any provider-specific metadata. Known Chat fields stay on the leading
    // fragment, but an unknown field could be a signature or turn capability
    // that belongs to every call. Refuse that ambiguous rewrite rather than
    // moving calls away from data the router does not understand.
    if (hasUnknownAssistantMetadata(message)) continue;
    // When every call moved away, the key must go rather than hold an empty
    // array: strict providers reject `tool_calls: []` exactly as they reject a
    // call with no adjacent result, so leaving it turns one malformed payload
    // into another. Without the key the message is a plain assistant turn.
    if (keep.length) {
      message.tool_calls = keep;
    } else {
      delete message.tool_calls;
    }
    // Insert from the bottom up so earlier result indexes stay valid.
    reseatable.sort((a, b) => b.resultIndex - a.resultIndex);
    for (const { orphan, resultIndex } of reseatable) {
      messages.splice(resultIndex, 0, {
        role: "assistant",
        content: null,
        tool_calls: [orphan],
      });
    }
    // Dropping the key can leave a husk: a bridged `function_call` item
    // carries no text, so a message whose every call moved away becomes
    // `{role:"assistant",content:null}` -- no content and no calls, which
    // several strict providers reject as an empty message. It says nothing
    // the conversation needs, so remove it. The insertions above all landed
    // after `index`, so the husk is still sitting at `index`; step the cursor
    // back one so the loop does not skip whatever slides into its place.
    if (isEmptyAssistantHusk(message)) {
      messages.splice(index, 1);
      index -= 1;
    }
  }
  // Splitting a call message can put the intervening prose directly before the
  // newly inserted calling message. Run the same merge after re-seating so the
  // final payload has no adjacent assistant turns while retaining that prose.
  coalesceAssistantRuns(messages);
}

// hasUsableContent() — true when a message still carries something worth
// sending: any non-blank string, or any structured content part at all
// (an image part has no text but must not be discarded).
function hasUsableContent(message) {
  const { content } = message;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return content !== null && content !== undefined;
}

// isEmptyAssistantHusk() — true for an assistant message left with no content,
// no tool_calls, and no other field a provider might act on. The extra-key
// check keeps messages carrying `name`, `refusal`, `reasoning_content` and
// similar, so this never silently drops data it does not understand.
function isEmptyAssistantHusk(message) {
  if (message?.role !== "assistant") return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false;
  if (hasUsableContent(message)) return false;
  return Object.keys(message).every((key) => key === "role" || key === "content");
}

function hasToolCalls(message) {
  return message?.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0;
}

function hasUnknownAssistantMetadata(message) {
  const known = new Set([
    "role",
    "content",
    "tool_calls",
    "reasoning_content",
    "refusal",
    "name",
  ]);
  return Object.keys(message || {}).some((key) => !known.has(key));
}

function duplicateIds(messages, kind) {
  const counts = new Map();
  for (const message of messages) {
    if (kind === "call" && hasToolCalls(message)) {
      for (const call of message.tool_calls) {
        if (call?.id) counts.set(call.id, (counts.get(call.id) || 0) + 1);
      }
    } else if (kind === "result" && message?.role === "tool" && message.tool_call_id) {
      counts.set(message.tool_call_id, (counts.get(message.tool_call_id) || 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

// Keep the content types the bridge supplied. Kimi normally receives strings,
// but an image or another structured part still counts as content and must not
// disappear merely because a neighboring assistant item is merged.
const UNMERGEABLE_ASSISTANT_RUN = Symbol("unmergeable assistant run");

function mergeAssistantContentValues(values) {
  if (
    values.some(
      (value) =>
        value !== undefined &&
        value !== null &&
        typeof value !== "string" &&
        !Array.isArray(value),
    )
  ) {
    return UNMERGEABLE_ASSISTANT_RUN;
  }
  const present = values.filter(
    (value) => value !== undefined && value !== null && !(typeof value === "string" && value === ""),
  );
  if (present.length === 0) {
    return values.find((value) => value !== undefined);
  }
  if (present.every((value) => typeof value === "string")) return present.join("\n");
  return present.flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return [{ type: "text", text: value }];
    return [value];
  });
}

// Merge one consecutive assistant run. A pure-prose history is left alone by
// coalesceAssistantRuns(), but once a payload contains tool calls every
// adjacent assistant run is part of the strict chat-completions shape and must
// be collapsed too.
function mergeAssistantRun(run) {
  const merged = { role: "assistant" };
  for (const message of run) {
    for (const [key, value] of Object.entries(message)) {
      if (key === "role" || key === "content" || key === "tool_calls") continue;
      if (!(key in merged)) {
        merged[key] = value;
        continue;
      }
      if (isDeepStrictEqual(merged[key], value)) continue;
      if (
        (key === "reasoning_content" || key === "refusal") &&
        typeof merged[key] === "string" &&
        typeof value === "string"
      ) {
        merged[key] = [merged[key], value].filter((part) => part.trim()).join("\n");
        continue;
      }
      return null;
    }
  }
  const content = mergeAssistantContentValues(run.map((message) => message.content));
  if (content === UNMERGEABLE_ASSISTANT_RUN) return null;
  if (content !== undefined || run.some((message) => "content" in message)) {
    merged.content = content;
  }
  const toolCalls = run.flatMap((message) => (hasToolCalls(message) ? message.tool_calls : []));
  if (toolCalls.length) merged.tool_calls = toolCalls;
  return merged;
}

function coalesceAssistantRuns(messages) {
  if (!Array.isArray(messages)) return;
  if (!messages.some(hasToolCalls)) return;
  for (let index = 0; index < messages.length; ) {
    if (messages[index]?.role !== "assistant") {
      index += 1;
      continue;
    }
    const start = index;
    while (messages[index]?.role === "assistant") index += 1;
    const run = messages.slice(start, index);
    if (run.length === 1) continue;
    const merged = mergeAssistantRun(run);
    if (!merged) continue;
    messages.splice(start, run.length, merged);
    index = start + 1;
  }
}

export const MAX_BODY_BYTES = Number(
  process.env.MODEL_ROUTER_MAX_BODY_BYTES ||
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_MAX_BODY_BYTES || process.env.KIMI_PROXY_MAX_BODY_BYTES
      : undefined) ||
    64 * 1024 * 1024,
);

export const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Private forwarder/router usage-owner marker. It coordinates exactly one
  // meter row across the process boundary and must never reach callers.
  "x-codex-router-usage-owner",
]);

// Node closes an idle keep-alive connection after 5 seconds and advertises
// that as `Keep-Alive: timeout=5`. Codex's HTTP client (hyper) never reads
// that header and pools idle sockets for 90 seconds, so every gap longer than
// five seconds — a tool call, a turn boundary, roughly a third of this
// router's traffic — leaves the client holding a socket the server has
// already closed. A request written into that window is answered with a FIN
// instead of a response, which surfaces to the user as
// `stream disconnected before completion: error sending request for url`.
// The server has to be the side that outlasts the pool, so hold idle
// connections past any plausible client idle timeout instead.
export const KEEPALIVE_TIMEOUT_MS = 120_000;

// Node runs the headers timer over keep-alive idle time as well, so a
// `headersTimeout` below `keepAliveTimeout` destroys connections the server
// otherwise intends to keep. Derive it rather than letting the two drift.
export const HEADERS_TIMEOUT_MS = KEEPALIVE_TIMEOUT_MS + 5_000;

export function applyKeepAliveTimeouts(server) {
  server.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

// A `listen` that fails emits `'error'`, and with no handler Node rethrows it
// from the event loop: the log gets `node:events:487 / throw er; // Unhandled
// 'error' event` and a libuv stack, with the *label of the process that died
// nowhere in it. Every forwarder here is spawned by start.mjs with inherited
// stdio into one shared stream, so an unlabelled crash cannot even be
// attributed to a forwarder -- a real Windows CI failure (#271's gating test)
// showed only `EADDRINUSE 127.0.0.1:22624` and left which of the four had
// died an open question.
//
// `src/router.mjs` has carried its own copy of this since #171 for the same
// reason. This is that treatment, shared, so the forwarders name themselves
// and the port they wanted. The exit codes match the router's, so one line in
// the service log classifies the death for a supervisor and a human alike.
export function reportListenFailure(server, { label, host, port }) {
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(
        `[${label}] cannot listen: ${host}:${port} is already in use. Another instance or an unrelated process holds it; stop that process, then start the service again.`,
      );
      process.exit(98);
    }
    if (error?.code === "EACCES") {
      console.error(`[${label}] cannot listen: permission denied binding ${host}:${port}.`);
      process.exit(97);
    }
    console.error(
      `[${label}] server error: ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }${error?.code ? ` (${error.code})` : ""}`,
    );
    process.exit(96);
  });
  return server;
}

export async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

// The transport reports every connection-level failure as a bare
// `TypeError: fetch failed`; the code that says why (ECONNREFUSED,
// UND_ERR_CONNECT_TIMEOUT, ENOTFOUND, ...) lives on the `cause` chain, and a
// log line that stops at the top error is what left #171's repeated native
// failures unexplainable from the retained log. Walk the chain and name every
// link. Services whose failures can wrap upstream response text pass
// `messages: false` and record names and codes only, which never carry a body.
const MAX_ERROR_CHAIN_DEPTH = 8;

export function formatErrorChain(error, { messages = true } = {}) {
  const parts = [];
  let current = error;
  for (
    let depth = 0;
    current !== undefined && current !== null && depth < MAX_ERROR_CHAIN_DEPTH;
    depth += 1
  ) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const name = typeof current.name === "string" && current.name ? current.name : "Error";
    const message =
      messages && typeof current.message === "string" && current.message
        ? `: ${current.message}`
        : "";
    const code = current.code !== undefined ? ` (${current.code})` : "";
    parts.push(`${name}${message}${code}`);
    // AggregateError (a dual-stack connect failure) links its members through
    // `errors` rather than `cause`; the first member names the socket failure.
    current = current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : undefined);
  }
  return parts.length ? parts.join(" <- ") : String(error);
}

export function httpErrorStatus(error, fallback = 502) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : fallback;
}

export function copyResponseHeaders(upstream, response, denylist = HOP_BY_HOP_HEADERS) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!denylist.has(name.toLowerCase())) response.setHeader(name, value);
  }
}

function isEventStream(response) {
  return String(response.getHeader("content-type") || "")
    .toLowerCase()
    .includes("text/event-stream");
}

export async function finishResponse(response) {
  return new Promise((resolve) => {
    if (response.writableFinished || response.destroyed) {
      resolve();
      return;
    }
    response.once("finish", resolve);
    // A client that hangs up before the last chunk drains emits "close"
    // without "finish"; the request is over either way.
    response.once("close", resolve);
    if (!response.writableEnded) response.end();
  });
}

// Terminate a response whose body is already streaming.
//
// `response.destroy()` resets the socket, so an in-flight chunked body loses
// its terminating `0\r\n\r\n` and the client reports a transport failure
// ("error decoding response body") with nothing to say about the cause. Ending
// the body instead produces a well-formed, if short, HTTP message.
//
// A gracefully ended SSE stream, though, is indistinguishable from a completed
// one: the turn would simply look short and successful. So on `text/event-stream`
// we first emit a terminal `error` event, matching the event framing the router
// already writes elsewhere and the Responses API's own `error` event. A parser
// that understands it surfaces a real failure; one that does not ignores the
// unknown event and lands on the plain graceful end, which is still strictly
// better than a reset. The frame carries a fixed router-side message and never
// upstream error text, so no response body can leak through it.
//
// The frame is prefixed with a blank line because the stream is being ended at
// the point upstream died, which is very often mid-line: transforms forward
// upstream's chunk boundaries verbatim, and a single `output_text.delta` can
// carry a long span. Writing `event: error` straight onto an unterminated
// `data:` line does not produce an error event at all -- a conforming parser
// reads the field name as more of the previous event's data, so the failure
// signal turns into garbage appended to the last delta, which is exactly the
// silent corruption this function exists to avoid. Leading newlines are inert
// when the stream did end cleanly: a blank line with no buffered fields
// dispatches nothing.
export function endStreamedResponse(response) {
  if (!response || response.writableEnded || response.destroyed) return;
  writeStreamErrorEvent(response, {
    code: "local_router_stream_failed",
    message: "The local router lost the upstream response stream.",
  });
  response.end();
}

// Emit a terminal `error` event into a response whose head is already sent,
// without ending it -- the caller decides when the stream is over. Used where
// the router has committed to a 200 and then hits a failure it must state
// rather than let pass as a short, successful-looking turn. The framing and
// the leading blank line are the same as `endStreamedResponse` above, and for
// the same reasons; the message is always router-side text, never an upstream
// body.
export function writeStreamErrorEvent(response, { code, message }) {
  if (!response || response.writableEnded || response.destroyed) return false;
  if (!isEventStream(response)) return false;
  try {
    const data = { type: "error", code, message, param: null };
    response.write(`\n\nevent: error\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    // The socket may already be gone; the caller ends the response anyway.
    return false;
  }
}

export async function pipeResponse(
  upstream,
  response,
  denylist,
  transform,
  { leaveOpen = false, signal } = {},
) {
  const transforms = transform === undefined
    ? []
    : Array.isArray(transform)
      ? transform
      : [transform];
  response.statusCode = upstream.status;
  copyResponseHeaders(upstream, response, denylist);
  if (!upstream.body) {
    if (!leaveOpen) response.end();
    return;
  }
  const source = Readable.fromWeb(upstream.body);
  const abortPipeline = () => {
    source.destroy();
    for (const stage of transforms) stage?.destroy?.();
  };
  signal?.addEventListener("abort", abortPipeline, { once: true });
  try {
    // `pipeline` forwards errors and destroys every stream in the chain, which
    // `.pipe()` does not: a mid-stream upstream failure used to leave the
    // response half-written and open forever. `end: false` keeps the response
    // itself out of that teardown so the caller can end the body cleanly (see
    // `endStreamedResponse`) instead of resetting the socket.
    await pipeline(source, ...transforms, response, { end: false });
  } catch (error) {
    // A client that disconnects mid-stream destroys the response, which
    // pipeline reports as a premature close. That is not a router failure, and
    // pipeline has already torn the upstream read down, so the in-flight
    // counter releases without inventing an error.
    if (response.destroyed && !response.writableFinished) return;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortPipeline);
  }
  // `leaveOpen` lets the caller keep the response writable after the upstream
  // stream ends so an empty completion can be retried against the same
  // response; the caller is responsible for ending it (see finishResponse).
  if (!leaveOpen) await finishResponse(response);
}

export function requireInternalAuth(request, response, secret) {
  const authorized = secretEqual(
    request.headers.authorization,
    `Bearer ${secret}`,
  ) || secretEqual(request.headers["x-api-key"], secret);
  if (!authorized) {
    writeJson(response, 401, {
      error: {
        type: "authentication_error",
        message: "This internal loopback route requires the router service key.",
      },
    });
  }
  return authorized;
}
