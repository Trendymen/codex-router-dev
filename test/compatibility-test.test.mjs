import assert from "node:assert/strict";
import test from "node:test";

const priorBaseUrl = process.env.CODEX_ROUTER_BASE_URL;
process.env.CODEX_ROUTER_BASE_URL = "http://127.0.0.1:1/internal-proof-fixture";
const { compatibilityTest } = await import("../src/compatibility-test.mjs");

test("--quick compatibility mode performs exactly one basic quota request", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: "quick",
      output: [{ type: "message", content: [{ type: "output_text", text: "PROBE_BASIC_OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await compatibilityTest("qwen-plan/qwen3.7-max", { quick: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.stream, false);
    assert.match(calls[0].body.input, /PROBE_BASIC_OK/);
    assert.deepEqual(result.checks.map((check) => check.name), ["nonstream"]);
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (priorBaseUrl === undefined) delete process.env.CODEX_ROUTER_BASE_URL;
    else process.env.CODEX_ROUTER_BASE_URL = priorBaseUrl;
  }
});
