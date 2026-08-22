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
const { buildRoutedRequest, dispatchRoutedRequest, dispatchProtocolProbe, protocolProbeArgv, rankRoutedCandidates, readDispatchBody, parseRetryAfter } = await import("../src/provider-dispatch.mjs");
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

test("protocol probes use the exact live compatibility argv and require a real verdict", async () => {
  const candidate = { slug: "fixture/openai" };
  const expectedArgv = [process.execPath, (await import("node:path")).resolve("src/compatibility-test.mjs"), candidate.slug, "--live", "--yes", "--json"];
  assert.deepEqual(protocolProbeArgv(candidate), expectedArgv);
  let invocation;
  const evidence = await dispatchProtocolProbe(candidate, { retry: false, failover: false, confirmed: true }, {
    runProbe: async (request) => {
      invocation = request;
      return { model: candidate.slug, verdict: "passing", measuredFinalReasoningShape: "raw-content", checks: ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"].map((name) => ({ name, ok: true })) };
    },
  });
  assert.deepEqual(invocation.argv, protocolProbeArgv(candidate));
  assert.equal(evidence.verdict, "passing");
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
