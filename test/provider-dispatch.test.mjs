import assert from "node:assert/strict";
import test from "node:test";

const { buildRoutedRequest, dispatchRoutedRequest, dispatchProtocolProbe, protocolProbeArgv } = await import("../src/provider-dispatch.mjs");

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

test("protocol probes use the exact live compatibility argv and require a real verdict", async () => {
  const candidate = { slug: "fixture/openai" };
  assert.deepEqual(protocolProbeArgv(candidate), ["src/compatibility-test.mjs", candidate.slug, "--live", "--yes", "--json"]);
  let invocation;
  const evidence = await dispatchProtocolProbe(candidate, { retry: false, failover: false }, {
    runProbe: async (request) => {
      invocation = request;
      return { model: candidate.slug, results: [{ ok: true }] };
    },
  });
  assert.deepEqual(invocation.argv, protocolProbeArgv(candidate));
  assert.deepEqual(evidence.results, [{ ok: true }]);
});

test("Appendix D failover swaps only a long rate limit and keeps the pristine request", async () => {
  const fallback = { ...model, slug: "fallback/openai", provider: "fallback", upstreamModel: "fallback-model", baseUrl: "http://127.0.0.1:9998/v1" };
  let calls = [];
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
  const fallback = { ...model, slug: "fallback/openai", provider: "fallback", baseUrl: "http://127.0.0.1:9998/v1" };
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
