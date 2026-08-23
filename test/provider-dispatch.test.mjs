import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "provider-dispatch-test-"));
const priorStateDir = process.env.MODEL_ROUTER_STATE_DIR;
const priorCooldowns = process.env.MODEL_ROUTER_PROVIDER_COOLDOWNS;
process.env.MODEL_ROUTER_STATE_DIR = path.join(scratch, "state");
process.env.MODEL_ROUTER_PROVIDER_COOLDOWNS = path.join(scratch, "provider-cooldowns.json");
const { buildRoutedRequest, dispatchRoutedRequest, dispatchProtocolProbe, rankRoutedCandidates, readDispatchBody, parseRetryAfter } = await import("../src/provider-dispatch.mjs");
const { clearAllProviderCooldowns } = await import("../src/model-failover.mjs");
clearAllProviderCooldowns();
after(() => {
  if (priorStateDir === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
  else process.env.MODEL_ROUTER_STATE_DIR = priorStateDir;
  if (priorCooldowns === undefined) delete process.env.MODEL_ROUTER_PROVIDER_COOLDOWNS;
  else process.env.MODEL_ROUTER_PROVIDER_COOLDOWNS = priorCooldowns;
  rmSync(scratch, { recursive: true, force: true });
});

const model = {
  slug: "fixture/openai",
  provider: "fixture",
  upstreamModel: "fixture-model",
  baseUrl: "http://127.0.0.1:9999/v1",
  effectiveTransport: "openai-responses",
  toolDialect: "responses-functions",
  requestProfile: "router",
  reasoningDisplayMode: "raw-preserve",
  effectiveFinalReasoningShape: "raw-content",
};

test("buildRoutedRequest rebuilds every attempt from an untouched caller payload", () => {
  const pristine = {
    model: model.slug,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [],
  };
  const built = buildRoutedRequest(pristine, model, { credential: "secret" });
  assert.equal(JSON.stringify(pristine), JSON.stringify({
    model: model.slug,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [],
  }));
  assert.equal(built.url, "http://127.0.0.1:9999/v1/responses");
  assert.deepEqual(JSON.parse(built.body), {
    model: "fixture-model",
    input: pristine.input,
    tools: [],
  });
  assert.equal(built.headers.Authorization, "Bearer secret");
});

test("dispatchRoutedRequest retries only before a response is relayed", async () => {
  let calls = 0;
  const built = buildRoutedRequest({ input: "hello" }, model, { credential: "secret" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: calls === 1 ? 503 : 200 });
    },
    retries: 1,
    backoffMs: 0,
    now: (() => { let t = 0; return () => t; })(),
  });
  assert.equal(calls, 2);
  assert.equal(result.response.status, 200);
});

function sse(events) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function reasoningItem(shape) {
  const item = { type: "reasoning", id: "rs_probe" };
  if (shape === "provider-summary" || shape === "hybrid-summary") item.summary = [{ type: "summary_text", text: "raw summary" }];
  if (shape === "raw-content" || shape === "hybrid-summary") item.content = [{ type: "reasoning_text", text: "raw content" }];
  if (shape === "anthropic-thinking") item.thinking = [{ type: "thinking", thinking: "raw thinking", signature: "sig" }];
  return item;
}

function protocolFixtureFetch(shape, { failCheck } = {}) {
  const calls = [];
  let wireBytes = 0;
  const reply = (body, init) => {
    wireBytes += Buffer.byteLength(body);
    return new Response(body, init);
  };
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
    calls.push(body);
    assert.equal(body.model, model.upstreamModel, "the proof substituted the exact target slug");
    const input = JSON.stringify(body.input);
    const failed = (name) => failCheck === name
      ? reply(JSON.stringify({ error: { message: `${name} failed` } }), { status: 422, headers: { "content-type": "application/json" } })
      : undefined;
    if (input.includes("PROBE_BASIC_OK")) return failed("nonstream") || reply(JSON.stringify({ id: "basic", output: [{ type: "message", content: [{ type: "output_text", text: "PROBE_BASIC_OK" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_REASONING_RAW") && body.stream === false) return failed("stream-reasoning") || reply(JSON.stringify({ id: "reasoning-json", output: [reasoningItem(shape)], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_REASONING_STREAM")) return failed("stream-reasoning") || reply(sse([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_probe", summary: [], content: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_probe", summary_index: 0, delta: "raw" },
      { type: "response.completed", response: { id: "reasoning-stream", output: [reasoningItem(shape)], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } },
    ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    if (input.includes("PROBE_CONTINUATION_START")) return failed("continuation") || reply(JSON.stringify({ id: "cont-call", output: [{ type: "function_call", id: "fc_cont", call_id: "call_cont", name: "codex_router_probe", arguments: "{\"value\":\"ok\"}" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("function_call_output")) return failed("continuation") || reply(JSON.stringify({ id: "cont-answer", output: [{ type: "message", content: [{ type: "output_text", text: "PROBE_CONTINUATION_OK" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_AUTO_TOOL")) return failed("auto-tool") || reply(JSON.stringify({ id: "auto-call", output: [{ type: "function_call", id: "fc_auto", call_id: "call_auto", name: "codex_router_probe", arguments: "{\"value\":\"ok\"}" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_USAGE")) return failed("usage") || reply(JSON.stringify({ id: "usage", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 2 } } }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected proof request: ${input}`);
  };
  return { fetchImpl, calls, wireBytes: () => wireBytes };
}

for (const shape of ["provider-summary", "raw-content", "hybrid-summary"]) {
  test(`internal exact-slug proof derives ${shape} from raw upstream wire evidence`, async () => {
    const fixture = protocolFixtureFetch(shape);
    const evidence = await dispatchProtocolProbe(model, {
      retry: false,
      failover: false,
      confirmed: true,
      baseUrl: model.baseUrl,
      credential: "proof-secret",
      internalKey: "proof-internal-key-with-sufficient-length",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(evidence.model, model.slug);
    assert.equal(evidence.measuredFinalReasoningShape, shape);
    assert.equal(evidence.verdict, "passing");
    assert.equal(evidence.checks.length, 5);
    assert.ok(evidence.checks.every((check) => check.ok && check.observed));
    assert.equal(fixture.calls.length, 7, "five independent checks include raw nonstream+stream reasoning and a real continuation follow-up");
  });
}

function anthropicProtocolFixtureFetch() {
  const calls = [];
  const message = (content, usage = { input_tokens: 4, output_tokens: 2 }) => sse([
    { type: "message_start", message: { id: `msg_${calls.length}`, model: "glm-5.2", usage: { input_tokens: usage.input_tokens } } },
    ...content.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block },
      ...(block.type === "thinking" ? [{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }] : []),
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ]);
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
    calls.push(body);
    assert.equal(body.model, "glm-5.2");
    const input = JSON.stringify(body.messages);
    let content;
    if (input.includes("PROBE_BASIC_OK")) content = [{ type: "text", text: "PROBE_BASIC_OK" }];
    else if (input.includes("PROBE_REASONING_RAW") || input.includes("PROBE_REASONING_STREAM")) content = [{ type: "thinking", thinking: "raw anthropic thinking", signature: "sig" }, { type: "text", text: "ok" }];
    else if (input.includes("PROBE_CONTINUATION_START")) content = [{ type: "tool_use", id: "call_cont", name: "codex_router_probe", input: { value: "ok" } }];
    else if (input.includes("tool_result") && input.includes("PROBE_CONTINUATION_OK")) content = [{ type: "text", text: "PROBE_CONTINUATION_OK" }];
    else if (input.includes("PROBE_AUTO_TOOL")) content = [{ type: "tool_use", id: "call_auto", name: "codex_router_probe", input: { value: "ok" } }];
    else if (input.includes("PROBE_USAGE")) content = [{ type: "text", text: "ok" }];
    else throw new Error(`unexpected Anthropic proof request: ${input}`);
    return new Response(message(content), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { calls, fetchImpl };
}

test("internal exact-slug proof derives anthropic-thinking from raw Messages wire evidence", async () => {
  const anthropicModel = {
    ...model,
    slug: "fixture/glm-messages",
    provider: "fixture",
    upstreamModel: "glm-5.2",
    effectiveTransport: "anthropic-messages",
    requestProfile: "glm-thinking",
    reasoningDisplayMode: "summary-compat",
    effectiveFinalReasoningShape: "anthropic-thinking",
  };
  const fixture = anthropicProtocolFixtureFetch();
  const evidence = await dispatchProtocolProbe(anthropicModel, {
    retry: false,
    failover: false,
    confirmed: true,
    baseUrl: model.baseUrl,
    credential: "proof-secret",
    internalKey: "proof-internal-key-with-sufficient-length",
    fetchImpl: fixture.fetchImpl,
  });
  assert.equal(evidence.verdict, "passing");
  assert.equal(evidence.measuredFinalReasoningShape, "anthropic-thinking");
  assert.equal(fixture.calls.length, 7);
  assert.ok(evidence.checks.every((check) => check.ok && Object.keys(check.observed).length > 0));
});

test("protocol proof enforces one exact total raw-byte limit across all seven requests", async () => {
  const measured = protocolFixtureFetch("raw-content");
  const baseline = await dispatchProtocolProbe(model, {
    retry: false, failover: false, confirmed: true, baseUrl: model.baseUrl,
    credential: "proof-secret", fetchImpl: measured.fetchImpl,
  });
  assert.equal(baseline.verdict, "passing");
  const exactBytes = measured.wireBytes();

  const exact = protocolFixtureFetch("raw-content");
  const exactEvidence = await dispatchProtocolProbe(model, {
    retry: false, failover: false, confirmed: true, baseUrl: model.baseUrl,
    credential: "proof-secret", fetchImpl: exact.fetchImpl, maxRawBytes: exactBytes,
  });
  assert.equal(exactEvidence.verdict, "passing");
  assert.equal(exact.wireBytes(), exactBytes);

  const plusOne = protocolFixtureFetch("raw-content");
  const rejected = await dispatchProtocolProbe(model, {
    retry: false, failover: false, confirmed: true, baseUrl: model.baseUrl,
    credential: "proof-secret", fetchImpl: plusOne.fetchImpl, maxRawBytes: exactBytes - 1,
  });
  assert.equal(rejected.verdict, "failed");
  assert.match(JSON.stringify(rejected), /protocol_probe_resource_limit/);
  assert.doesNotMatch(JSON.stringify(rejected), /proof-secret/);
});

test("protocol proof bounds total incremental reader work independently of bytes", async () => {
  let pulls = 0;
  const bytes = Buffer.from(JSON.stringify({ id: "basic", output: [{ type: "message", content: [{ type: "output_text", text: "PROBE_BASIC_OK" }] }] }));
  const evidence = await dispatchProtocolProbe(model, {
    retry: false, failover: false, confirmed: true, baseUrl: model.baseUrl,
    credential: "proof-secret", maxRawBytes: 1024, maxWork: 4,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.subarray(pulls - 1, pulls));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(evidence.verdict, "failed");
  assert.match(JSON.stringify(evidence), /protocol_probe_resource_limit/);
  assert.ok(pulls <= 5, `reader continued after work exhaustion: ${pulls}`);
});

test("protocol proof shared deadline aborts a stalled fetch with safe evidence", { timeout: 1_000 }, async () => {
  let aborts = 0;
  const evidence = await Promise.race([
    dispatchProtocolProbe(model, {
      retry: false, failover: false, confirmed: true, baseUrl: model.baseUrl,
      credential: "FETCH_SECRET_MUST_NOT_LEAK", timeoutMs: 20,
      fetchImpl: async (_url, init) => new Promise((resolve) => {
        init.signal.addEventListener("abort", () => { aborts += 1; resolve(new Response("late")); }, { once: true });
      }),
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("proof fetch deadline was not shared")), 500)),
  ]);
  assert.equal(evidence.verdict, "failed");
  assert.equal(aborts, 1);
  assert.match(JSON.stringify(evidence), /protocol_probe_timeout/);
  assert.doesNotMatch(JSON.stringify(evidence), /FETCH_SECRET_MUST_NOT_LEAK|late/);
});

test("protocol proof shared deadline cancels a stalled raw body exactly once", { timeout: 1_000 }, async () => {
  let cancels = 0;
  let aborts = 0;
  const evidence = await Promise.race([
    dispatchProtocolProbe(model, {
      retry: false, failover: false, confirmed: true, baseUrl: model.baseUrl,
      credential: "BODY_SECRET_MUST_NOT_LEAK", timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        init.signal.addEventListener("abort", () => { aborts += 1; }, { once: true });
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(Buffer.from("{\"secret\":\"BODY_SECRET_MUST_NOT_LEAK\"")); },
          cancel() { cancels += 1; },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("proof body deadline was not shared")), 500)),
  ]);
  assert.equal(evidence.verdict, "failed");
  assert.equal(aborts, 1);
  assert.equal(cancels, 1);
  assert.match(JSON.stringify(evidence), /protocol_probe_timeout/);
  assert.doesNotMatch(JSON.stringify(evidence), /BODY_SECRET_MUST_NOT_LEAK/);
});

test("raw Anthropic proof survives a later shared-deadline body stall without adapter leaks", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, [path.join(process.cwd(), "test", "fixtures", "protocol-proof-anthropic-abort-child.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: path.join(scratch, "raw-anthropic-child-state"),
      CODEX_HOME: path.join(scratch, "raw-anthropic-child-codex-home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const result = JSON.parse(stdout.trim());
  assert.deepEqual(result, {
    survived: true,
    verdict: "failed",
    cancels: 1,
    fetches: 2,
    errorCode: "protocol_probe_timeout",
  });
  assert.doesNotMatch(stderr, /Unhandled|uncaught|AnthropicMessagesAdapterError|request_aborted/i);
});

for (const failed of ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"]) {
  test(`internal proof reports ${failed} failure without substituting another target`, async () => {
    const fixture = protocolFixtureFetch("raw-content", { failCheck: failed });
    const evidence = await dispatchProtocolProbe(model, {
      retry: false,
      failover: false,
      confirmed: true,
      baseUrl: model.baseUrl,
      credential: "proof-secret",
      internalKey: "proof-internal-key-with-sufficient-length",
      fetchImpl: fixture.fetchImpl,
    });
    assert.equal(evidence.verdict, "failed");
    assert.equal(evidence.checks.find((check) => check.name === failed).ok, false);
    assert.ok(evidence.checks.filter((check) => check.name !== failed).every((check) => check.ok));
    assert.ok(fixture.calls.every((call) => call.model === model.upstreamModel));
  });
}

test("internal proof rejects a substituted target slug before transport", async () => {
  let calls = 0;
  await assert.rejects(() => dispatchProtocolProbe(model, {
    retry: false,
    failover: false,
    confirmed: true,
    targetSlug: "fixture/substitute",
    baseUrl: model.baseUrl,
    credential: "proof-secret",
    fetchImpl: async () => { calls += 1; },
  }), { code: "protocol_probe_target_mismatch" });
  assert.equal(calls, 0);
});

test("Appendix D failover swaps only a long rate limit and keeps the pristine request", async () => {
  const fallback = { ...model, slug: "z-test-fallback/openai", provider: "z-test-fallback", upstreamModel: "fallback-model", baseUrl: "http://127.0.0.1:9998/v1" };
  let calls = [];
  assert.equal(rankRoutedCandidates([fallback], model, { input: "same request" }).length, 1);
  const built = buildRoutedRequest({ input: "same request" }, model, { credential: "primary" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(Buffer.from(init.body).toString("utf8")) });
      if (calls.length === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "61" } });
      return new Response(JSON.stringify({ id: "ok", output: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
    failoverCandidates: [fallback],
    credentialFor: () => "fallback-secret",
    baseUrlFor: (candidate) => candidate.baseUrl,
    retries: 0,
    now: (() => { let t = 0; return () => t; })(),
  });
  assert.equal(calls.length, 2);
  assert.equal(result.model.slug, fallback.slug);
  assert.deepEqual(calls[0].body.input, calls[1].body.input);
});

const APPENDIX_D_RETRY_STATUSES = [502, 503, 504, 520, 521, 522, 523, 524];
const APPENDIX_D_TRANSPORT_CODES = [
  "EADDRNOTAVAIL", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "ENOBUFS", "ENOTFOUND", "EPIPE",
  "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
];

test("direct Appendix D retries every and only retryable status with exact 250/750 delays", async () => {
  for (const status of APPENDIX_D_RETRY_STATUSES) {
    const delays = [];
    let calls = 0;
    const built = buildRoutedRequest({ input: `status-${status}` }, model, { credential: "A" });
    const result = await dispatchRoutedRequest(built, {
      fetchImpl: async () => {
        calls += 1;
        return calls <= 2
          ? new Response(`retry-${status}`, { status })
          : new Response(JSON.stringify({ id: "ok", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      sleepImpl: async (delay) => { delays.push(delay); },
      now: () => 0,
      failoverCandidates: [{ ...model, slug: "must-not-failover/status", provider: "must-not-failover" }],
      credentialFor: () => "B",
    });
    assert.equal(result.response.status, 200, `status ${status}`);
    assert.equal(calls, 3, `status ${status}`);
    assert.deepEqual(delays, [250, 750], `status ${status}`);
    assert.equal(result.hops, 0, `status ${status}`);
  }
});

test("direct Appendix D retries every closed connect/DNS/socket code and no other transport error", async () => {
  for (const code of APPENDIX_D_TRANSPORT_CODES) {
    const delays = [];
    let calls = 0;
    const built = buildRoutedRequest({ input: `transport-${code}` }, model, { credential: "A" });
    const result = await dispatchRoutedRequest(built, {
      fetchImpl: async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new TypeError("private transport detail"), { cause: { code } });
        return new Response(JSON.stringify({ id: "ok", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      sleepImpl: async (delay) => { delays.push(delay); },
      now: () => 0,
    });
    assert.equal(result.response.status, 200, code);
    assert.equal(calls, 3, code);
    assert.deepEqual(delays, [250, 750], code);
  }

  for (const failure of [
    Object.assign(new Error("permission"), { code: "EACCES" }),
    Object.assign(new Error("unknown"), { cause: { code: "PRIVATE_UNKNOWN_CODE" } }),
    Object.assign(new Error("router-side"), { code: "ECONNRESET", status: 422 }),
  ]) {
    let calls = 0;
    const built = buildRoutedRequest({ input: "forbidden-transport" }, model, { credential: "A" });
    await assert.rejects(() => dispatchRoutedRequest(built, {
      fetchImpl: async () => { calls += 1; throw failure; },
      sleepImpl: async () => assert.fail("forbidden transport error slept"),
    }), (error) => error === failure);
    assert.equal(calls, 1);
  }
});

test("direct Appendix D exhaustively returns all forbidden HTTP statuses without retry or failover", async () => {
  const forbidden = [];
  for (let status = 400; status <= 599; status += 1) {
    if (status === 402 || APPENDIX_D_RETRY_STATUSES.includes(status)) continue;
    forbidden.push(status);
  }
  for (const status of forbidden) {
    let calls = 0;
    const built = buildRoutedRequest({ input: `forbidden-${status}` }, model, { credential: "A" });
    const result = await dispatchRoutedRequest(built, {
      fetchImpl: async () => {
        calls += 1;
        return new Response("ordinary provider failure", {
          status,
          ...(status === 429 ? { headers: { "retry-after": "60" } } : {}),
        });
      },
      sleepImpl: async () => assert.fail(`forbidden status ${status} slept`),
      failoverCandidates: [{ ...model, slug: `forbidden-candidate/${status}`, provider: `forbidden-candidate-${status}` }],
      credentialFor: () => "B",
    });
    assert.equal(calls, 1, `status ${status}`);
    assert.equal(result.response.status, status, `status ${status}`);
    assert.equal(result.hops, 0, `status ${status}`);
  }

  for (const retryAfter of [undefined, "", "invalid", "0", "30", "60"] ) {
    let calls = 0;
    const built = buildRoutedRequest({ input: "short-429" }, model, { credential: "A" });
    const result = await dispatchRoutedRequest(built, {
      fetchImpl: async () => {
        calls += 1;
        return new Response("short rate limit", { status: 429, ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }) });
      },
      sleepImpl: async () => assert.fail("short 429 slept"),
      failoverCandidates: [{ ...model, slug: "short-429/candidate", provider: "short-429-candidate" }],
      credentialFor: () => "B",
    });
    assert.equal(calls, 1, `Retry-After ${retryAfter}`);
    assert.equal(result.response.status, 429);
    assert.equal(result.hops, 0);
  }
});

test("direct Appendix D five-second retry budget is exact and abort-aware", async () => {
  for (const [elapsed, wantCalls, wantDelays] of [[4_999, 3, [250, 750]], [5_000, 1, []]]) {
    let calls = 0;
    let clockReads = 0;
    const delays = [];
    const built = buildRoutedRequest({ input: `budget-${elapsed}` }, model, { credential: "A" });
    const result = await dispatchRoutedRequest(built, {
      fetchImpl: async () => { calls += 1; return new Response("edge", { status: 503 }); },
      sleepImpl: async (delay) => { delays.push(delay); },
      now: () => clockReads++ < 2 ? 0 : elapsed,
      failoverCandidates: [],
    });
    assert.equal(calls, wantCalls, `elapsed ${elapsed}`);
    assert.deepEqual(delays, wantDelays, `elapsed ${elapsed}`);
    assert.equal(result.response.status, 503);
  }

  const controller = new AbortController();
  let calls = 0;
  const reason = new DOMException("caller left", "AbortError");
  const built = buildRoutedRequest({ input: "abort-aware-retry" }, model, { credential: "A" });
  await assert.rejects(() => dispatchRoutedRequest(built, {
    signal: controller.signal,
    fetchImpl: async () => { calls += 1; return new Response("edge", { status: 503 }); },
    sleepImpl: async () => { controller.abort(reason); },
    now: () => 0,
  }), (error) => error === reason);
  assert.equal(calls, 1);
});

test("direct Appendix D failover-only rows never retry and restore the original error", async () => {
  const cases = [
    { name: "long-429", status: 429, body: "rate limited", headers: { "retry-after": "61" } },
    { name: "402", status: 402, body: "payment required" },
    { name: "classified-out-of-usage", status: 400, body: JSON.stringify({ error: { type: "insufficient_quota", message: "quota exhausted" } }) },
  ];
  for (const fixture of cases) {
    const candidate = { ...model, slug: `${fixture.name}/candidate`, provider: `${fixture.name}-candidate`, upstreamModel: "candidate-model", baseUrl: "http://127.0.0.1:9998/v1" };
    const calls = [];
    const built = buildRoutedRequest({ input: fixture.name }, model, { credential: "A" });
    const result = await dispatchRoutedRequest(built, {
      fetchImpl: async (url) => {
        calls.push(url);
        if (calls.length === 1) return new Response(fixture.body, { status: fixture.status, headers: fixture.headers });
        return new Response("candidate forbidden", { status: 401 });
      },
      sleepImpl: async () => assert.fail(`${fixture.name} retried`),
      failoverCandidates: [candidate], credentialFor: () => "B", baseUrlFor: (entry) => entry.baseUrl,
    });
    assert.equal(calls.length, 2, fixture.name);
    assert.equal(result.hops, 1, fixture.name);
    assert.equal(result.response.status, fixture.status, fixture.name);
    assert.equal(await result.response.text(), fixture.body, fixture.name);
  }
});

test("direct Appendix D starts the 30-second failover budget after the qualifying primary failure", async () => {
  const candidate = { ...model, slug: "candidate-only-budget/model", provider: "candidate-only-budget", upstreamModel: "candidate", baseUrl: "http://127.0.0.1:9998/v1" };
  let now = 0;
  let calls = 0;
  const built = buildRoutedRequest({ input: "slow primary" }, model, { credential: "A" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        now = 30_000;
        return new Response("primary spent thirty seconds", { status: 402 });
      }
      return new Response(JSON.stringify({ id: "candidate", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
    retries: 0,
    now: () => now,
    failoverBudgetMs: 30_000,
    failoverCandidates: [candidate],
    credentialFor: () => "B",
    baseUrlFor: (entry) => entry.baseUrl,
  });
  assert.equal(calls, 2);
  assert.equal(result.model.slug, candidate.slug);
});

test("direct Appendix D enforces two hops, one 30-second candidate budget, six-hour cooldown, and original error", async () => {
  clearAllProviderCooldowns();
  const candidates = [1, 2, 3].map((index) => ({
    ...model,
    slug: `budget-candidate-${index}/model`,
    provider: `budget-candidate-${index}`,
    upstreamModel: `candidate-${index}`,
    baseUrl: `http://127.0.0.1:${9990 + index}/v1`,
  }));
  let elapsed = 1_000;
  const calls = [];
  const built = buildRoutedRequest({ input: "bounded failover" }, model, { credential: "A" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 2) elapsed = 31_000;
      return new Response(calls.length === 1 ? "ORIGINAL_SAFE_ERROR" : `candidate-${calls.length}`, { status: calls.length === 1 ? 429 : 402, headers: calls.length === 1 ? { "retry-after": String(7 * 60 * 60) } : undefined });
    },
    retries: 0,
    now: () => elapsed,
    failoverBudgetMs: 30_000,
    failoverCandidates: candidates,
    credentialFor: () => "candidate-secret",
    baseUrlFor: (entry) => entry.baseUrl,
  });
  assert.equal(calls.length, 2, "the shared candidate deadline admitted work after 30 seconds");
  assert.equal(result.hops, 1);
  assert.equal(result.response.status, 429);
  assert.equal(await result.response.text(), "ORIGINAL_SAFE_ERROR");
  const cooled = (await import("../src/model-failover.mjs")).providerCooldown(model.provider, { now: 1_000 });
  assert.equal(cooled.until, new Date(1_000 + 6 * 60 * 60 * 1_000).toISOString());
  clearAllProviderCooldowns();

  let hopCalls = 0;
  const hopBuilt = buildRoutedRequest({ input: "two hops" }, model, { credential: "A" });
  const hopResult = await dispatchRoutedRequest(hopBuilt, {
    fetchImpl: async () => { hopCalls += 1; return new Response(hopCalls === 1 ? "FIRST_ERROR" : `hop-${hopCalls}`, { status: 402 }); },
    retries: 0, now: () => 0, failoverCandidates: candidates,
    credentialFor: () => "candidate-secret", baseUrlFor: (entry) => entry.baseUrl,
  });
  assert.equal(hopCalls, 3);
  assert.equal(hopResult.hops, 2);
  assert.equal(await hopResult.response.text(), "FIRST_ERROR");
});

test("direct Appendix D excludes every incompatible candidate before a second request", async () => {
  clearAllProviderCooldowns();
  const base = { ...model, slug: "eligible/model", provider: "eligible", baseUrl: "http://127.0.0.1:9998/v1", priority: 1, routable: true, listed: true, visible: true, contextWindow: 1_000_000, inputModalities: ["text", "image"], multiAgentVersion: "v2" };
  const rows = [
    ["same slug", { ...base, slug: model.slug }],
    ["same family", { ...base, provider: model.provider }],
    ["native", { ...base, effectiveTransport: "native-openai" }],
    ["transport", { ...base, effectiveTransport: "anthropic-messages" }],
    ["dialect", { ...base, toolDialect: "responses-native" }],
    ["context", { ...base, contextWindow: 1 }],
    ["hidden", { ...base, visible: false }],
    ["unlisted", { ...base, listed: false }],
    ["unroutable", { ...base, routable: false }],
    ["unproved canary", { ...base, rolloutState: "experimental" }],
    ["image", { ...base, inputModalities: ["text"], visionBridge: false }],
    ["collaboration v2", { ...base, multiAgentVersion: "v1" }],
  ];
  for (const [name, candidate] of rows) {
    const payload = name === "context"
      ? { input: "x".repeat(20_000) }
      : name === "image"
        ? { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] }
        : name === "collaboration v2"
          ? { input: "delegate", tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", inputSchema: { type: "object" } }, { type: "function", name: "interrupt_agent", inputSchema: { type: "object" } }] }] }
          : { input: "ordinary" };
    let calls = 0;
    const built = buildRoutedRequest(payload, model, { credential: "A" });
    const result = await dispatchRoutedRequest(built, {
      fetchImpl: async () => { calls += 1; return new Response("ORIGINAL", { status: 402 }); },
      retries: 0, failoverCandidates: [candidate], credentialFor: () => "B", baseUrlFor: (entry) => entry.baseUrl,
    });
    assert.equal(calls, 1, name);
    assert.equal(result.hops, 0, name);
    assert.equal(await result.response.text(), "ORIGINAL", name);
  }

  const cooldownCandidate = { ...base, slug: "cooled/model", provider: "cooled" };
  const { recordProviderCooldown } = await import("../src/model-failover.mjs");
  recordProviderCooldown(cooldownCandidate.provider, { reason: "rate_limited", until: new Date(Date.now() + 60_000).toISOString() });
  let cooledCalls = 0;
  const cooledBuilt = buildRoutedRequest({ input: "ordinary" }, model, { credential: "A" });
  const cooledResult = await dispatchRoutedRequest(cooledBuilt, {
    fetchImpl: async () => { cooledCalls += 1; return new Response("ORIGINAL", { status: 402 }); },
    retries: 0, failoverCandidates: [cooldownCandidate], credentialFor: () => "B",
  });
  assert.equal(cooledCalls, 1);
  assert.equal(cooledResult.hops, 0);
  clearAllProviderCooldowns();
});

test("a 429 without a long Retry-After is returned without retry or failover", async () => {
  const fallback = { ...model, slug: "z-test-fallback/openai", provider: "z-test-fallback", baseUrl: "http://127.0.0.1:9998/v1" };
  let calls = 0;
  const built = buildRoutedRequest({ input: "same request" }, model, { credential: "primary" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async () => { calls += 1; return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }); },
    failoverCandidates: [fallback],
    retries: 0,
  });
  assert.equal(calls, 1);
  assert.equal(result.response.status, 429);
});

test("failover never reuses the source credential when the candidate resolver has no key", async () => {
  const fallback = { ...model, slug: "z-test-fallback/openai", provider: "z-test-fallback", baseUrl: "http://127.0.0.1:9998/v1", credential: "B_SECRET" };
  const seen = [];
  const built = buildRoutedRequest({ input: "secret A" }, model, { credential: "A_SECRET" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async (_url, init) => {
      seen.push({ authorization: new Headers(init.headers).get("authorization"), body: Buffer.from(init.body).toString("utf8") });
      return new Response("rate limited", { status: 429, headers: { "retry-after": "61" } });
    },
    failoverCandidates: [fallback],
    credentialFor: () => undefined,
    baseUrlFor: (candidate) => candidate.baseUrl,
    retries: 0,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, "Bearer A_SECRET");
  assert.doesNotMatch(seen.join("\n"), /B_SECRET/);
  assert.equal(result.model.slug, model.slug);
});

test("the shared routed ranker excludes a different family, transport, dialect, marker, and undersized context", () => {
  const base = { ...model, provider: "other", slug: "other/openai", priority: 1, routable: true, listed: true, visible: true };
  const candidates = [
    base,
    { ...base, slug: "other/anthropic", effectiveTransport: "anthropic-messages" },
    { ...base, slug: "other/dialect", toolDialect: "responses-native" },
    { ...base, slug: "other/small", contextWindow: 1 },
  ];
  assert.deepEqual(rankRoutedCandidates(candidates, model, { input: [{ type: "function_call_output", output: "x".repeat(10000) }] }).map((entry) => entry.slug), ["other/openai"]);
});

test("readDispatchBody consumes the selected adapter output for direct compaction", async () => {
  const built = buildRoutedRequest({ input: "compact" }, model, { credential: "secret" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async () => new Response(JSON.stringify({ id: "r1", output_text: "summary" }), { status: 200, headers: { "content-type": "application/json" } }),
    retries: 0,
  });
  assert.equal(JSON.parse((await readDispatchBody(result)).toString("utf8")).output_text, "summary");
});

test("all failed failover hops return the originally selected provider error", async () => {
  const fallback = { ...model, slug: "z-test-fallback/openai", provider: "z-test-fallback", baseUrl: "http://127.0.0.1:9998/v1" };
  let calls = 0;
  const built = buildRoutedRequest({ input: "same" }, model, { credential: "A" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls === 1 ? "primary" : "fallback", { status: calls === 1 ? 402 : 401 });
    },
    failoverCandidates: [fallback],
    credentialFor: () => "B",
    baseUrlFor: (candidate) => candidate.baseUrl,
    retries: 0,
  });
  assert.equal(calls, 2);
  assert.equal(result.model.slug, model.slug);
  assert.equal(result.response.status, 402);
  assert.equal(await result.response.text(), "primary");
});

test("candidate transport retry exhaustion returns the original failure while caller abort stays distinct", async () => {
  const fallback = { ...model, slug: "z-transport-fallback/openai", provider: "z-transport-fallback", baseUrl: "http://127.0.0.1:9998/v1" };
  const built = buildRoutedRequest({ input: "same" }, model, { credential: "A" });
  let calls = 0;
  const transportFailure = Object.assign(new TypeError("candidate socket failed"), { cause: { code: "ECONNRESET" } });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response("primary quota", { status: 402 });
      throw transportFailure;
    },
    failoverCandidates: [fallback],
    credentialFor: () => "B",
    baseUrlFor: (candidate) => candidate.baseUrl,
    retries: 1,
    backoffMs: 0,
  });
  assert.equal(calls, 3);
  assert.equal(result.model.slug, model.slug);
  assert.equal(result.response.status, 402);
  assert.equal(await result.response.text(), "primary quota");
  assert.deepEqual(result.failures.map((failure) => [failure.model.slug, failure.providerFamily, failure.kind]), [
    [model.slug, "fixture", "response"],
    [fallback.slug, "z-transport-fallback", "transport"],
  ]);

  const controller = new AbortController();
  calls = 0;
  const aborted = dispatchRoutedRequest(built, {
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Response("primary quota", { status: 402 });
      controller.abort(new DOMException("caller left", "AbortError"));
      throw init.signal.reason;
    },
    signal: controller.signal,
    failoverCandidates: [fallback],
    credentialFor: () => "B",
    baseUrlFor: (candidate) => candidate.baseUrl,
    retries: 0,
  });
  await assert.rejects(aborted, { name: "AbortError" });
});

test("native-openai dispatch is byte-identical and never attaches an Anthropic transform", async () => {
  const native = { ...model, slug: "openai/gpt-native", provider: "openai", effectiveTransport: "native-openai" };
  const rawBody = Buffer.from('{"model":"openai/gpt-native","input":"  exact \\u4f60  "}\n', "utf8");
  const built = buildRoutedRequest({ model: native.slug, input: "  exact 你  " }, native, {
    rawBody,
    url: "http://127.0.0.1:9996/v1/responses",
    headers: { "content-type": "application/json", authorization: "Bearer native" },
  });
  let seen;
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async (url, init) => {
      seen = { url, body: Buffer.from(init.body), headers: new Headers(init.headers) };
      return new Response(Buffer.from("native-response\n"), { status: 200, headers: { "content-type": "application/octet-stream" } });
    },
    retries: 0,
  });
  assert.equal(seen.url, "http://127.0.0.1:9996/v1/responses");
  assert.deepEqual(seen.body, rawBody);
  assert.equal(seen.headers.get("authorization"), "Bearer native");
  assert.deepEqual(result.transforms, []);
  assert.equal((await readDispatchBody(result)).toString("utf8"), "native-response\n");
});

test("structured failover eligibility ignores prompt words and requires actual image/collaboration shapes", () => {
  const candidate = { ...model, provider: "other", slug: "other/openai", priority: 1, routable: true, listed: true, visible: true, inputModalities: ["text"], visionBridge: false, multiAgentVersion: "v1" };
  const promptOnly = {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Discuss input_image, image_url, spawn_agent, wait_agent, and interrupt_agent as words." }] }],
    tools: [{ type: "function", name: "spawn_agent_documentation", parameters: { type: "object" } }],
  };
  assert.deepEqual(rankRoutedCandidates([candidate], model, promptOnly).map((entry) => entry.slug), [candidate.slug]);
  const imageInput = { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] };
  assert.deepEqual(rankRoutedCandidates([candidate], model, imageInput), []);
  const collaborationTools = {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "delegate" }] }],
    tools: [{ type: "namespace", name: "collaboration", tools: [
      { type: "function", name: "spawn_agent", inputSchema: { type: "object" } },
      { type: "function", name: "interrupt_agent", inputSchema: { type: "object" } },
    ] }],
  };
  assert.deepEqual(rankRoutedCandidates([candidate], model, collaborationTools), []);
  assert.deepEqual(rankRoutedCandidates([{ ...candidate, multiAgentVersion: "v2" }], model, collaborationTools).map((entry) => entry.slug), [candidate.slug]);
});

test("ordinary primary dispatch has no failover timer, while a timed-out candidate returns the saved original", async () => {
  const fallback = { ...model, slug: "z-timeout-fallback/openai", provider: "z-timeout-fallback", baseUrl: "http://127.0.0.1:9998/v1" };
  let calls = 0;
  const built = buildRoutedRequest({ input: "same" }, model, { credential: "A" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Response("primary", { status: 402 });
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "AbortError" })), { once: true });
      });
    },
    failoverCandidates: [fallback],
    credentialFor: () => "B",
    baseUrlFor: (candidate) => candidate.baseUrl,
    retries: 0,
    failoverBudgetMs: 10,
  });
  assert.equal(calls, 2);
  assert.equal(result.aborted, true);
  assert.equal(result.model.slug, model.slug);
  assert.equal(result.response.status, 402);
});

test("failover accumulates canonical provider families across hops", async () => {
  const b = { ...model, slug: "z-family-b/model", provider: "z-family-b", baseUrl: "http://127.0.0.1:9998/v1" };
  const a2 = { ...model, slug: "z-family-a/variant", provider: "fixture", baseUrl: "http://127.0.0.1:9997/v1" };
  let calls = 0;
  const built = buildRoutedRequest({ input: "same" }, model, { credential: "A" });
  const result = await dispatchRoutedRequest(built, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(`fail-${calls}`, { status: 402 });
    },
    failoverCandidates: [b, a2],
    credentialFor: () => "independent",
    baseUrlFor: (candidate) => candidate.baseUrl,
    retries: 0,
  });
  assert.equal(calls, 2);
  assert.equal(result.response.status, 402);
  assert.equal(result.model.slug, model.slug);
});

test("Retry-After accepts positive integer and future-date forms without imposing cooldown storage cap", () => {
  assert.equal(parseRetryAfter("61"), 61);
  assert.ok(parseRetryAfter(new Date(Date.now() + 61_000).toUTCString()) >= 60);
  assert.equal(parseRetryAfter("0"), undefined);
  assert.equal(parseRetryAfter("not-a-retry"), undefined);
});
