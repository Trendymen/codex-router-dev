import assert from "node:assert/strict";
import { test } from "node:test";

const {
  createNativeSessionSnapshotObserver,
  rebuildAfterRegistryUpdate,
  rebuildAfterStartup,
  transactNodeMutationAndRefreshTargets,
} = await import("../src/node-snapshot-triggers.mjs");

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
