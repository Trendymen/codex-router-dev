import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "catalog-rebuild-"));
const stateDir = path.join(scratch, "state");
const codexHome = path.join(scratch, "codex-home");
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;

const {
  createCatalogGenerationFileSystem,
  publishCatalogGeneration,
} = await import("../src/catalog-generation.mjs");
const {
  rebuildNodeSnapshots,
  transactNodeStateMutation,
} = await import("../src/catalog-rebuild.mjs");
const {
  invalidateProtocolProofForModel,
  readProtocolProof,
  revokeProtocolProof,
  writePassingProtocolProof,
} = await import("../src/protocol-proof.mjs");
const { verifyProtocolProof } = await import("../src/protocol-proof-verifier.mjs");
const { PROTOCOL_PROOFS_PATH } = await import("../src/paths.mjs");
const { setExperimentalModel, experimentalModelEnabled } = await import("../src/experimental-models.mjs");

const primarySlug = "qwen-plan/qwen3.7-max";
const siblingSlug = "qwen-plan/qwen3.7-plus";

function artifacts(label) {
  const catalog = {
    models: [{
      slug: `router/${label}`,
      base_instructions: `instructions ${label}`,
      model_messages: { instructions_template: `instructions ${label}` },
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

function rebuildOptions(label) {
  return {
    buildFiles: async () => artifacts(label),
    publish: (files) => publishCatalogGeneration({ files, legacyPaths: {}, operations: testOperations() }),
  };
}

function testOperations() {
  const base = createCatalogGenerationFileSystem();
  if (process.platform !== "win32") return base;
  // Test-only privilege-free adapter; production Windows fails closed rather
  // than publishing through junction/hard-link replacement.
  return {
    ...base,
    symlink(source, target, type) {
      if (type === "dir") return symlinkSync(path.resolve(path.dirname(target), source), target, "junction");
      return linkSync(path.resolve(path.dirname(target), source), target);
    },
    rename(source, target) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      return renameSync(source, target);
    },
  };
}

function verifierOptions(label) {
  return {
    confirmed: true,
    clock: () => new Date("2026-08-22T01:02:03.000Z"),
    dispatchProtocolProbe: async () => ({
      verdict: "passing",
      measuredFinalReasoningShape: "hybrid-summary",
    }),
    transactionOptions: rebuildOptions(label),
  };
}

beforeEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
});

after(() => rmSync(scratch, { recursive: true, force: true }));

test("transaction serializes concurrent protected RMW mutations without dropping either update", async () => {
  const target = path.join(stateDir, "state.json");
  const writeEntry = (key, value) => transactNodeStateMutation({
    files: [target],
    reason: `write-${key}`,
    mutate: () => {
      const before = JSON.parse(readFileSync(target, "utf8"));
      writeFileSync(target, JSON.stringify({ ...before, [key]: value }));
    },
    ...rebuildOptions(`mutation-${key}`),
  });
  writeFileSync(target, "{}");

  await Promise.all([writeEntry("first", 1), writeEntry("second", 2)]);

  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { first: 1, second: 2 });
});

test("default Node snapshot rebuild republishes one complete generation from the current catalog", async () => {
  publishCatalogGeneration({ files: artifacts("native-template"), operations: testOperations() });

  const result = await rebuildNodeSnapshots("test-default-rebuild", {
    publish: (files) => publishCatalogGeneration({ files, operations: testOperations() }),
  });

  assert.equal(result.reason, "test-default-rebuild");
  for (const name of Object.keys(artifacts("unused"))) {
    assert.ok(readFileSync(path.join(stateDir, name)).byteLength > 0, name);
  }
});

test("concurrent verification records for distinct slugs preserve both proofs", async () => {
  await Promise.all([
    verifyProtocolProof(primarySlug, verifierOptions("primary")),
    verifyProtocolProof(siblingSlug, verifierOptions("sibling")),
  ]);

  assert.equal(readProtocolProof(primarySlug)?.slug, primarySlug);
  assert.equal(readProtocolProof(siblingSlug)?.slug, siblingSlug);
});

test("a revoke wins over a verification candidate that started before it", async () => {
  await verifyProtocolProof(primarySlug, verifierOptions("initial"));
  let releaseProbe;
  const probeStarted = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  let enteredProbe;
  const entered = new Promise((resolve) => { enteredProbe = resolve; });
  const overlapping = verifyProtocolProof(primarySlug, {
    ...verifierOptions("candidate"),
    dispatchProtocolProbe: async () => {
      enteredProbe();
      await probeStarted;
      return { verdict: "passing", measuredFinalReasoningShape: "hybrid-summary" };
    },
  });
  await entered;
  await revokeProtocolProof(primarySlug, rebuildOptions("revoked"));
  releaseProbe();
  await assert.rejects(overlapping, { code: "protocol_proof_state_changed" });
  assert.equal(readProtocolProof(primarySlug), null);
});

test("fingerprint invalidation removes only the stale proof through the transaction boundary", async () => {
  await verifyProtocolProof(primarySlug, verifierOptions("initial"));
  await invalidateProtocolProofForModel({
    slug: primarySlug,
    provider: "qwen-plan",
    upstreamModel: "changed-upstream",
    effectiveTransport: "openai-responses",
    toolDialect: "responses-functions",
    requestProfile: "qwen-plan",
  }, rebuildOptions("invalidated"));

  assert.equal(readProtocolProof(primarySlug), null);
});

test("canary setter has a transaction-safe publication path", async () => {
  await setExperimentalModel(primarySlug, true, rebuildOptions("canary"));

  assert.equal(experimentalModelEnabled(primarySlug), true);
  assert.ok(readFileSync(path.join(stateDir, "catalog-generations", "current", "node-routes.json")).byteLength > 0);
});

test("generation failure restores proof bytes and leaves every current artifact unchanged", async () => {
  await writePassingProtocolProof({
    slug: primarySlug,
    provider: "qwen-plan",
    upstreamModel: "qwen3.7-max",
    transport: "openai-responses",
    toolDialect: "responses-functions",
    requestProfile: "qwen-plan",
    verdict: "passing",
    fingerprint: "first",
    verifierVersion: 1,
    measuredFinalReasoningShape: "hybrid-summary",
    verifiedAt: "2026-08-22T01:02:03.000Z",
  }, rebuildOptions("old"));
  const beforeProof = readFileSync(PROTOCOL_PROOFS_PATH);
  const generationsDir = path.join(stateDir, "catalog-generations", "current");
  const names = Object.keys(artifacts("old"));
  const beforeArtifacts = Object.fromEntries(names.map((name) => [name, readFileSync(path.join(generationsDir, name))]));

  await assert.rejects(
    () => writePassingProtocolProof({
      slug: primarySlug,
      provider: "qwen-plan",
      upstreamModel: "qwen3.7-max",
      transport: "openai-responses",
      toolDialect: "responses-functions",
      requestProfile: "qwen-plan",
      verdict: "passing",
      fingerprint: "second",
      verifierVersion: 1,
      measuredFinalReasoningShape: "hybrid-summary",
      verifiedAt: "2026-08-22T01:03:03.000Z",
    }, { buildFiles: async () => { throw new Error("injected generation failure"); } }),
    /injected generation failure/,
  );

  assert.deepEqual(readFileSync(PROTOCOL_PROOFS_PATH), beforeProof);
  assert.deepEqual(
    Object.fromEntries(names.map((name) => [name, readFileSync(path.join(generationsDir, name))])),
    beforeArtifacts,
  );
});
