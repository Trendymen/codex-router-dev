# Node-Native Router Phase 4 Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shipped service, installer, update, repair, and uninstall paths with a macOS Node/Swift runtime and safely retire fork-owned Python/LiteLLM/Rust/Tauri artifacts.

**Architecture:** First make startup and health Node-only, then implement deterministic platform refusal and a transaction-based upgrade. Migration snapshots exact bytes/modes, boots the replacement under isolated paths, verifies its contracts, and only then removes old artifacts through a closed allowlist; any failure restores the previous service.

**Tech Stack:** Node.js 22.19+, macOS `launchd`, shell installers, Swift app packaging, `node:test` filesystem/process fixtures.

**Spec:** `docs/superpowers/specs/2026-08-21-node-native-macos-router-design.md`

## Global Constraints

- Implement Appendix G exactly.
- No Python, pip, uv, LiteLLM, cargo, rustc, Rust/Tauri, or port-4200 executable path remains in shipped runtime/install/update/repair/uninstall/release artifacts.
- Non-macOS install/update/repair/service/panel-write/tray entry points fail before writes with `unsupported_platform` and exit code `2`.
- Cleanup resolves only a closed allowlist of fork-owned paths; no recursive broad glob is legal.
- Preserve credentials, history, backups, retained results, unsupported-provider secrets, local weights, CC Switch data, and non-Router Codex files byte-for-byte.
- Do not mutate the current managed installation in this phase; tests use fixtures and Phase 5 performs post-push isolated installation.
- Before the first implementation push, run only unit/fixture/source tests.

---

## File Structure

- `src/node-runtime.mjs`: child topology, health state, and shutdown for Node-only service.
- `src/platform-gate.mjs`: deterministic pre-write macOS gate.
- `src/service-target.mjs`: validated Router/Tray labels, plist paths, ports, app/state roots, and launch domain.
- `src/runtime-migration.mjs`: snapshot/install/health/cleanup/rollback transaction.
- `src/owned-runtime-paths.mjs`: closed old/new artifact allowlists and path resolution.
- `src/dependency-removal-audit.mjs`: static executable-path audit used by tests/CI.

### Task 1: Make startup and health Node-only

**Files:**
- Create: `src/node-runtime.mjs`
- Modify: `src/start.mjs`
- Modify: `src/router-health.mjs`
- Modify: `src/service.mjs`
- Modify: `src/service-macos.mjs`
- Test: `test/startup-cleanup.test.mjs`
- Test: `test/service-process.test.mjs`
- Create: `test/node-runtime.test.mjs`

**Interfaces:**
- Produces: `startNodeRuntime(config) -> Promise<NodeRuntime>`.
- Produces: `NodeRuntime.stop(signal?) -> Promise<void>`.
- Produces: `nodeRuntimeHealth(runtime) -> {router, forwarders, degraded}`.

- [ ] **Step 1: Write failing child-topology and health tests**

Assert startup contains Router and only required Node forwarders; it never resolves/spawns LiteLLM, Python venv, gateway supervisor, or port 4200. Assert owned-child startup failure stops already-started children, runtime gateway failure no longer exists, and forwarder/router failure still ends the service for `launchd` recovery.

- [ ] **Step 2: Run unit tests and confirm RED**

```bash
node --test test/node-runtime.test.mjs test/startup-cleanup.test.mjs test/service-process.test.mjs
```

- [ ] **Step 3: Implement one Node runtime owner**

```js
export async function startNodeRuntime(config) {
  const children = await startRequiredForwarders(config);
  const router = await startRouter(config);
  return createRuntime([...children, router]);
}
```

Health names only current Node dependencies and never reports a Python gateway row.

- [ ] **Step 4: Run unit tests and confirm GREEN**

```bash
node --test test/node-runtime.test.mjs test/startup-cleanup.test.mjs test/service-process.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/node-runtime.mjs src/start.mjs src/router-health.mjs src/service.mjs src/service-macos.mjs test/node-runtime.test.mjs test/startup-cleanup.test.mjs test/service-process.test.mjs
git commit -m "feat: start node-only router runtime"
```

### Task 2: Enforce macOS-only pre-write platform gates

**Files:**
- Create: `src/platform-gate.mjs`
- Create: `src/service-target.mjs`
- Modify: `src/paths.mjs`
- Modify: `src/service-macos.mjs`
- Modify: `src/tray-service-macos.mjs`
- Modify: `src/install-plan.mjs`
- Modify: `src/setup.mjs`
- Modify: `src/update.mjs`
- Modify: `src/dependency-repair.mjs`
- Modify: `src/service.mjs`
- Modify: `src/panel.mjs`
- Modify: `install.sh`
- Modify: `install.ps1`
- Create: `test/platform-gate.test.mjs`
- Test: `test/target-isolation.test.mjs`

**Interfaces:**
- Produces: `requireMacOS(operation, platform = process.platform) -> void`.
- Produces: `resolveServiceTarget(overrides) -> ServiceTarget` with production defaults and isolated acceptance overrides.
- Produces deterministic public error `unsupported_platform` and process exit code `2` at CLI boundaries.

- [ ] **Step 1: Write failing no-write platform tests**

Instrument filesystem, registry, Keychain, service, package-manager, network, and child-process functions. For Linux/Windows install, update, repair, service, panel-write, and tray entry points assert exit code 2, exact public code, and zero calls before refusal. Through the actual Router and Tray plist render/bootstrap interfaces, assert isolated labels, launch domain, plist paths, ports, app/state/support roots are used end-to-end and collision refusal occurs before write or `launchctl`.

- [ ] **Step 2: Run unit/source tests and confirm RED**

```bash
node --test test/platform-gate.test.mjs test/target-isolation.test.mjs
```

- [ ] **Step 3: Put the gate at every public entry before parsing plans or opening state**

```js
export function requireMacOS(operation, platform = process.platform) {
  if (platform !== "darwin") throw routerError("unsupported_platform", {operation, exitCode: 2});
}
```

`install.ps1` becomes a deterministic refusal wrapper and performs no checkout, dependency, state, or service work.

- [ ] **Step 4: Add validated isolated service targets**

Centralize Router/Tray labels, plist paths, launch domain, ports, app path, state root, and support root in `ServiceTarget`. Production defaults remain `io.github.codex-router` and `.tray`; overrides require explicit acceptance/test mode, labels matching a strict reverse-DNS pattern, loopback-only ports, and paths below the supplied isolated root. `service-macos.mjs`, `tray-service-macos.mjs`, update, install, runtime migration, and status all consume the same object. Tests invoke both real plist renderers and bootstrap command builders rather than testing only the pure target resolver.

Tests prove an isolated target cannot equal the production Router/Tray label, plist, app, state, support path, or port; any collision fails before `launchctl` or filesystem mutation.

- [ ] **Step 5: Run unit/source tests and confirm GREEN**

```bash
node --test test/platform-gate.test.mjs test/target-isolation.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/platform-gate.mjs src/service-target.mjs src/paths.mjs src/service-macos.mjs src/tray-service-macos.mjs src/install-plan.mjs src/setup.mjs src/update.mjs src/dependency-repair.mjs src/service.mjs src/panel.mjs install.sh install.ps1 test/platform-gate.test.mjs test/target-isolation.test.mjs
git commit -m "feat: enforce macos-only runtime"
```

### Task 3: Implement reversible upgrade and closed-allowlist cleanup

**Files:**
- Create: `src/owned-runtime-paths.mjs`
- Create: `src/runtime-migration.mjs`
- Modify: `src/update.mjs`
- Modify: `src/local-uninstall.mjs`
- Modify: `src/doctor.mjs`
- Create: `test/upgrade-preservation.test.mjs`
- Create: `test/runtime-migration.test.mjs`
- Create: `test/runtime-uninstall.test.mjs`

**Interfaces:**
- Produces: `snapshotOwnedRuntime(paths) -> RuntimeSnapshot`.
- Produces: `migrateRuntime({snapshot, installReplacement, verifyReplacement, cleanupOld}) -> Promise<MigrationResult>`.
- Produces: `resolveOwnedArtifact(id, roots) -> absolutePath`.

- [ ] **Step 1: Write failing preservation and path-safety tests**

Fixtures include current released installation bytes/modes plus decoy credentials, history, backups, retained results, CC Switch/Codex settings, unsupported secrets, and local weights. Assert allowed files change as expected, protected fixtures remain byte-identical, symlink/path traversal escapes fail, and broad/wildcard deletion APIs are never called.

- [ ] **Step 2: Write failing rollback-order tests**

Cover replacement install failure, launch bootstrap failure, Router health failure, browser contract failure, and Swift command-contract failure. Assert old files/modes/LaunchAgent bytes restore and the old service is restarted before returning failure; old cleanup never runs.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
node --test test/runtime-migration.test.mjs test/upgrade-preservation.test.mjs test/runtime-uninstall.test.mjs
```

- [ ] **Step 4: Implement the transaction**

```js
export async function migrateRuntime(steps) {
  const snapshot = await steps.snapshot();
  try {
    await steps.installReplacement();
    await steps.verifyReplacement();
    await steps.cleanupOld();
    return {ok: true};
  } catch (error) {
    await steps.restore(snapshot);
    await steps.restartOldService();
    throw error;
  }
}
```

Cleanup begins only after Node service health and both UI command contracts pass. Uninstall removes only service/app/runtime/catalog ownership rows and preserves protected state unless a separate explicit deletion operation exists.

- [ ] **Step 5: Run unit tests and confirm GREEN**

```bash
node --test test/runtime-migration.test.mjs test/upgrade-preservation.test.mjs test/runtime-uninstall.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/owned-runtime-paths.mjs src/runtime-migration.mjs src/update.mjs src/local-uninstall.mjs src/doctor.mjs test/runtime-migration.test.mjs test/upgrade-preservation.test.mjs test/runtime-uninstall.test.mjs
git commit -m "feat: add reversible node runtime migration"
```

### Task 4: Remove Python/LiteLLM/Rust/Tauri and unsupported targets

**Files:**
- Delete: `requirements/python.in`
- Delete: `requirements/python.txt`
- Delete: `src/litellm-config.mjs`
- Delete: `src/gateway-supervisor.mjs`
- Delete: `src/venv-runtime.mjs`
- Delete: `apps/desktop/src-tauri/**`
- Delete: `apps/electron/**`
- Delete: `.github/workflows/python-lock.yml`
- Delete: `bin/lock-python`
- Delete: `scripts/verify-python-lock.py`
- Delete: `scripts/verify-zai-litellm-usage.mjs`
- Delete: `packaging/homebrew/check-formula.mjs`
- Delete: `packaging/homebrew/generate-formula.mjs`
- Delete: `test/gateway-restart.test.mjs`
- Delete: `test/gateway-supervisor.test.mjs`
- Delete: `test/python-lock.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `package.json`
- Modify: `install.sh`
- Modify: `Formula/codex-router.rb`
- Modify: `src/install-plan.mjs`
- Modify: `src/doctor.mjs`
- Modify: `src/support-bundle.mjs`
- Modify: `src/target-integration.mjs`
- Modify: `scripts/build-macos-tray-app.sh`
- Create: `src/dependency-removal-audit.mjs`
- Create: `test/dependency-removal.test.mjs`

**Interfaces:**
- Produces: `auditRemovedRuntime(root) -> AuditFinding[]`.
- Shipped target is Codex CLI/Desktop on macOS; DSH/Gemini publication and Tauri/Electron packaging are absent.

- [ ] **Step 1: Write failing static executable-path audit**

```js
test("shipped files contain no removed runtime execution", async () => {
  assert.deepEqual(await auditRemovedRuntime(repoRoot), []);
});
```

Scan executable imports, spawn commands, locks/install requirements, service args, package dependencies/scripts, every workflow including forbidden Python-lock workflow names, release artifacts, Formula/Homebrew generators, health/doctor rows, and visible command/UI identifiers. Allow historical design evidence only in non-executable docs or inert fixtures.

- [ ] **Step 2: Run unit/source tests and confirm RED**

```bash
node --test test/dependency-removal.test.mjs
```

- [ ] **Step 3: Remove runtime/package paths and narrow target handling**

Delete only files identified by Appendix G and preserve browser static assets needed by `desktop-panel.mjs`. Replace Electron/Tauri test harness assumptions with browser-static source tests before deleting their package trees.

- [ ] **Step 4: Update doctor/support/install metadata**

Report Node Router, supported provider credentials/routes, catalog freshness, Swift app, browser capability contract, and search gate. Remove Python/Tauri checks and redact all retained state paths.

- [ ] **Step 5: Run unit/source tests and confirm GREEN**

```bash
node --test test/dependency-removal.test.mjs test/platform-gate.test.mjs test/target-isolation.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add requirements/python.in requirements/python.txt src/litellm-config.mjs src/gateway-supervisor.mjs src/venv-runtime.mjs apps/desktop/src-tauri apps/electron .github/workflows/python-lock.yml .github/workflows/ci.yml .github/workflows/release.yml bin/lock-python scripts/verify-python-lock.py scripts/verify-zai-litellm-usage.mjs packaging/homebrew/check-formula.mjs packaging/homebrew/generate-formula.mjs test/gateway-restart.test.mjs test/gateway-supervisor.test.mjs test/python-lock.test.mjs package.json install.sh Formula src/install-plan.mjs src/doctor.mjs src/support-bundle.mjs src/target-integration.mjs scripts/build-macos-tray-app.sh src/dependency-removal-audit.mjs test/dependency-removal.test.mjs
git commit -m "refactor: remove legacy router runtimes"
```

### Task 5: Update macOS service packaging and unit fixtures

**Files:**
- Modify: `src/service-macos.mjs`
- Modify: `src/install-plan.mjs`
- Modify: `scripts/build-macos-tray-app.sh`
- Create: `scripts/package-release.sh`
- Create: `test/service-macos-node-only.test.mjs`
- Modify: `test/install-plan.test.mjs`
- Create: `test/node-only-package.test.mjs`

**Interfaces:**
- Produces: Node-only LaunchAgent arguments/environment and a package manifest containing Node Router, Swift app, browser assets, registry, and no removed runtime.

- [ ] **Step 1: Write failing LaunchAgent/package manifest tests**

Assert one Router service with no gateway/LiteLLM/Python variables or port 4200; private files/modes; preserved caller/internal keys; Swift app/browser assets present; removed runtimes absent; install plan checks Node `>=22.19.0` numerically.

- [ ] **Step 2: Run unit/source tests and confirm RED**

```bash
node --test test/service-macos-node-only.test.mjs test/install-plan.test.mjs test/node-only-package.test.mjs
```

- [ ] **Step 3: Implement Node-only service and package manifests**

Keep app icon generation out of the tray build. Do not run packaging, `launchctl`, app launch, or actual install before the implementation push.

- [ ] **Step 4: Run unit/source tests and confirm GREEN**

```bash
node --test test/service-macos-node-only.test.mjs test/install-plan.test.mjs test/node-only-package.test.mjs
```

- [ ] **Step 5: Run the Phase 4 pre-push unit/source gate**

```bash
node --test test/node-runtime.test.mjs test/platform-gate.test.mjs test/runtime-migration.test.mjs test/upgrade-preservation.test.mjs test/runtime-uninstall.test.mjs test/dependency-removal.test.mjs test/node-only-package.test.mjs test/target-isolation.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/service-macos.mjs src/install-plan.mjs scripts/build-macos-tray-app.sh scripts/package-release.sh test/service-macos-node-only.test.mjs test/install-plan.test.mjs test/node-only-package.test.mjs
git commit -m "build: package macos node-only router"
```

## Phase Verification

- [ ] Before push, run only the named Node unit/fixture/source tests.
- [ ] Commit and push reviewed Phase 4 implementation before invoking build, package, installer, `launchctl`, app, runtime, or visual checks.
- [ ] Phase 5 performs all actual migration and clean-install validation in isolated homes; the managed installation remains untouched.
- [ ] Every post-push validation fix receives a unit regression, review, new commit, and another push.
