import assert from "node:assert/strict";
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
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
    calls.push(body);
    assert.equal(body.model, model.upstreamModel, "the proof substituted the exact target slug");
    const input = JSON.stringify(body.input);
    const failed = (name) => failCheck === name
      ? new Response(JSON.stringify({ error: { message: `${name} failed` } }), { status: 422, headers: { "content-type": "application/json" } })
      : undefined;
    if (input.includes("PROBE_BASIC_OK")) return failed("nonstream") || new Response(JSON.stringify({ id: "basic", output: [{ type: "message", content: [{ type: "output_text", text: "PROBE_BASIC_OK" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_REASONING_RAW") && body.stream === false) return failed("stream-reasoning") || new Response(JSON.stringify({ id: "reasoning-json", output: [reasoningItem(shape)], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_REASONING_STREAM")) return failed("stream-reasoning") || new Response(sse([
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_probe", summary: [], content: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_probe", summary_index: 0, delta: "raw" },
      { type: "response.completed", response: { id: "reasoning-stream", output: [reasoningItem(shape)], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } },
    ]), { status: 200, headers: { "content-type": "text/event-stream" } });
    if (input.includes("PROBE_CONTINUATION_START")) return failed("continuation") || new Response(JSON.stringify({ id: "cont-call", output: [{ type: "function_call", id: "fc_cont", call_id: "call_cont", name: "codex_router_probe", arguments: "{\"value\":\"ok\"}" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("function_call_output")) return failed("continuation") || new Response(JSON.stringify({ id: "cont-answer", output: [{ type: "message", content: [{ type: "output_text", text: "PROBE_CONTINUATION_OK" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_AUTO_TOOL")) return failed("auto-tool") || new Response(JSON.stringify({ id: "auto-call", output: [{ type: "function_call", id: "fc_auto", call_id: "call_auto", name: "codex_router_probe", arguments: "{\"value\":\"ok\"}" }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (input.includes("PROBE_USAGE")) return failed("usage") || new Response(JSON.stringify({ id: "usage", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 2 } } }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected proof request: ${input}`);
  };
  return { fetchImpl, calls };
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
