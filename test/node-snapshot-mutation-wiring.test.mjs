import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "node-snapshot-wiring-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  readProviderSelection,
  writeProviderSelectionAndRebuild,
} = await import("../src/provider-selection.mjs");
const {
  removeApiCredentialAndRebuild,
  saveApiCredentialAndRebuild,
} = await import("../src/provider-onboarding.mjs");
const {
  readHiddenModels,
  setModelVisibleAndRebuild,
} = await import("../src/model-picker-state.mjs");

after(() => rmSync(stateDir, { recursive: true, force: true }));

function transactionRecorder(calls) {
  return async ({ files, reason, mutate }) => {
    calls.push({ files: [...files], reason });
    await mutate();
    return { generation: calls.length };
  };
}

test("provider selection commits its protected state before refreshing installed targets", async () => {
  const calls = [];
  await writeProviderSelectionAndRebuild(["deepseek"], {
    transaction: transactionRecorder(calls),
    refreshTargets: () => calls.push("refresh"),
  });
  assert.deepEqual(readProviderSelection(), ["deepseek"]);
  assert.equal(calls[0].reason, "provider-selection");
  assert.deepEqual(calls.slice(1), ["refresh"]);
});

test("credential set and remove include secret plus selection in the same Router transaction", async () => {
  const calls = [];
  await saveApiCredentialAndRebuild("deepseek", "test-only-key", {
    transaction: transactionRecorder(calls),
    refreshTargets: () => calls.push("refresh:set"),
  });
  assert.equal(calls[0].reason, "credential:set:deepseek");
  assert.ok(calls[0].files.length >= 2, "all managed credential aliases and selection are protected");
  assert.equal(existsSync(calls[0].files[0]), true);

  await removeApiCredentialAndRebuild("deepseek", {
    transaction: transactionRecorder(calls),
    refreshTargets: () => calls.push("refresh:remove"),
  });
  assert.equal(calls[2].reason, "credential:remove:deepseek");
  assert.deepEqual(readProviderSelection(), []);
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["refresh:set", "refresh:remove"]);
});

test("visibility commits the picker state and unified generation before target refresh", async () => {
  const calls = [];
  await setModelVisibleAndRebuild("deepseek/deepseek-v4-flash", false, {
    transaction: transactionRecorder(calls),
    refreshTargets: () => calls.push("refresh"),
  });
  assert.deepEqual([...readHiddenModels()], ["deepseek/deepseek-v4-flash"]);
  assert.equal(calls[0].reason, "model-visibility:deepseek/deepseek-v4-flash:hide");
  assert.deepEqual(calls.slice(1), ["refresh"]);
});
