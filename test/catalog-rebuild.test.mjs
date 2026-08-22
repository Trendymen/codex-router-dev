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
  buildNodeSnapshotFiles,
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
const {
  NATIVE_CATALOG_PATH,
  NODE_ROUTES_PATH,
  PROTOCOL_PROOFS_PATH,
  ROUTED_CATALOG_PATH,
} = await import("../src/paths.mjs");
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
    dispatchProtocolProbe: async (candidate) => ({
      model: candidate.slug,
      verdict: "passing",
      measuredFinalReasoningShape: "hybrid-summary",
      checks: ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"].map((name) => ({ name, ok: true, observed: { fixture: true } })),
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
  const routed = JSON.parse(readFileSync(path.join(stateDir, "routed-models.json"), "utf8"));
  assert.ok(routed.models.some((model) => model.slug === "router/native-template"), "routed catalog retains native entries");
  for (const name of Object.keys(artifacts("unused"))) {
    assert.ok(readFileSync(path.join(stateDir, name)).byteLength > 0, name);
  }
});

test("an empty native capture fails closed without replacing the current generation", async () => {
  publishCatalogGeneration({ files: artifacts("old-native"), operations: testOperations() });
  const previous = readFileSync(path.join(stateDir, "merged-models.json"));
  writeFileSync(path.join(stateDir, "native-models.json"), "{\"models\":[]}\n");

  await assert.rejects(buildNodeSnapshotFiles(), /native catalog has no models/);
  assert.deepEqual(readFileSync(path.join(stateDir, "merged-models.json")), previous);
});

test("missing native capture preserves prior native models using node-route provenance without reviving removed routes", async () => {
  const native = {
    slug: "router/native-provenance",
    base_instructions: "native instructions",
    model_messages: { instructions_template: "native instructions" },
    supports_parallel_tool_calls: false,
  };
  const obsoleteRoute = {
    slug: "router/removed-node-route", provider: "router", upstreamModel: "removed",
    effectiveTransport: "openai-responses", toolDialect: "responses-functions", requestProfile: "router",
    reasoningDisplayMode: "raw-preserve", effectiveFinalReasoningShape: "raw-content", purpose: "primary",
  };
  const currentRoute = {
    slug: "router/current-node-route", provider: "router", upstreamModel: "current",
    effectiveTransport: "openai-responses", toolDialect: "responses-functions", requestProfile: "router",
    reasoningDisplayMode: "raw-preserve", effectiveFinalReasoningShape: "raw-content",
    declaredFinalReasoningShape: "raw-content", rolloutState: "stable", purpose: "primary",
    routable: true, listed: true, visible: true,
  };
  const old = artifacts("provenance-old");
  old["merged-models.json"] = { models: [native, { ...native, slug: obsoleteRoute.slug }] };
  old["routed-models.json"] = { models: [native, { ...native, slug: obsoleteRoute.slug }] };
  old["node-routes.json"] = { version: 1, routes: [obsoleteRoute] };
  publishCatalogGeneration({ files: old, operations: testOperations() });
  rmSync(NATIVE_CATALOG_PATH, { force: true });

  const rebuilt = await buildNodeSnapshotFiles({ nodeModels: [currentRoute] });

  assert.deepEqual(rebuilt["node-routes.json"].routes.map((route) => route.slug), [currentRoute.slug]);
  assert.deepEqual(
    rebuilt["routed-models.json"].models.map((model) => model.slug),
    [native.slug, currentRoute.slug],
  );
  assert.ok(existsSync(NODE_ROUTES_PATH));
  assert.ok(existsSync(ROUTED_CATALOG_PATH));
});

test("a queued rebuild runs after an active rebuild fails and returns its own result", async () => {
  let failActive;
  const activeStarted = new Promise((resolve) => { failActive = resolve; });
  let enteredActive;
  const entered = new Promise((resolve) => { enteredActive = resolve; });
  const calls = [];
  const first = rebuildNodeSnapshots("active", {
    catalogLock: async (operation) => operation(),
    buildFiles: async () => {
      calls.push("active");
      enteredActive();
      await activeStarted;
      throw new Error("active generation failure");
    },
    publish: async () => undefined,
  });
  await entered;
  const second = rebuildNodeSnapshots("queued", {
    catalogLock: async (operation) => operation(),
    buildFiles: async () => {
      calls.push("queued");
      return artifacts("queued");
    },
    publish: async () => ({ generation: "queued" }),
  });
  failActive();

  await assert.rejects(first, /active generation failure/);
  assert.equal((await second).reason, "queued");
  assert.deepEqual(calls, ["active", "queued"]);
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
    dispatchProtocolProbe: async (candidate) => {
      enteredProbe();
      await probeStarted;
      return {
        model: candidate.slug,
        verdict: "passing",
        measuredFinalReasoningShape: "hybrid-summary",
        checks: ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"].map((name) => ({ name, ok: true, observed: { fixture: true } })),
      };
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
