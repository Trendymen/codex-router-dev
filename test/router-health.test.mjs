import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { waitForRouterHealth } from "../src/router-health.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("router health waits through a transient startup failure", async () => {
  let requests = 0;
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 100,
    intervalMs: 1,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) throw new Error("connection refused");
      return new Response(JSON.stringify({ service: "codex-router", version: "test" }), {
        status: 200,
      });
    },
  });

  assert.equal(requests, 2);
  assert.equal(health.ok, true);
  assert.equal(health.payload.version, "test");
});

test("router health ignores a retired gateway-only degradation", async () => {
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          service: "codex-router",
          version: "test",
          degraded: ["gateway"],
          gateway: { reachable: false },
        }),
        { status: 503 },
      ),
  });

  assert.equal(health.ok, true);
  assert.deepEqual(health.payload.degraded, []);
  assert.equal("gateway" in health.payload, false);
});

test("router health names a current Node forwarder degradation", async () => {
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ service: "codex-router", degraded: ["api"] }),
        { status: 503 },
      ),
  });

  assert.equal(health.ok, false);
  assert.match(health.error, /reports api unreachable \(HTTP 503\)/);
  assert.deepEqual(health.degradedPayload.degraded, ["api"]);
});

test("router health does not treat unknown or empty degradation as healthy", async () => {
  for (const degraded of [[], ["unknown"], ["typo"]]) {
    const health = await waitForRouterHealth({
      target: "codex",
      timeoutMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ service: "codex-router", degraded }),
          { status: 503 },
        ),
    });
    assert.equal(health.ok, false, JSON.stringify(degraded));
    assert.match(health.error, /HTTP 503/);
  }
});

test("router health rejects a different service on the configured port", async () => {
  const health = await waitForRouterHealth({
    target: "codex",
    timeoutMs: 0,
    fetchImpl: async () => new Response(JSON.stringify({ service: "another-router" })),
  });

  assert.equal(health.ok, false);
  assert.match(health.error, /different service/);
});

test("Router health source does not probe or publish the retired gateway", () => {
  const source = readFileSync(path.join(root, "src", "router.mjs"), "utf8");
  assert.doesNotMatch(source, /const GATEWAY_HEALTH/);
  assert.doesNotMatch(source, /\["gateway",\s*gateway\]/);
  assert.doesNotMatch(source, /\bgateway,\s*$/m);
});
