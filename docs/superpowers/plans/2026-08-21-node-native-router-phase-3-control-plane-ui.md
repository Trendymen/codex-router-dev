# Node-Native Router Phase 3 Control Plane and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Swift tray and browser panel one complete, capability-driven Node command contract with secure browser mutations and a Vision-only local-model boundary.

**Architecture:** A checked-in independent capability oracle defines the shared product surface. `desktop-commands.mjs` owns validation and mutation; both UIs consume a schema-versioned snapshot and never infer support. Browser writes use one-use bootstrap nonces, short-lived sessions, CSRF, replay protection, and operation-bound confirmations.

**Tech Stack:** Node.js 22.19+, JSON Schema, native HTTP/cookies/crypto, browser JavaScript, Swift/AppKit/SwiftUI, `node:test`, Swift Testing.

**Spec:** `docs/superpowers/specs/2026-08-21-node-native-macos-router-design.md`

## Global Constraints

- Implement Appendices F, H, I, and J exactly.
- `capabilitySchemaVersion` is `1`; unknown major versions expose read-only incompatibility status and zero mutations.
- Node is the only owner of validation, credential writes, Router-state mutations, and returned snapshots.
- Unsupported provider, Python gateway, Tauri, signed-routing, login-free, and local-chat commands are absent, not disabled.
- Browser secrets never enter URLs, history, logs, referrers, snapshots, autocomplete, or serialized UI state.
- Dynamic Island remains a Swift-local presentation preference, not a shared Node capability.
- Before the first implementation push, run only unit/source tests; app launch and visual validation occur after push in Phase 5.

---

## File Structure

- `test/fixtures/required-capabilities.json`: independent Appendix F command/UI oracle.
- `src/capability-manifest.mjs`: schema-versioned supported feature and command snapshot.
- `src/desktop-commands.mjs`: sole shared command dispatcher and argument validator.
- `src/panel-sessions.mjs`: nonce/session/CSRF/replay/confirmation state.
- `src/desktop-panel.mjs`: panel HTTP policy and command bridge.
- `apps/desktop/ui/*`: browser presentation consuming the manifest.
- `apps/macos/ModelRouterTray/*`: Swift presentation consuming the same manifest.
- `src/vision-reader-policy.mjs`: one Appendix H allow matrix used everywhere.

### Task 1: Define the independent capability oracle and Node command contract

**Files:**
- Create: `test/fixtures/required-capabilities.json`
- Create: `src/capability-manifest.mjs`
- Modify: `src/desktop-commands.mjs`
- Modify: `src/control.mjs`
- Create: `test/capability-contract.test.mjs`
- Test: `test/desktop-commands.test.mjs`
- Test: `test/control.test.mjs`

**Interfaces:**
- Produces: `buildCapabilityManifest(snapshot) -> CapabilityManifestV1`.
- Produces: `runDesktopCommand(name, args, context) -> Promise<{ok,value}|{ok:false,error}>`.
- Produces: `desktopCommandDefinitions() -> ReadonlyMap<string, CommandDefinition>`.

- [ ] **Step 1: Check in the independent Appendix F oracle**

The fixture lists each shared capability, exact Node command names, Swift/browser presence, confirmation requirement, quota warning, and the inverse absence set. It is manually derived from Appendix F and never imported by production code.

- [ ] **Step 2: Write failing completeness and inverse-absence tests**

```js
test("Node command table exactly covers the independent oracle", () => {
  assert.deepEqual([...desktopCommandDefinitions().keys()].sort(), fixture.nodeCommands.sort());
  for (const removed of fixture.forbiddenCommands) assert.equal(desktopCommandDefinitions().has(removed), false);
});
```

Cover lifecycle; doctor/update/rollback; native status/usage; DeepSeek/Qwen credentials; provider/model/canary/proof; picker/catalog; subagents; failover; tool-result aging; usage; Vision; presence; and CC Switch status/snippet.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
node --test test/capability-contract.test.mjs test/desktop-commands.test.mjs test/control.test.mjs
```

- [ ] **Step 4: Implement schema-versioned manifest and validated commands**

```js
export const CAPABILITY_SCHEMA_VERSION = 1;
export async function runDesktopCommand(name, args, context) {
  const definition = COMMANDS.get(name);
  if (!definition) return failure(routerError("command_not_supported"));
  assertJsonSchema(definition.arguments, args);
  return success(await definition.execute(args, context));
}
```

Each command returns `{ok,value}` or Appendix I error; credential values are accepted through protected input and omitted from snapshots.

- [ ] **Step 5: Run unit tests and confirm GREEN**

```bash
node --test test/capability-contract.test.mjs test/desktop-commands.test.mjs test/control.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/required-capabilities.json src/capability-manifest.mjs src/desktop-commands.mjs src/control.mjs test/capability-contract.test.mjs test/desktop-commands.test.mjs test/control.test.mjs
git commit -m "feat: define shared desktop capabilities"
```

### Task 2: Implement browser write-session security

**Files:**
- Create: `src/panel-sessions.mjs`
- Modify: `src/caller-auth.mjs`
- Modify: `src/panel.mjs`
- Modify: `src/router.mjs`
- Modify: `src/desktop-panel.mjs`
- Create: `test/panel-sessions.test.mjs`
- Test: `test/caller-auth.test.mjs`
- Test: `test/panel.test.mjs`
- Test: `test/desktop-panel.test.mjs`

**Interfaces:**
- Produces: `createPanelSessionStore({clock, randomBytes, maxSessions: 8}) -> PanelSessionStore`.
- Produces: `mintBootstrapNonce(store) -> {nonce, expiresAt}`.
- Produces: `consumeBootstrapNonce(store, nonce) -> {sessionId, csrfToken}`.
- Produces: `validatePanelRequest(request, policy) -> PanelRequestContext`.

- [ ] **Step 1: Write failing nonce/session lifecycle tests**

```js
test("bootstrap nonce is atomically single use", async () => {
  const minted = store.mintNonce();
  const results = await Promise.allSettled([store.consumeNonce(minted.nonce), store.consumeNonce(minted.nonce)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
```

Cover 256-bit values, 30-second nonce TTL, 15-minute idle/60-minute absolute session TTL, eight-session cap with oldest-idle eviction, logout, restart revocation, session-specific CSRF, bounded request-ID replay, and previous-result return without repeated mutation.

- [ ] **Step 2: Write failing HTTP-policy tests**

Cover exact `127.0.0.1:<port>` Host/Origin, loopback peer, ignored forwarded headers, POST/JSON, cookie, CSRF, missing Origin, DNS rebinding reads, one-use bootstrap navigation, no CORS, exact cookie attributes, 303 clean redirect, cache headers, CSP, referrer, frame, MIME headers, and no third-party assets.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
node --test test/panel-sessions.test.mjs test/caller-auth.test.mjs test/panel.test.mjs test/desktop-panel.test.mjs
```

- [ ] **Step 4: Implement session and request policy before handlers**

```js
export function validatePanelRequest(request, {port, mutation = false}) {
  requireLoopbackPeer(request.socket.remoteAddress);
  requireExactHeader(request, "host", `127.0.0.1:${port}`);
  if (mutation) requireExactHeader(request, "origin", `http://127.0.0.1:${port}`);
}
```

Create `POST /<caller-capability>/panel-sessions`, `/panel-bootstrap/<nonce>`, `/panel/session`, logout/revoke, confirmation, and command endpoints in the required validation order.

- [ ] **Step 5: Implement operation-bound confirmation tokens**

Bind each 256-bit, one-use, 60-second token to session ID, exact command, and SHA-256 of JCS-canonical arguments. Consume before execution and reject mismatch/replay.

- [ ] **Step 6: Run unit tests and confirm GREEN**

```bash
node --test test/panel-sessions.test.mjs test/caller-auth.test.mjs test/panel.test.mjs test/desktop-panel.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/panel-sessions.mjs src/caller-auth.mjs src/panel.mjs src/router.mjs src/desktop-panel.mjs test/panel-sessions.test.mjs test/caller-auth.test.mjs test/panel.test.mjs test/desktop-panel.test.mjs
git commit -m "feat: secure browser panel mutations"
```

### Task 3: Make the browser panel capability-driven and complete

**Files:**
- Modify: `apps/desktop/ui/index.html`
- Modify: `apps/desktop/ui/app.js`
- Modify: `apps/desktop/ui/model.mjs`
- Modify: `src/desktop-panel.mjs`
- Test: `test/desktop-ui.test.mjs`
- Test: `test/desktop-panel.test.mjs`
- Create: `test/browser-capability-contract.test.mjs`

**Interfaces:**
- Consumes: `CapabilityManifestV1` and panel session endpoints.
- Produces: browser presentations for every `browser: true` oracle entry and no forbidden control.

- [ ] **Step 1: Write failing browser command-extraction tests**

Parse rendered controls and action bindings; compare command IDs to the independent fixture. Assert unknown schema major shows read-only incompatibility, destructive actions obtain server confirmation, quota actions label cost, and forbidden controls/text are absent.

- [ ] **Step 2: Add secret-handling source tests**

Assert API-key inputs have `autocomplete="off"`, values are never interpolated into URLs/history/storage/logging, browser state serialization strips secrets, and all external resource URLs are absent.

- [ ] **Step 3: Run unit/source tests and confirm RED**

```bash
node --test test/browser-capability-contract.test.mjs test/desktop-ui.test.mjs test/desktop-panel.test.mjs
```

- [ ] **Step 4: Replace static feature assumptions with manifest rendering**

```js
export function visibleSections(manifest) {
  if (manifest.capabilitySchemaVersion !== 1) return [readOnlyIncompatibility(manifest)];
  return manifest.capabilities.filter((item) => item.browser).map(renderCapability);
}
```

Fetch CSRF once per session into memory, attach request UUID to every mutation, and repeat previous results without duplicating UI effects.

- [ ] **Step 5: Run unit/source tests and confirm GREEN**

```bash
node --test test/browser-capability-contract.test.mjs test/desktop-ui.test.mjs test/desktop-panel.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ui/index.html apps/desktop/ui/app.js apps/desktop/ui/model.mjs src/desktop-panel.mjs test/browser-capability-contract.test.mjs test/desktop-ui.test.mjs test/desktop-panel.test.mjs
git commit -m "feat: align browser panel capabilities"
```

### Task 4: Make the Swift tray capability-driven and complete

**Files:**
- Modify: `apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift`
- Modify: `apps/macos/ModelRouterTray/Sources/Localization.swift`
- Modify: `apps/macos/ModelRouterTray/Tests/MenuBarSettingsTests.swift`
- Modify: `apps/macos/ModelRouterTray/Tests/LocalizationTests.swift`
- Create: `test/swift-capability-contract.test.mjs`

**Interfaces:**
- Consumes: `CapabilityManifestV1` and `desktop-commands.mjs` JSON results.
- Produces: Swift presentations for every `swift: true` oracle entry plus Swift-local Dynamic Island preferences.

- [ ] **Step 1: Write failing source-oracle and Swift fixture tests**

Extract command identifiers from Swift source and compare to the independent fixture. Cover unknown schema major, absent forbidden sections, quota/confirmation labels, error envelope decoding, credential non-retention, and Dynamic Island remaining local.

- [ ] **Step 2: Run pre-push unit/source tests and confirm RED**

```bash
node --test test/swift-capability-contract.test.mjs
```

Do not run `swift test` before the first implementation push; Phase 5 owns that actual build validation.

- [ ] **Step 3: Render supported controls from the manifest**

Add a decoded `CapabilitySnapshotV1`; unknown versions produce only health/version text. Delete unsupported provider, gateway/Python, Tauri/platform, signed-routing, login-free, and Local LLM sections rather than disabling them.

- [ ] **Step 4: Route every mutation through the Node command bridge**

Swift-local preferences remain in Swift. All Router mutations send command plus validated JSON arguments; no provider key is copied into Swift persisted state.

- [ ] **Step 5: Run pre-push unit/source tests and confirm GREEN**

```bash
node --test test/swift-capability-contract.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift apps/macos/ModelRouterTray/Sources/Localization.swift apps/macos/ModelRouterTray/Tests/MenuBarSettingsTests.swift apps/macos/ModelRouterTray/Tests/LocalizationTests.swift test/swift-capability-contract.test.mjs
git commit -m "feat: align swift tray capabilities"
```

### Task 5: Enforce the Vision-only local-model boundary

**Files:**
- Create: `src/vision-reader-policy.mjs`
- Modify: `src/vision-bridge.mjs`
- Modify: `src/vision-engines.mjs`
- Modify: `src/vision-bridge-state.mjs`
- Modify: `src/api-forwarder.mjs`
- Modify: `config/local/local.json`
- Modify: `config/lmstudio/lmstudio.json`
- Test: `test/vision-bridge.test.mjs`
- Test: `test/vision-bridge-state.test.mjs`
- Test: `test/vision-bridge-e2e.test.mjs`
- Test: `test/catalog.test.mjs`

**Interfaces:**
- Produces: `allowedVisionReaders(context) -> VisionReader[]`.
- Produces: `resolveVisionReader(selection, context) -> VisionReader | null`.
- All registry, catalog, UI, auto/pin/fallback, and request paths consume this policy.

- [ ] **Step 1: Write failing Appendix H matrix tests**

Cover native caller-session models, supported enabled/credentialed image models, explicitly pinned loopback Ollama/LM Studio/llama.cpp, auto exclusion of loopback and legacy providers, legacy pin rejection, and immediate native fail-closed after session loss.

- [ ] **Step 2: Add local-chat inverse tests**

Assert local/lmstudio generate no chat route, catalog/picker overlay, tools, subagent metadata, context claims, recommendation, speed/memory fit, or visible Local LLM section. Assert existing weight paths are never deletion targets.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
node --test test/vision-bridge.test.mjs test/vision-bridge-state.test.mjs test/vision-bridge-e2e.test.mjs test/catalog.test.mjs
```

- [ ] **Step 4: Implement one lazy allow policy and remove chat publication**

```js
export function allowedVisionReaders({callerSession, selectedNodeModels, localPin}) {
  return [
    ...nativeReaders(callerSession),
    ...selectedNodeModels.filter((model) => model.inputModalities.includes("image")),
    ...explicitLocalReader(localPin),
  ];
}
```

Preserve existing transcript caching, in-flight coalescing, failure evidence, newest-question behavior, user/function-result image handling, and no image-shaped forwarded parts.

- [ ] **Step 5: Run unit tests and confirm GREEN**

```bash
node --test test/vision-bridge.test.mjs test/vision-bridge-state.test.mjs test/vision-bridge-e2e.test.mjs test/catalog.test.mjs
```

- [ ] **Step 6: Run the Phase 3 pre-push unit/source gate**

```bash
node --test test/capability-contract.test.mjs test/desktop-commands.test.mjs test/panel-sessions.test.mjs test/desktop-panel.test.mjs test/browser-capability-contract.test.mjs test/swift-capability-contract.test.mjs test/vision-bridge.test.mjs test/vision-bridge-e2e.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/vision-reader-policy.mjs src/vision-bridge.mjs src/vision-engines.mjs src/vision-bridge-state.mjs src/api-forwarder.mjs config/local/local.json config/lmstudio/lmstudio.json test/vision-bridge.test.mjs test/vision-bridge-state.test.mjs test/vision-bridge-e2e.test.mjs test/catalog.test.mjs
git commit -m "feat: limit local models to vision reading"
```

## Phase Verification

- [ ] Before push, run only the named Node unit/source tests.
- [ ] Commit and push reviewed Phase 3 implementation.
- [ ] After push, run Swift compilation/tests, browser interaction, app launch, runtime security probes, and visual validation in Phase 5.
- [ ] Every post-push validation fix receives a unit regression, review, new commit, and another push.
