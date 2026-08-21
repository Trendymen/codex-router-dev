import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const transactionStateDir = mkdtempSync(path.join(os.tmpdir(), "node-trigger-rollback-"));
process.env.MODEL_ROUTER_STATE_DIR = transactionStateDir;

const {
  createNativeSessionSnapshotObserver,
  rebuildAfterRegistryUpdate,
  rebuildAfterStartup,
  transactNodeMutationAndRefreshTargets,
} = await import("../src/node-snapshot-triggers.mjs");
const {
  BROWSER_MODELS_PATH,
  CATALOG_GENERATIONS_DIR,
  CONTROL_MODELS_PATH,
  MERGED_CATALOG_PATH,
  NODE_ROUTES_PATH,
  PROTOCOL_PROOFS_PATH,
  ROUTED_CATALOG_PATH,
  SWIFT_MODELS_PATH,
} = await import("../src/paths.mjs");
const { readProtocolProof } = await import("../src/protocol-proof.mjs");
const { publishCatalogGeneration } = await import("../src/catalog-generation.mjs");

after(() => rmSync(transactionStateDir, { recursive: true, force: true }));

const generationPaths = Object.freeze({
  "merged-models.json": MERGED_CATALOG_PATH,
  "routed-models.json": ROUTED_CATALOG_PATH,
  "node-routes.json": NODE_ROUTES_PATH,
  "control-models.json": CONTROL_MODELS_PATH,
  "swift-models.json": SWIFT_MODELS_PATH,
  "browser-models.json": BROWSER_MODELS_PATH,
});

function generationArtifacts(label) {
  const catalog = {
    models: [{
      slug: `router/${label}`,
      base_instructions: `instructions ${label}`,
      model_messages: { instructions_template: `template ${label}` },
      supports_parallel_tool_calls: false,
    }],
  };
  const models = { version: 1, models: [] };
  return {
    "merged-models.json": catalog,
    "routed-models.json": catalog,
    "node-routes.json": { version: 1, routes: [] },
    "control-models.json": models,
    "swift-models.json": models,
    "browser-models.json": models,
  };
}

function seedPublishedGeneration(label) {
  rmSync(CATALOG_GENERATIONS_DIR, { recursive: true, force: true });
  for (const target of Object.values(generationPaths)) rmSync(target, { force: true });
  publishCatalogGeneration({ files: generationArtifacts(label) });
  return Object.fromEntries(Object.entries(generationPaths).map(([name, target]) => [name, readFileSync(target)]));
}

function assertPublishedGeneration(snapshot) {
  for (const [name, target] of Object.entries(generationPaths)) {
    assert.deepEqual(readFileSync(target), snapshot[name], `${name} stable export changed`);
    assert.deepEqual(readFileSync(path.join(CATALOG_GENERATIONS_DIR, "current", name)), snapshot[name], `${name} current export changed`);
  }
}

test("startup rebuild waits for a base catalog instead of failing a cold service", async () => {
  const calls = [];
  const missing = await rebuildAfterStartup({
    hasBaseCatalog: () => false,
    rebuild: async (reason) => calls.push(reason),
  });
  assert.equal(missing, undefined);
  assert.deepEqual(calls, []);

  await rebuildAfterStartup({
    hasBaseCatalog: () => true,
    rebuild: async (reason) => calls.push(reason),
  });
  assert.deepEqual(calls, ["service-startup"]);
});

test("startup forwards its real rebuild seam and leaves external refresh outside a failed publish", async () => {
  const calls = [];
  const oldGeneration = seedPublishedGeneration("startup-failure-old");
  await assert.rejects(
    rebuildAfterStartup({
      hasBaseCatalog: () => true,
      buildFiles: async ({ reason }) => {
        calls.push(["build", reason]);
        throw new Error("injected startup generation failure");
      },
    }),
    /injected startup generation failure/,
  );
  assert.deepEqual(calls, [["build", "service-startup"]]);
  assertPublishedGeneration(oldGeneration);
});

test("registry completion invalidates stale proofs before one unified rebuild", async () => {
  const calls = [];
  await rebuildAfterRegistryUpdate({
    models: [{ slug: "a" }, { slug: "b" }],
    invalidate: async (models) => calls.push(["invalidate", models.map((model) => model.slug)]),
    rebuild: async (reason) => calls.push(["rebuild", reason]),
  });
  assert.deepEqual(calls, [
    ["invalidate", ["a", "b"]],
    ["rebuild", "registry-update"],
  ]);
});

test("registry completion composes proof invalidation with the same failed generation transaction", async () => {
  const oldGeneration = seedPublishedGeneration("registry-failure-old");
  const stale = {
    slug: "registry/stale",
    provider: "old-provider",
    upstreamModel: "old-model",
    transport: "openai-responses",
    toolDialect: "responses-functions",
    requestProfile: "old-profile",
    verdict: "passing",
    fingerprint: "old-fingerprint",
    verifierVersion: 1,
    measuredFinalReasoningShape: "raw-content",
    verifiedAt: "2026-08-22T00:00:00.000Z",
  };
  writeFileSync(PROTOCOL_PROOFS_PATH, JSON.stringify({
    version: 1, revision: 1, revisions: { [stale.slug]: 1 }, proofs: { [stale.slug]: stale },
  }));
  await assert.rejects(
    rebuildAfterRegistryUpdate({
      models: [{ ...stale, effectiveTransport: stale.transport }],
      buildFiles: async () => {
        assert.equal(readProtocolProof(stale.slug), null, "invalidation must be visible inside the generation transaction");
        throw new Error("injected registry generation failure");
      },
    }),
    /injected registry generation failure/,
  );
  assert.deepEqual(readProtocolProof(stale.slug), stale);
  assertPublishedGeneration(oldGeneration);
});

test("native-session observer refreshes targets only after a successful retry", async () => {
  const calls = [];
  let attempts = 0;
  const observer = createNativeSessionSnapshotObserver({
    rebuild: async () => {
      attempts += 1;
      calls.push(`build:${attempts}`);
      if (attempts === 1) throw new Error("injected native generation failure");
    },
    refreshTargets: async () => calls.push(`refresh:${attempts}`),
  });
  await observer.observe({ usable: false });
  await assert.rejects(observer.observe({ usable: true }), /injected native generation failure/);
  assert.deepEqual(calls, ["build:1"]);
  await observer.observe({ usable: true });
  assert.deepEqual(calls, ["build:1", "build:2", "refresh:2"]);
});

test("target picker refresh runs only after the router state and generation commit", async () => {
  const calls = [];
  const committed = await transactNodeMutationAndRefreshTargets({
    transaction: async (input) => {
      calls.push("transaction");
      await input.mutate();
      return { generation: "next" };
    },
    files: ["router-state"],
    reason: "credential:set:deepseek",
    mutate: () => calls.push("mutate"),
    refreshTargets: () => calls.push("refresh"),
  });
  assert.deepEqual(committed, { generation: "next" });
  assert.deepEqual(calls, ["transaction", "mutate", "refresh"]);

  calls.length = 0;
  await assert.rejects(
    transactNodeMutationAndRefreshTargets({
      transaction: async (input) => {
        calls.push("transaction");
        await input.mutate();
        throw new Error("generation failed");
      },
      files: ["router-state"],
      reason: "credential:set:deepseek",
      mutate: () => calls.push("mutate"),
      refreshTargets: () => calls.push("refresh"),
    }),
    /generation failed/,
  );
  assert.deepEqual(calls, ["transaction", "mutate"]);
});

test("initial credential state keeps rollback protection and defers publication until a base catalog exists", async () => {
  let received;
  await transactNodeMutationAndRefreshTargets({
    files: ["credential"],
    reason: "credential:set:deepseek",
    hasBaseCatalog: () => false,
    transaction: async (input) => {
      received = input;
      await input.mutate();
      return input.rebuild(input.reason);
    },
    mutate: () => undefined,
  });
  assert.deepEqual(await received.rebuild("credential:set:deepseek"), {
    reason: "credential:set:deepseek",
    deferred: true,
  });
});

test("native session observer rebuilds only on usable transitions and coalesces concurrent changes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const observer = createNativeSessionSnapshotObserver({
    rebuild: async (reason) => {
      calls.push(reason);
      if (calls.length === 1) await gate;
    },
  });

  await observer.observe({ usable: false });
  const first = observer.observe({ usable: true });
  const second = observer.observe({ usable: false });
  const third = observer.observe({ usable: true });
  release();
  await Promise.all([first, second, third]);

  assert.deepEqual(calls, ["native-session-usability", "native-session-usability"]);
  assert.deepEqual(observer.snapshot(), { usable: true, desiredUsable: true });
});

test("native-session publication failure leaves the same usable state retryable", async () => {
  let attempts = 0;
  const observer = createNativeSessionSnapshotObserver({
    rebuild: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected rebuild failure");
    },
  });
  await observer.observe({ usable: false });
  await assert.rejects(observer.observe({ usable: true }), /injected rebuild failure/);
  assert.deepEqual(observer.snapshot(), { usable: false, desiredUsable: true });
  await observer.observe({ usable: true });
  assert.equal(attempts, 2);
  assert.deepEqual(observer.snapshot(), { usable: true, desiredUsable: true });
});

test("native-session observer retries a failed external refresh without publishing its state early", async () => {
  const calls = [];
  let refreshAttempts = 0;
  const observer = createNativeSessionSnapshotObserver({
    rebuild: async () => calls.push("rebuild"),
    refreshTargets: async () => {
      refreshAttempts += 1;
      calls.push(`refresh:${refreshAttempts}`);
      if (refreshAttempts === 1) throw new Error("injected refresh failure carrying secret-like text");
    },
  });

  await observer.observe({ usable: false });
  await assert.rejects(observer.observe({ usable: true }), /injected refresh failure/);
  assert.deepEqual(calls, ["rebuild", "refresh:1"]);
  assert.deepEqual(observer.snapshot(), { usable: false, desiredUsable: true });
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /secret|error|failure/i);

  await observer.observe({ usable: true });
  assert.deepEqual(calls, ["rebuild", "refresh:1", "refresh:2"]);
  assert.deepEqual(observer.snapshot(), { usable: true, desiredUsable: true });
});

for (const reason of [
  "credential:set:deepseek",
  "provider-selection:enable:deepseek",
  "model-visibility:deepseek/deepseek-v4-flash:hide",
  "canary:deepseek/deepseek-v4-flash:on",
  "native-session-usability",
  "service-startup",
  "registry-update",
]) {
  test(`${reason} generation failure restores Router state before any external refresh`, async () => {
    const state = path.join(transactionStateDir, `${reason.replaceAll(/[^a-z0-9]/gi, "-")}.json`);
    writeFileSync(state, "old\n");
    const refreshes = [];
    await assert.rejects(
      transactNodeMutationAndRefreshTargets({
        files: [state],
        reason,
        mutate: () => writeFileSync(state, "new\n"),
        buildFiles: async () => { throw new Error(`injected ${reason} generation failure`); },
        refreshTargets: () => refreshes.push(reason),
      }),
      /injected .* generation failure/,
    );
    assert.equal(readFileSync(state, "utf8"), "old\n");
    assert.deepEqual(refreshes, []);
  });
}
