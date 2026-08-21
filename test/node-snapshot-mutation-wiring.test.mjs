import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "node-snapshot-wiring-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  readProviderSelection,
  setProviderEnabledAndRebuild,
  writeProviderSelection,
  writeProviderSelectionAndRebuild,
} = await import("../src/provider-selection.mjs");
const {
  experimentalModelEnabled,
  setExperimentalModel,
} = await import("../src/experimental-models.mjs");
const {
  removeApiCredentialAndRebuild,
  saveApiCredential,
  saveApiCredentialAndRebuild,
} = await import("../src/provider-onboarding.mjs");
const {
  readHiddenModels,
  setModelVisibleAndRebuild,
} = await import("../src/model-picker-state.mjs");
const {
  BROWSER_MODELS_PATH,
  CATALOG_GENERATIONS_DIR,
  CONTROL_MODELS_PATH,
  EXPERIMENTAL_MODELS_PATH,
  MERGED_CATALOG_PATH,
  NODE_ROUTES_PATH,
  PROVIDER_SELECTION_PATH,
  ROUTED_CATALOG_PATH,
  SWIFT_MODELS_PATH,
} = await import("../src/paths.mjs");
const { publishCatalogGeneration } = await import("../src/catalog-generation.mjs");

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

function bytesOrMissing(file) {
  return existsSync(file) ? readFileSync(file) : undefined;
}

function failingGeneration(reason) {
  return {
    buildFiles: async () => { throw new Error(`injected ${reason} generation failure`); },
    refreshTargets: () => { throw new Error("external refresh must not run"); },
  };
}

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
  return Object.fromEntries(Object.entries(generationPaths).map(([name, target]) => [
    name,
    readFileSync(target),
  ]));
}

function assertPublishedGeneration(snapshot) {
  for (const [name, target] of Object.entries(generationPaths)) {
    assert.deepEqual(readFileSync(target), snapshot[name], `${name} stable export changed`);
    assert.deepEqual(readFileSync(path.join(CATALOG_GENERATIONS_DIR, "current", name)), snapshot[name], `${name} current export changed`);
  }
}

test("production credential, provider, visibility, and canary wrappers restore state on generation failure", async () => {
  const oldGeneration = seedPublishedGeneration("wrapper-failure-old");
  const beforeSelection = bytesOrMissing(PROVIDER_SELECTION_PATH);
  const beforeCanary = bytesOrMissing(EXPERIMENTAL_MODELS_PATH);
  const beforeHidden = [...readHiddenModels()];
  const credentialPath = path.join(stateDir, "deepseek-api-key.secret");
  const beforeCredential = bytesOrMissing(credentialPath);

  await assert.rejects(
    saveApiCredentialAndRebuild("deepseek", "test-only-failure-key", failingGeneration("credential:set:deepseek")),
    /credential:set:deepseek generation failure/,
  );
  assert.deepEqual(bytesOrMissing(credentialPath), beforeCredential);
  assertPublishedGeneration(oldGeneration);

  await assert.rejects(
    setProviderEnabledAndRebuild("deepseek", false, failingGeneration("provider-selection:disable:deepseek")),
    /provider-selection:disable:deepseek generation failure/,
  );
  assert.deepEqual(bytesOrMissing(PROVIDER_SELECTION_PATH), beforeSelection);
  assertPublishedGeneration(oldGeneration);

  await assert.rejects(
    setModelVisibleAndRebuild("deepseek/deepseek-v4-flash", false, failingGeneration("model-visibility:deepseek/deepseek-v4-flash:hide")),
    /model-visibility:deepseek\/deepseek-v4-flash:hide generation failure/,
  );
  assert.deepEqual([...readHiddenModels()], beforeHidden);
  assertPublishedGeneration(oldGeneration);

  await assert.rejects(
    setExperimentalModel("deepseek/deepseek-v4-flash", true, failingGeneration("experimental-model:enable:deepseek/deepseek-v4-flash")),
    /experimental-model:enable:deepseek\/deepseek-v4-flash generation failure/,
  );
  assert.equal(experimentalModelEnabled("deepseek/deepseek-v4-flash"), false);
  assert.deepEqual(bytesOrMissing(EXPERIMENTAL_MODELS_PATH), beforeCanary);
  assertPublishedGeneration(oldGeneration);
});

test("credential removal mutates a real stored key before generation failure restores it", async () => {
  const oldGeneration = seedPublishedGeneration("credential-remove-old");
  writeProviderSelection(["deepseek"]);
  saveApiCredential("deepseek", "remove-me");
  const credentialPath = path.join(stateDir, "deepseek-api-key.secret");
  const beforeCredential = bytesOrMissing(credentialPath);
  const beforeSelection = bytesOrMissing(PROVIDER_SELECTION_PATH);
  const refreshes = [];

  await assert.rejects(
    removeApiCredentialAndRebuild("deepseek", {
      buildFiles: async ({ reason }) => {
        assert.equal(reason, "credential:remove:deepseek");
        assert.equal(existsSync(credentialPath), false, "production removal must be visible before generation build");
        assert.equal(readProviderSelection().includes("deepseek"), false);
        throw new Error("injected credential removal generation failure");
      },
      refreshTargets: () => refreshes.push("refresh"),
    }),
    /injected credential removal generation failure/,
  );
  assert.deepEqual(bytesOrMissing(credentialPath), beforeCredential);
  assert.deepEqual(bytesOrMissing(PROVIDER_SELECTION_PATH), beforeSelection);
  assert.deepEqual(refreshes, []);
  assertPublishedGeneration(oldGeneration);
});

test("provider enable mutates a disabled selection before generation failure restores it", async () => {
  const oldGeneration = seedPublishedGeneration("provider-enable-old");
  writeProviderSelection([]);
  const beforeSelection = bytesOrMissing(PROVIDER_SELECTION_PATH);
  const refreshes = [];

  await assert.rejects(
    setProviderEnabledAndRebuild("deepseek", true, {
      buildFiles: async ({ reason }) => {
        assert.equal(reason, "provider-selection:enable:deepseek");
        assert.deepEqual(readProviderSelection(), ["deepseek"]);
        throw new Error("injected provider enable generation failure");
      },
      refreshTargets: () => refreshes.push("refresh"),
    }),
    /injected provider enable generation failure/,
  );
  assert.deepEqual(bytesOrMissing(PROVIDER_SELECTION_PATH), beforeSelection);
  assert.deepEqual(refreshes, []);
  assertPublishedGeneration(oldGeneration);
});
