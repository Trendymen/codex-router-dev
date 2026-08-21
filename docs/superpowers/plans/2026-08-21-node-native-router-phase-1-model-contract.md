# Node-Native Router Phase 1 Model Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the strict supported-model matrix, exact-slug protocol proof gate, deterministic routed catalog, and read-only CC Switch/search integration before changing provider dispatch.

**Architecture:** Extend the checked-in registry with explicit Node transport metadata and resolve it through a pure model-contract module. Store canary selection and proof records in protected Router state, then publish route/catalog snapshots atomically from one locked rebuild without consulting the active CC Switch profile.

**Tech Stack:** Node.js 22.19+, JSON registry fragments, native `crypto`/`fs`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-21-node-native-macos-router-design.md`

## Global Constraints

- Implement Appendices B, E, F proof fields, and the Section 9 search gate exactly.
- No task in this phase sends a provider request or enables a new production route.
- Unknown registry enum values fail startup.
- `unverified` is legal only for `rolloutState: "experimental"`.
- A canary route requires exact-slug enable and a passing proof with a matching full fingerprint.
- Catalog writes are mode `0600`, validated, fsynced, and atomically renamed under one process lock.
- Never write CC Switch data or any `$CODEX_HOME` file outside Router-owned state.

---

## File Structure

- `src/model-contract.mjs`: validate Node-specific model metadata and resolve effective routability/final shape.
- `src/protocol-proof.mjs`: fingerprint registry profiles and read/write/revoke exact-slug proof records.
- `src/experimental-models.mjs`: protected exact-slug canary state.
- `src/catalog-rebuild.mjs`: coalesce triggers and publish route/catalog/control snapshots under one lock.
- `src/catalog-generation.mjs`: build immutable snapshot generations and atomically switch one `current` pointer.
- `src/cc-switch-snippet.mjs`: pure aggregate TOML rendering.
- `src/standalone-search-doctor.mjs`: read-only feature-gate status and snippet.
- `test/fixtures/node-route-matrix.json`: independent Appendix B oracle.
- `test/fixtures/codex-model-catalog-0.147.schema.json`: required old-client catalog fixture.
- `test/fixtures/codex-model-catalog-0.149.schema.json`: current-client catalog fixture.

### Task 1: Add protected canary and protocol-proof state

**Files:**
- Modify: `src/paths.mjs`
- Create: `src/experimental-models.mjs`
- Create: `src/protocol-proof.mjs`
- Create: `test/protocol-proof.test.mjs`
- Test: `test/state-owner.test.mjs`

**Interfaces:**
- Produces: `experimentalModelEnabled(slug) -> boolean`.
- Produces: `setExperimentalModel(slug, enabled) -> void`.
- Produces: `registryFingerprint(model, verifierVersion) -> string`.
- Produces: `readProtocolProof(slug) -> ProtocolProofRecord | null`.
- Produces: `writePassingProtocolProof(record) -> void` and `revokeProtocolProof(slug) -> void`.

- [ ] **Step 1: Write failing protected-state tests**

```js
test("canary defaults off and is exact-slug scoped", () => {
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), false);
  setExperimentalModel("qwen-plan/qwen3.7-max", true);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), true);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-plus"), false);
});

test("failed verification never replaces a passing proof", () => {
  writePassingProtocolProof(passingProof);
  assert.throws(() => writePassingProtocolProof({...passingProof, verdict: "failed"}));
  assert.deepEqual(readProtocolProof(passingProof.slug), passingProof);
});
```

Also assert `0600` files, corrupt-file fail-closed behavior, atomic replacement, revoke, and no access to real `CODEX_HOME` under isolated test state.

- [ ] **Step 2: Run the tests to verify RED**

```bash
node --test test/protocol-proof.test.mjs test/state-owner.test.mjs
```

Expected: FAIL because the modules and path constants do not exist.

- [ ] **Step 3: Add exact state paths and minimal state readers/writers**

```js
export const EXPERIMENTAL_MODELS_PATH = join(STATE_DIR, "experimental-models.json");
export const PROTOCOL_PROOFS_PATH = join(STATE_DIR, "protocol-proofs.json");

export function registryFingerprint(model, verifierVersion) {
  return createHash("sha256").update(canonicalJson({
    verifierVersion,
    slug: model.slug,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    effectiveTransport: model.effectiveTransport,
    toolDialect: model.toolDialect,
    requestProfile: model.requestProfile,
  })).digest("base64url");
}
```

Use the repository's protected-state and atomic-write helpers; reject proof writes unless `verdict === "passing"`.

- [ ] **Step 4: Re-run focused tests to verify GREEN**

```bash
node --test test/protocol-proof.test.mjs test/state-owner.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the state boundary**

```bash
git add src/paths.mjs src/experimental-models.mjs src/protocol-proof.mjs test/protocol-proof.test.mjs test/state-owner.test.mjs
git commit -m "feat: add protocol proof state"
```

### Task 2: Encode and validate the normative Node model matrix

**Files:**
- Create: `src/model-contract.mjs`
- Modify: `src/model-registry.mjs`
- Modify: `config/deepseek/deepseek-v4-flash.json`
- Modify: `config/deepseek/deepseek-v4-pro.json`
- Modify: `config/qwen/plan/qwen3.8-max.json`
- Modify: `config/qwen/plan/deepseek-v4-flash-0731.json`
- Modify: `config/qwen/plan/qwen3.8-max-preview.json`
- Modify: `config/qwen/plan/qwen3.7-max.json`
- Modify: `config/qwen/plan/qwen3.7-plus.json`
- Modify: `config/qwen/plan/qwen3.6-flash.json`
- Modify: `config/qwen/plan/deepseek-v4-pro.json`
- Modify: `config/qwen/plan/deepseek-v4-pro-0813.json`
- Modify: `config/qwen/plan/glm-5.2.json`
- Create: `config/qwen/plan/glm-5.2-responses.json`
- Create: `test/fixtures/node-route-matrix.json`
- Create: `test/model-contract.test.mjs`
- Test: `test/registry.test.mjs`

**Interfaces:**
- Consumes: `experimentalModelEnabled()` and `readProtocolProof()` from Task 1.
- Produces: `resolveNodeModel(model, state) -> ResolvedNodeModel`.
- Produces: `nodeRoutableModels(state) -> ResolvedNodeModel[]`.
- `ResolvedNodeModel` includes `effectiveTransport`, `toolDialect`, `reasoningDisplayMode`, `declaredFinalReasoningShape`, `effectiveFinalReasoningShape`, `rolloutState`, `purpose`, `routable`, `listed`, and `visible`.

- [ ] **Step 1: Check in the independent Appendix B oracle and failing matrix tests**

```json
{
  "deepseek/deepseek-v4-flash": {
    "transport": "openai-responses",
    "toolDialect": "responses-functions",
    "finalShape": "raw-content",
    "rollout": "stable",
    "listed": true
  },
  "qwen-plan/glm-5.2": {
    "transport": "anthropic-messages",
    "toolDialect": "responses-functions",
    "finalShape": "anthropic-thinking",
    "rollout": "stable",
    "listed": true
  }
}
```

The fixture must contain every Appendix B row, including all experimental Qwen slugs and the unlisted GLM Responses alias. Tests compare every field and assert no other registry model is Node-routable.

- [ ] **Step 2: Add failing validation and proof-gate cases**

```js
test("canary enable without matching proof remains unroutable", () => {
  const resolved = resolveNodeModel(canary, {enabled: true, proof: null});
  assert.equal(resolved.routable, false);
  assert.equal(resolved.publicError, "model_not_enabled");
});

test("stable unverified shape is rejected", () => {
  assert.throws(() => validateNodeModel({...stable, declaredFinalReasoningShape: "unverified"}));
});
```

Cover every unknown enum, proof mismatch field, hidden/visible rule, provider disabled state, legacy slug, and compatibility-purpose behavior.

- [ ] **Step 3: Run focused tests to verify RED**

```bash
node --test test/model-contract.test.mjs test/registry.test.mjs
```

Expected: FAIL on missing model contract and metadata.

- [ ] **Step 4: Implement strict enums and model resolution**

```js
const TRANSPORTS = new Set(["native-openai", "openai-responses", "anthropic-messages"]);
const TOOL_DIALECTS = new Set(["responses-native", "responses-functions"]);
const FINAL_SHAPES = new Set(["provider-summary", "raw-content", "hybrid-summary", "anthropic-thinking", "unverified"]);

export function resolveNodeModel(model, state) {
  validateNodeModel(model);
  const proofMatches = proofMatchesModel(state.proof, model);
  const routable = model.rolloutState === "stable"
    ? state.providerEnabled
    : state.providerEnabled && state.canaryEnabled && proofMatches;
  return Object.freeze({...model, routable,
    effectiveFinalReasoningShape: model.declaredFinalReasoningShape === "unverified"
      ? state.proof?.measuredFinalReasoningShape ?? null
      : model.declaredFinalReasoningShape});
}
```

Keep legacy registry entries readable for state preservation, but exclude them from `nodeRoutableModels()`.

- [ ] **Step 5: Update only Appendix B model fragments**

Set the exact transport, dialect, final shape, purpose, and rollout values from the oracle. The GLM Responses alias uses canonical slug `qwen-plan-responses/glm-5.2`, is unlisted/hidden, experimental, and shares the `qwen-plan` credential owner without copying a key.

- [ ] **Step 6: Re-run model tests to verify GREEN**

```bash
node --test test/model-contract.test.mjs test/registry.test.mjs
```

Expected: PASS and the oracle asserts the complete allowed and forbidden sets.

- [ ] **Step 7: Commit the model contract**

```bash
git add src/model-contract.mjs src/model-registry.mjs config/deepseek config/qwen/plan test/fixtures/node-route-matrix.json test/model-contract.test.mjs test/registry.test.mjs
git commit -m "feat: define node model route contract"
```

### Task 3: Implement the quota-gated protocol verifier

**Files:**
- Modify: `src/protocol-proof.mjs`
- Create: `src/protocol-proof-verifier.mjs`
- Modify: `src/control.mjs`
- Modify: `src/protocol-proof.mjs`
- Modify: `src/protocol-proof-verifier.mjs`
- Modify: `src/experimental-models.mjs`
- Modify: `bin/model-router`
- Test: `test/protocol-proof.test.mjs`
- Create: `test/protocol-proof-verifier.test.mjs`

**Interfaces:**
- Consumes: unresolved experimental model metadata from Task 2.
- Produces: `verifyProtocolProof(slug, {confirmed, fetchImpl, clock}) -> Promise<ProtocolProofRecord>`.
- Produces CLI: `model-router codex protocol-proof status|verify|revoke [SLUG]`.
- Phase 2 supplies the final declared-transport request/response probe implementation through `dispatchProtocolProbe()`; Task 3 defines the no-fallback orchestration contract with a fixture dispatcher.

- [ ] **Step 1: Write failing confirmation and fingerprint tests**

```js
test("verify without confirmation sends no request", async () => {
  let calls = 0;
  await assert.rejects(() => verifyProtocolProof(slug, {
    confirmed: false,
    fetchImpl: async () => { calls += 1; },
  }), {code: "quota_confirmation_required"});
  assert.equal(calls, 0);
});
```

Cover declared transport only, no public failover/retry, passing write, failed first proof, failed reverify preserving the old proof, revoke, verifier-version mismatch, and every model fingerprint field.

- [ ] **Step 2: Run verifier tests to verify RED**

```bash
node --test test/protocol-proof.test.mjs test/protocol-proof-verifier.test.mjs
```

Expected: FAIL because verifier orchestration and commands do not exist.

- [ ] **Step 3: Implement the verifier state machine around an injected dispatcher**

```js
export async function verifyProtocolProof(slug, options) {
  if (!options.confirmed) throw publicError("quota_confirmation_required", 409);
  const model = experimentalModelForSlug(slug);
  const evidence = await options.dispatchProtocolProbe(model, {
    retry: false,
    failover: false,
    checks: ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"],
  });
  const record = passingRecord(model, evidence, options.clock());
  writePassingProtocolProof(record);
  return record;
}
```

The command prints a quota warning and exits without dispatch unless `--yes` is present. Do not implement a live provider adapter in this phase.

- [ ] **Step 4: Re-run verifier tests to verify GREEN**

```bash
node --test test/protocol-proof.test.mjs test/protocol-proof-verifier.test.mjs test/control.test.mjs
```

Expected: PASS using only injected fixture dispatchers.

- [ ] **Step 5: Commit the verifier contract**

```bash
git add src/protocol-proof.mjs src/protocol-proof-verifier.mjs src/control.mjs bin/model-router test/protocol-proof.test.mjs test/protocol-proof-verifier.test.mjs test/control.test.mjs
git commit -m "feat: add quota-gated protocol proofs"
```

### Task 4: Publish deterministic routed catalog and route snapshots

**Files:**
- Modify: `src/paths.mjs`
- Create: `src/catalog-rebuild.mjs`
- Create: `src/catalog-generation.mjs`
- Modify: `src/catalog.mjs`
- Modify: `src/catalog-publication-lock.mjs`
- Modify: `src/model-overlay-publication.mjs`
- Modify: `src/routed-client-models.mjs`
- Modify: `src/provider-onboarding.mjs`
- Modify: `src/provider-selection.mjs`
- Modify: `src/model-picker-state.mjs`
- Modify: `src/codex-native-session.mjs`
- Modify: `src/target-integration.mjs`
- Modify: `src/start.mjs`
- Modify: `src/update.mjs`
- Modify: `src/control.mjs`
- Create: `test/fixtures/codex-model-catalog-0.147.schema.json`
- Create: `test/fixtures/codex-model-catalog-0.149.schema.json`
- Test: `test/catalog.test.mjs`
- Test: `test/catalog-publication-lock.test.mjs`
- Test: `test/refresh-catalog.test.mjs`

**Interfaces:**
- Consumes: `nodeRoutableModels(state)` from Task 2.
- Produces: `rebuildNodeSnapshots(reason) -> Promise<SnapshotBuildResult>`.
- Produces: `buildRoutedCatalog({nativeModels, routedModels}) -> CodexCatalog`.
- Produces: `transactNodeStateMutation({files, mutate, reason}) -> Promise<SnapshotBuildResult>`.
- Writes: one immutable generation containing `merged-models.json`, `routed-models.json`, and route/control/UI snapshots; fixed paths resolve through one atomically switched `current` generation pointer.

- [ ] **Step 1: Write failing catalog independence and atomicity tests**

```js
for (const activeProvider of ["openai", "codex-router", "deepseek"]) {
  test(`routed catalog ignores active profile ${activeProvider}`, async () => {
    const bytes = await buildRoutedCatalogFixture({activeProvider});
    assert.equal(bytes, expectedRoutedCatalogBytes);
  });
}
```

Assert every model has boolean `supports_parallel_tool_calls`, full instructions/messages survive, both 0.147 and 0.149 fixtures parse, experimental defaults are absent, failed validation preserves old bytes, generation targets are `0600`, and concurrent triggers coalesce once.

- [ ] **Step 2: Run catalog tests to verify RED**

```bash
node --test test/catalog.test.mjs test/catalog-publication-lock.test.mjs test/refresh-catalog.test.mjs
```

Expected: FAIL because `routed-models.json` and unified rebuild do not exist.

- [ ] **Step 3: Implement pure routed catalog generation**

```js
export function buildRoutedCatalog({nativeModels, routedModels}) {
  return [...nativeModels, ...routedModels].map((model) => ({
    ...toCodexModel(model),
    supports_parallel_tool_calls: model.supportsParallelToolCalls === true,
  }));
}
```

Do not inspect live `config.toml` or CC Switch state. Preserve canonical provider-prefixed slugs and omit `show_raw_agent_reasoning`.

- [ ] **Step 4: Implement one-pointer generation publication**

Build all outputs in memory, validate both catalog schemas, write every output mode `0600` into a new immutable generation directory, `fsync` every file and directory, then atomically replace one `current` symlink. Fixed catalog paths resolve through `current`, so every reader observes one generation. On any error before pointer replacement, delete only the new generation; on pointer replacement failure, retain the previous pointer. Migrate existing regular catalog files to stable symlinks under a byte/mode snapshot with rollback.

Inject failures at every write, file `fsync`, directory `fsync`, symlink creation, and pointer rename boundary. Assert both catalogs plus route/control/UI readers resolve either the complete old generation or the complete new generation, never a mixed set.

- [ ] **Step 5: Wire every Appendix E rebuild trigger**

Implement `transactNodeStateMutation()` as the only state-plus-generation commit path: snapshot touched protected files, run `mutate`, build the complete generation, atomically switch `current`, then return success; any mutation or generation failure restores the touched files and leaves the old pointer active. Route credential set/remove through `provider-onboarding.mjs`; provider selection through `provider-selection.mjs`; visibility/canary through `model-picker-state.mjs`, `experimental-models.mjs`, and `control.mjs`; proof create/reverify/revoke/fingerprint invalidation through `protocol-proof.mjs` and `protocol-proof-verifier.mjs`; native-session usability transitions through `codex-native-session.mjs`; startup/update completion through `start.mjs` and `update.mjs`.

Change `verifyProtocolProof()` to pass its candidate record to `transactNodeStateMutation()` instead of directly writing it; revoke and fingerprint invalidation use the same transaction. Add non-live fixture-dispatcher tests that prove passing verification, reverify, revoke, and fingerprint invalidation switch proof state, route table, both catalogs, control snapshot, and both UI snapshots together; injected rebuild failure preserves the prior proof and generation. Add one equivalent test per canary, credential, provider, visibility, native-session, startup, and registry-update trigger.

- [ ] **Step 6: Re-run catalog tests to verify GREEN**

```bash
node --test test/catalog.test.mjs test/catalog-publication-lock.test.mjs test/refresh-catalog.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit deterministic publication**

```bash
git add src/paths.mjs src/catalog-rebuild.mjs src/catalog-generation.mjs src/catalog.mjs src/catalog-publication-lock.mjs src/model-overlay-publication.mjs src/routed-client-models.mjs src/provider-onboarding.mjs src/provider-selection.mjs src/model-picker-state.mjs src/codex-native-session.mjs src/target-integration.mjs src/start.mjs src/update.mjs src/control.mjs src/protocol-proof.mjs src/protocol-proof-verifier.mjs src/experimental-models.mjs test/fixtures/codex-model-catalog-0.147.schema.json test/fixtures/codex-model-catalog-0.149.schema.json test/catalog.test.mjs test/catalog-publication-lock.test.mjs test/refresh-catalog.test.mjs test/protocol-proof.test.mjs test/protocol-proof-verifier.test.mjs
git commit -m "feat: publish deterministic routed catalog"
```

### Task 5: Add pure CC Switch snippet and standalone-search doctor

**Files:**
- Create: `src/cc-switch-snippet.mjs`
- Create: `src/standalone-search-doctor.mjs`
- Modify: `src/doctor.mjs`
- Modify: `src/control.mjs`
- Create: `test/cc-switch-snippet.test.mjs`
- Create: `test/standalone-search-doctor.test.mjs`
- Test: `test/config-manager.test.mjs`
- Test: `test/doctor-routing-mode.test.mjs`

**Interfaces:**
- Produces: `renderAggregateSnippet({routedCatalogPath, callerBaseUrl}) -> string` for caller-authenticated local CLI/Swift/browser responses only.
- Produces: `aggregateSnippetStatus({routedCatalogPath, redactedBaseUrl}) -> object` for logs, doctor, snapshots, and support bundles.
- Produces: `standaloneSearchStatus(codexConfig) -> {ok, missing, snippet}`.
- Commands are read-only and never mutate Codex or CC Switch configuration.

- [ ] **Step 1: Write failing deterministic-render and no-write tests**

```js
test("authenticated aggregate snippet is deterministic and usable", () => {
  const first = renderAggregateSnippet(fixture);
  assert.equal(first, renderAggregateSnippet(fixture));
  assert.match(first, /routed-models\.json/);
  assert.match(first, /_codex-router\/[^/]+\/v1/);
});
```

Assert the protected snippet is returned only by caller-authenticated CLI output or authenticated Swift/browser sessions and never enters logs, doctor rows, snapshots, telemetry, exceptions, or support bundles. Status surfaces receive only `aggregateSnippetStatus()` with the redacted URL. The search status requires `web_search = "live"`, `suppress_unstable_features_warning = true`, and `[features].standalone_web_search = true`; missing fields produce the exact copyable snippet without writing files.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
node --test test/cc-switch-snippet.test.mjs test/standalone-search-doctor.test.mjs test/config-manager.test.mjs test/doctor-routing-mode.test.mjs
```

Expected: FAIL because the pure render/status modules do not exist.

- [ ] **Step 3: Implement redacted rendering and read-only status**

```js
export const SEARCH_CONFIG_SNIPPET = `web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
`;
```

Render the protected aggregate provider with the real local caller capability URL, `model_catalog_json` pointing to `ROUTED_CATALOG_PATH`, and `supports_standalone_web_search = true`. Accept only a redacted base URL in status/log/snapshot/support output and add decoy capability leakage tests across those surfaces.

- [ ] **Step 4: Add mutation guards**

Tests instrument `fs.writeFile`, CC Switch database access, and Codex config managers; invoking snippet/status/doctor must call none of them.

- [ ] **Step 5: Re-run focused and phase tests**

```bash
node --test test/cc-switch-snippet.test.mjs test/standalone-search-doctor.test.mjs test/config-manager.test.mjs test/doctor-routing-mode.test.mjs
node --test test/model-contract.test.mjs test/protocol-proof.test.mjs test/catalog.test.mjs
```

Expected: PASS with no network or live-state mutation.

- [ ] **Step 6: Commit read-only integration output**

```bash
git add src/cc-switch-snippet.mjs src/standalone-search-doctor.mjs src/doctor.mjs src/control.mjs test/cc-switch-snippet.test.mjs test/standalone-search-doctor.test.mjs test/config-manager.test.mjs test/doctor-routing-mode.test.mjs
git commit -m "feat: add cc switch and search status"
```

## Phase Verification

- [ ] Run `node --test test/model-contract.test.mjs test/protocol-proof.test.mjs test/protocol-proof-verifier.test.mjs test/catalog.test.mjs test/catalog-publication-lock.test.mjs test/cc-switch-snippet.test.mjs test/standalone-search-doctor.test.mjs`.
- [ ] Run `npm run check` and record pre-existing failures separately from Phase 1 regressions.
- [ ] Confirm no command contacted a provider or wrote outside test-owned temporary directories.
- [ ] Request review against Spec Appendices B, E, and F before starting Phase 2.
