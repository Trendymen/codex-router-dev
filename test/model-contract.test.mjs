import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "model-contract-"));
const stateDir = path.join(scratch, "state");
const codexHome = path.join(scratch, "codex-home");
process.env.MODEL_ROUTER_USER_MODELS = path.join(scratch, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;

const FUTURE_NODE_SLUG = "deepseek/future-node-model";
writeFileSync(
  process.env.MODEL_ROUTER_USER_MODELS,
  JSON.stringify({
    version: 1,
    models: [
      {
        slug: FUTURE_NODE_SLUG,
        gatewayModel: "deepseek-future-node-model",
        upstreamModel: "future-node-model",
        provider: "deepseek",
        credentialOwner: "deepseek",
        effectiveTransport: "openai-responses",
        toolDialect: "responses-functions",
        reasoningDisplayMode: "summary-compat",
        declaredFinalReasoningShape: "raw-content",
        rolloutState: "stable",
        purpose: "primary",
        listed: true,
        displayName: "Future Node Model",
        description: "Valid user overlay model outside the normative Appendix B matrix.",
        priority: 999,
        defaultEffort: "high",
        reasoningLevels: [{ effort: "high", description: "Deep reasoning" }],
        contextWindow: 131072,
        autoCompact: 110000,
        inputModalities: ["text"],
        requestProfile: "deepseek-thinking",
        compHash: "deepseek-future-node-model-user-v1",
      },
    ],
  }),
);

const oracle = (await import("./fixtures/node-route-matrix.json", { with: { type: "json" } })).default;
const { MODEL_BY_SLUG, MODELS } = await import("../src/model-registry.mjs");
const {
  nodeRoutableModels,
  resolveNodeModel,
  validateNodeModel,
} = await import("../src/model-contract.mjs");
const { registryFingerprint } = await import("../src/protocol-proof.mjs");

after(() => rmSync(scratch, { recursive: true, force: true }));

function proofFor(model, measuredFinalReasoningShape = "raw-content") {
  const verifierVersion = 1;
  return {
    slug: model.slug,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    transport: model.effectiveTransport,
    toolDialect: model.toolDialect,
    requestProfile: model.requestProfile,
    verdict: "passing",
    fingerprint: registryFingerprint(model, verifierVersion),
    verifierVersion,
    measuredFinalReasoningShape,
    verifiedAt: "2026-08-21T12:00:00.000Z",
  };
}

function stateFor(model, overrides = {}) {
  return {
    providerEnabled: true,
    canaryEnabled: model.rolloutState === "experimental",
    proof: model.rolloutState === "experimental" ? proofFor(model) : null,
    ...overrides,
  };
}

test("Appendix B oracle matches every Node model registry field", () => {
  for (const [slug, expected] of Object.entries(oracle)) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `missing registry model ${slug}`);
    assert.equal(model.provider, expected.provider, slug);
    assert.equal(model.upstreamModel, expected.upstreamModel, slug);
    assert.equal(model.credentialOwner, expected.credentialOwner, slug);
    assert.equal(model.effectiveTransport, expected.transport, slug);
    assert.equal(model.toolDialect, expected.toolDialect, slug);
    assert.equal(model.reasoningDisplayMode, expected.reasoningDisplayMode, slug);
    assert.equal(model.declaredFinalReasoningShape, expected.finalShape, slug);
    assert.equal(model.purpose, expected.purpose, slug);
    assert.equal(model.rolloutState, expected.rollout, slug);
    assert.equal(model.listed, expected.listed, slug);
  }
});

test("Appendix B oracle has the exact unique slug set and complete proof-gated row contract", () => {
  const expectedSlugs = [
    "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "qwen-plan/qwen3.8-max", "qwen-plan/deepseek-v4-flash-0731",
    "qwen-plan/qwen3.8-max-preview", "qwen-plan/qwen3.7-max", "qwen-plan/qwen3.7-plus", "qwen-plan/qwen3.6-flash",
    "qwen-plan/deepseek-v4-pro", "qwen-plan/deepseek-v4-pro-0813", "qwen-plan/glm-5.2", "qwen-plan-responses/glm-5.2",
  ];
  const rows = Object.entries(oracle);
  assert.equal(new Set(rows.map(([slug]) => slug)).size, rows.length);
  assert.deepEqual(rows.map(([slug]) => slug).sort(), expectedSlugs.sort());
  for (const [slug, row] of rows) {
    for (const field of ["provider", "credentialOwner", "upstreamModel", "transport", "toolDialect", "reasoningDisplayMode", "finalShape", "purpose", "rollout", "listed"]) assert.ok(Object.hasOwn(row, field), `${slug}: ${field}`);
    assert.equal(typeof row.provider, "string", slug);
    assert.equal(typeof row.credentialOwner, "string", slug);
    assert.equal(typeof row.upstreamModel, "string", slug);
    assert.match(row.transport, /^(?:openai-responses|anthropic-messages)$/, slug);
    assert.match(row.toolDialect, /^responses-functions$/, slug);
    assert.match(row.reasoningDisplayMode, /^(?:summary-compat|raw-preserve)$/, slug);
    assert.match(row.finalShape, /^(?:raw-content|hybrid-summary|anthropic-thinking|unverified)$/, slug);
    assert.match(row.purpose, /^(?:primary|compatibility)$/, slug);
    assert.match(row.rollout, /^(?:stable|experimental)$/, slug);
    assert.equal(typeof row.listed, "boolean", slug);
    const model = MODEL_BY_SLUG.get(slug);
    const resolved = resolveNodeModel(model, stateFor(model));
    assert.equal(resolved.routable, true, slug);
    if (row.rollout === "experimental") {
      assert.equal(resolveNodeModel(model, { providerEnabled: true, canaryEnabled: true, proof: null }).routable, false, `${slug}: proof required`);
      assert.equal(resolved.effectiveFinalReasoningShape, "raw-content", `${slug}: measured proof shape`);
    } else assert.equal(resolved.effectiveFinalReasoningShape, row.finalShape, slug);
  }
});

test("Node routing contains every Appendix B row and no legacy registry model", () => {
  const proofs = new Map(
    Object.keys(oracle)
      .filter((slug) => oracle[slug].rollout === "experimental")
      .map((slug) => {
        const model = MODEL_BY_SLUG.get(slug);
        return [slug, proofFor(model)];
      }),
  );
  const routed = nodeRoutableModels({
    enabledProviders: new Set(["deepseek", "qwen-plan"]),
    enabledCanaries: new Set(
      Object.keys(oracle).filter((slug) => oracle[slug].rollout === "experimental"),
    ),
    proofs,
  });

  assert.deepEqual(
    routed.map((model) => model.slug).sort(),
    Object.keys(oracle).sort(),
  );
  assert.equal(
    routed.some((model) => model.slug === "deepseek/deepseek-chat"),
    false,
  );
});

test("valid Node metadata outside Appendix B never becomes routable", () => {
  assert.ok(MODEL_BY_SLUG.has(FUTURE_NODE_SLUG));
  assert.equal(
    nodeRoutableModels({ enabledProviders: new Set(["deepseek"]) })
      .some((model) => model.slug === FUTURE_NODE_SLUG),
    false,
  );
});

test("stable model needs an enabled provider and uses its declared final shape", () => {
  const model = MODEL_BY_SLUG.get("deepseek/deepseek-v4-flash");
  const resolved = resolveNodeModel(model, { providerEnabled: true });
  assert.equal(resolved.routable, true);
  assert.equal(resolved.publicError, undefined);
  assert.equal(resolved.effectiveFinalReasoningShape, "raw-content");
  assert.equal(resolved.visible, true);

  const disabled = resolveNodeModel(model, { providerEnabled: false });
  assert.equal(disabled.routable, false);
  assert.equal(disabled.publicError, "model_not_enabled");
  assert.equal(disabled.visible, false);
});

test("canary enable without matching proof remains unroutable", () => {
  const canary = MODEL_BY_SLUG.get("qwen-plan/qwen3.7-max");
  const resolved = resolveNodeModel(canary, { enabled: true, proof: null });
  assert.equal(resolved.routable, false);
  assert.equal(resolved.publicError, "model_not_enabled");
  assert.equal(resolved.effectiveFinalReasoningShape, null);
  assert.equal(resolved.visible, false);
});

test("a matching canary proof resolves the measured final shape", () => {
  const canary = MODEL_BY_SLUG.get("qwen-plan/qwen3.7-max");
  const resolved = resolveNodeModel(canary, {
    providerEnabled: true,
    canaryEnabled: true,
    proof: proofFor(canary, "hybrid-summary"),
  });
  assert.equal(resolved.routable, true);
  assert.equal(resolved.publicError, undefined);
  assert.equal(resolved.effectiveFinalReasoningShape, "hybrid-summary");
  assert.equal(resolved.visible, true);
});

test("every proof contract field is exact-slug and fingerprint gated", () => {
  const canary = MODEL_BY_SLUG.get("qwen-plan/qwen3.7-max");
  const valid = proofFor(canary);
  for (const field of [
    "slug",
    "provider",
    "upstreamModel",
    "transport",
    "toolDialect",
    "requestProfile",
    "fingerprint",
  ]) {
    const mismatch = { ...valid, [field]: `${valid[field]}-mismatch` };
    const resolved = resolveNodeModel(canary, {
      providerEnabled: true,
      canaryEnabled: true,
      proof: mismatch,
    });
    assert.equal(resolved.routable, false, field);
    assert.equal(resolved.publicError, "model_not_enabled", field);
  }
  for (const mismatch of [
    { verdict: "failed" },
    { verifierVersion: 2 },
  ]) {
    const resolved = resolveNodeModel(canary, {
      providerEnabled: true,
      canaryEnabled: true,
      proof: { ...valid, ...mismatch },
    });
    assert.equal(resolved.routable, false, JSON.stringify(mismatch));
    assert.equal(resolved.publicError, "model_not_enabled", JSON.stringify(mismatch));
  }
  for (const shape of ["provider-summary", "raw-content", "hybrid-summary", "anthropic-thinking"]) {
    const resolved = resolveNodeModel(canary, {
      providerEnabled: true,
      canaryEnabled: true,
      proof: { ...valid, measuredFinalReasoningShape: shape },
    });
    assert.equal(resolved.effectiveFinalReasoningShape, shape, shape);
  }
  const unresolved = resolveNodeModel(canary, {
    providerEnabled: true,
    canaryEnabled: true,
    proof: { ...valid, measuredFinalReasoningShape: "unverified" },
  });
  assert.equal(unresolved.routable, false);
  assert.equal(unresolved.effectiveFinalReasoningShape, null);
});

test("compatibility alias remains hidden even after its canary proof passes", () => {
  const alias = MODEL_BY_SLUG.get("qwen-plan-responses/glm-5.2");
  const resolved = resolveNodeModel(alias, {
    providerEnabled: true,
    canaryEnabled: true,
    proof: proofFor(alias, "raw-content"),
  });
  assert.equal(resolved.purpose, "compatibility");
  assert.equal(resolved.routable, true);
  assert.equal(resolved.listed, false);
  assert.equal(resolved.visible, false);
});

test("picker-hidden and provider-disabled models are never visible", () => {
  const model = MODEL_BY_SLUG.get("deepseek/deepseek-v4-pro");
  assert.equal(
    resolveNodeModel(model, { providerEnabled: true, visible: false }).visible,
    false,
  );
  assert.equal(
    resolveNodeModel(model, { providerEnabled: true, hiddenModels: new Set([model.slug]) }).visible,
    false,
  );
  assert.equal(
    resolveNodeModel(model, { providerEnabled: false, visible: true }).visible,
    false,
  );
});

test("Node metadata enums and stable final shapes are strict", () => {
  const stable = MODEL_BY_SLUG.get("deepseek/deepseek-v4-flash");
  for (const field of [
    "effectiveTransport",
    "toolDialect",
    "reasoningDisplayMode",
    "declaredFinalReasoningShape",
    "rolloutState",
    "purpose",
  ]) {
    assert.throws(
      () => validateNodeModel({ ...stable, [field]: "unknown-value" }),
      new RegExp(field),
    );
  }
  assert.throws(
    () => validateNodeModel({ ...stable, declaredFinalReasoningShape: "unverified" }),
    /unverified.*experimental|experimental.*unverified/i,
  );
});

test("legacy models remain readable but are excluded from Node resolution", () => {
  const legacy = MODEL_BY_SLUG.get("deepseek/deepseek-chat");
  assert.ok(legacy);
  assert.equal(legacy.effectiveTransport, undefined);
  assert.equal(
    nodeRoutableModels({ enabledProviders: new Set(["deepseek", "qwen-plan"]) })
      .some((model) => model.slug === legacy.slug),
    false,
  );
});
