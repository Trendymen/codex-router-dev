# Node-Native Router Phase 5 Integration and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the pushed Node-only implementation through full tests, builds, isolated installation/migration, UI/runtime acceptance, optional explicitly approved live provider probes, and a reversible local release package without touching the managed installation.

**Architecture:** The reviewed Phase 1-4 implementation is committed and pushed before any actual build, install, service, app, browser, visual, or live validation. Every validation runs in isolated homes/ports/labels; failures first gain a unit regression, then a reviewed fix commit is pushed before the failed validation is repeated.

**Tech Stack:** Node.js 22.19+, Swift toolchain, macOS `launchd`, fixture HTTP servers, isolated `CODEX_HOME`, browser DevTools, Git/GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-21-node-native-macos-router-design.md`

## Global Constraints

- Complete Appendices A-J and every Section 17 success criterion.
- Before Task 1 actual validation, reviewed implementation commits must exist on `github/main`.
- The current managed checkout, live LaunchAgents, CC Switch database, Codex config/auth, provider credential files, and ports remain untouched.
- Use isolated state roots, `CODEX_HOME`, app support, LaunchAgent labels, ports, key files, and browser profile.
- HTTP 200, process presence, test green, or command success alone never counts as runtime/visual acceptance.
- Live quota-consuming verification runs only when an explicit approval record is present; absence records `NOT RUN (quota approval absent)` and does not block non-live completion.
- Every post-push defect receives a unit regression, implementation fix, scoped review, new commit, and another push before re-validation.
- A local release package may be built; deployment or managed-install replacement remains a separate user-approved operation.

---

## File Structure

- `test/acceptance/acceptance-matrix.json`: independent Spec success-criteria oracle.
- `scripts/verify-node-only-build.mjs`: built-artifact executable-path audit.
- `scripts/verify-isolated-install.mjs`: isolated install/service/UI contract harness.
- `scripts/verify-upgrade-preservation.mjs`: released-fixture migration/rollback harness.
- `generated/acceptance/`: gitignored logs, screenshots, reports, package manifests, and checksums.
- `docs/DEVELOPMENT.md`, `README.md`, `AGENTS.md`: final supported-product and validation commands.

### Task 1: Push the reviewed implementation baseline, then run full test/build validation

**Files:**
- Create: `test/acceptance/acceptance-matrix.json`
- Create: `scripts/verify-node-only-build.mjs`
- Create: `test/acceptance-matrix.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadAcceptanceMatrix() -> AcceptanceRequirement[]`.
- Produces: `verifyNodeOnlyBuild(artifactRoot) -> AuditFinding[]`.

- [ ] **Step 1: Write and run the acceptance-oracle unit test before push**

The fixture maps every Appendix A-J requirement, every Section 17 criterion, and Sections 15.1-15.5 category to a requirement ID, implementation owner, and exact unit, build, runtime, UI, visual, isolated-install, or live evidence. Assert every requirement has an owner and no evidence row treats HTTP/test/build success as visual acceptance.

```bash
node --test test/acceptance-matrix.test.mjs
```

- [ ] **Step 2: Commit and push all reviewed Phase 1-4 code plus the acceptance harness**

```bash
git status --short
git diff --check
git add test/acceptance/acceptance-matrix.json scripts/verify-node-only-build.mjs test/acceptance-matrix.test.mjs package.json
git commit -m "test: add node-native acceptance matrix"
git push github main
```

Phase 1-4 task commits must already be present and reviewed; abort if `git status --short` is non-empty after the exact acceptance-harness staging. Confirm remote `refs/heads/main` equals local `HEAD`. This push must happen before the remaining steps.

- [ ] **Step 3: After push, run the full Node checks**

```bash
npm run check
npm test
```

Record command, commit, exit code, pass/fail counts, and output path in `generated/acceptance/full-tests.md`.

- [ ] **Step 4: After push, compile and test Swift**

```bash
swift test --package-path apps/macos/ModelRouterTray
./scripts/build-macos-tray-app.sh
```

Record test counts and built app path; compilation alone does not satisfy visual/UI acceptance.

- [ ] **Step 5: Audit built artifacts**

```bash
node scripts/verify-node-only-build.mjs generated/build-root
```

Expected: no Python/LiteLLM/Rust/Tauri executable/import/dependency/service/release path; required Node Router, Swift app, browser assets, registry, and catalogs are present.

- [ ] **Step 6: Fix any failure through the mandatory post-push loop**

Write a failing unit regression, run it RED, implement the fix, run focused unit tests GREEN, obtain scoped review, commit, push, then repeat only the failed actual validation. Never leave a validation fix unpushed.

### Task 2: Validate isolated clean install, service, and reversible upgrade

**Files:**
- Create: `scripts/verify-isolated-install.mjs`
- Create: `scripts/verify-upgrade-preservation.mjs`
- Create: `test/isolated-install-harness.test.mjs`
- Create: `test/upgrade-harness.test.mjs`

**Interfaces:**
- Produces: `createIsolatedEnvironment(seed) -> IsolatedEnvironment`.
- Produces: `verifyCleanInstall(env) -> AcceptanceReport`.
- Produces: `verifyUpgradeAndRollback(env, releasedFixture) -> AcceptanceReport`.

- [ ] **Step 1: Unit-test harness isolation before use**

Assert generated `CODEX_HOME`, Router state, app support, Router/Tray LaunchAgent labels/plists, launch domain, service ports, browser profile, credential placeholders, and logs are isolated. Labels must differ from `io.github.codex-router` and `io.github.codex-router.tray`; paths must be below the gitignored environment root; ports must differ from production defaults. Abort before any `launchctl` or write if any label/path/port collides with the operator's live target.

```bash
node --test test/isolated-install-harness.test.mjs test/upgrade-harness.test.mjs
```

- [ ] **Step 2: Commit and push the harness before executing it**

```bash
git add scripts/verify-isolated-install.mjs scripts/verify-upgrade-preservation.mjs test/isolated-install-harness.test.mjs test/upgrade-harness.test.mjs
git commit -m "test: add isolated installation acceptance harness"
git push github main
```

- [ ] **Step 3: Run clean install in the isolated environment**

```bash
node scripts/verify-isolated-install.mjs --root generated/acceptance/clean-install
```

Verify installer prerequisites, file modes, Node-only LaunchAgent arguments, service boot, protected caller auth, Router health, direct fixture routing on both transports, catalog publication, browser command contract, Swift command contract, stop/start/restart, and uninstall preservation.

- [ ] **Step 4: Run released-fixture upgrade and rollback cases**

```bash
node scripts/verify-upgrade-preservation.mjs --root generated/acceptance/upgrade
```

Verify success cleanup and forced failure at replacement install, bootstrap, Router health, browser contract, and Swift contract. Compare protected bytes/modes before/after and confirm old-service restoration on every failure.

- [ ] **Step 5: Apply the mandatory post-push fix loop for any failure**

Add a unit regression, review the fix, commit, push, and then repeat the failed isolated scenario.

### Task 3: Validate Router, browser, and Swift runtime/visual behavior

**Files:**
- Create: `scripts/acceptance-runtime.mjs`
- Create: `test/acceptance-runtime.test.mjs`
- Modify: `test/acceptance/acceptance-matrix.json`

**Interfaces:**
- Produces: `startAcceptanceRuntime(env) -> RuntimeHandle`.
- Produces: `runtimeAcceptanceReport(handle) -> AcceptanceReport`.

- [ ] **Step 1: Unit-test runtime harness ownership and cleanup**

Assert it starts/stops only isolated labels/PIDs, never kills unknown port owners, redacts capability URLs, and always cleans children/browser profiles on failure.

```bash
node --test test/acceptance-runtime.test.mjs
```

- [ ] **Step 2: Commit and push the runtime harness before use**

```bash
git add scripts/acceptance-runtime.mjs test/acceptance-runtime.test.mjs test/acceptance/acceptance-matrix.json
git commit -m "test: add runtime acceptance harness"
git push github main
```

- [ ] **Step 3: Exercise direct fixture routing and protocol behavior**

Run local upstream fixtures through the real isolated service. Verify streaming/non-streaming reasoning, tool call/output continuation, forced-tool boundaries, images, usage, abort, truncation, public errors, retry/failover decisions, native bypass, search forwarding, proof-gated canaries, and no LiteLLM process/port.

- [ ] **Step 4: Exercise browser write sessions in an isolated browser profile**

Verify nonce bootstrap, clean URL, cookie/CSRF/Origin/Host, replay, confirmations, credential input behavior, every visible supported control, absent unsupported controls, cache/security headers, logout/restart revocation, no console errors, and no sensitive values in history/storage/network/log snapshots.

- [ ] **Step 5: Inspect browser desktop and narrow-window layouts**

Capture screenshots under `generated/acceptance/browser/`; inspect overflow, clipping, inaccessible actions, disabled-vs-absent controls, secret-field affordances, confirmation flow, loading/error states, and capability-version incompatibility. Record visual findings separately from HTTP/tool success.

- [ ] **Step 6: Launch and inspect the isolated Swift app**

Verify menu sections, every supported action against fixture state, absent removed controls, Dynamic Island local settings, health/usage/error states, quota/confirmation labels, no crashes/log leaks, and visual layout in light/dark appearance. Store screenshots/logs under `generated/acceptance/swift/`.

- [ ] **Step 7: Apply the mandatory post-push fix loop for any failure**

Add a unit/source regression, review, commit, push, and re-run the failed runtime or visual acceptance. Every visual fix is rebuilt and re-inspected after its push.

### Task 4: Run explicitly approved live protocol proofs and Codex probes

**Files:**
- Modify: `test/acceptance/acceptance-matrix.json`
- Create: `generated/acceptance/live-proofs.md` at runtime only

**Interfaces:**
- Consumes: installed provider credentials without reading or printing them.
- Produces: exact-slug proof records only through `protocol-proof verify SLUG --yes`.

- [ ] **Step 1: Check for an explicit quota-approval record without prompting**

Accept only the current execution instruction or protected operator state that explicitly authorizes quota-consuming live probes. If absent, write `NOT RUN (quota approval absent)` for every live row and continue to Task 5.

- [ ] **Step 2: Verify supported stable routes when approval exists**

For DeepSeek Flash/Pro, Qwen3.8 Max, resold DeepSeek Flash, and canonical GLM, verify declared transport, non-stream text/terminal, streaming reasoning final shape, auto function call, tool-result continuation, authoritative usage, standalone search, and no Chat fallback.

- [ ] **Step 3: Verify experimental slugs only through exact proof commands**

```bash
./bin/model-router codex protocol-proof verify SLUG --yes
```

Confirm direct declared transport, no retry/failover/alternate slug, passing proof fingerprint, atomic route/catalog/UI refresh, and revoke behavior. Do not enable every canary automatically.

- [ ] **Step 4: Exercise real Codex CLI/Desktop in the isolated profile**

Verify model catalog parsing, routed turn, tool boundary summary stability, tool-result continuation, image input where declared, and standalone search. Do not alter the operator's active CC Switch provider or live Codex config.

- [ ] **Step 5: Apply the mandatory post-push fix loop for any failure**

Add a sanitized fixture plus unit regression, review, commit, push, then repeat only the approved failed live probe. Never store provider bodies, prompts, reasoning, arguments, credentials, or full capability URLs.

### Task 5: Finalize docs, package, review, and push all fixes

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/DEVELOPMENT.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/package-release.sh`
- Create: `test/documentation-contract.test.mjs`
- Create: `test/workflow-contract.test.mjs`

**Interfaces:**
- Produces: macOS Node-only documentation, CI/release gates, and reversible local package metadata.

- [ ] **Step 1: Write failing docs/workflow contract unit tests**

Assert supported providers/transports, macOS-only scope, CC Switch ownership, search snippet, browser session model, Vision-only locals, no live-managed-install mutation, post-push acceptance commands, and no current-product Python/LiteLLM/Tauri/Windows/Linux instructions. Assert workflows build/test Node+Swift and audit artifacts without removed runtime jobs, and assert `.github/workflows/python-lock.yml` and every equivalent Python-lock workflow are absent.

- [ ] **Step 2: Run unit tests and confirm RED**

```bash
node --test test/documentation-contract.test.mjs test/workflow-contract.test.mjs
```

- [ ] **Step 3: Update docs and workflows, then confirm GREEN**

```bash
node --test test/documentation-contract.test.mjs test/workflow-contract.test.mjs
```

- [ ] **Step 4: Review, commit, and push docs/workflow changes before package execution**

```bash
git add README.md AGENTS.md docs/DEVELOPMENT.md .github/workflows/ci.yml .github/workflows/release.yml scripts/package-release.sh test/documentation-contract.test.mjs test/workflow-contract.test.mjs
git commit -m "docs: finalize node-native macos router"
git push github main
```

- [ ] **Step 5: Build the reversible local package after push**

```bash
./scripts/package-release.sh --output generated/release
node scripts/verify-node-only-build.mjs generated/release
```

Record package path, SHA-256 checksums, source commit, manifest, prerequisites, install/rollback instructions, and all acceptance evidence. Do not deploy the package.

- [ ] **Step 6: Run broad final code review**

Review the complete implementation range against the Spec and acceptance matrix. One fix wave handles all blocking findings, followed by one scoped re-review.

- [ ] **Step 7: Commit and push every final-review or package-validation fix**

Each fix includes a unit regression and focused GREEN run before commit. Push the fix, repeat the failed post-push validation, and confirm local/remote `main` point to the same commit.

## Final Evidence

- [ ] `npm run check` and `npm test` evidence names the pushed commit.
- [ ] Swift test/build evidence names the pushed commit.
- [ ] Isolated clean-install, upgrade, rollback, uninstall, runtime, browser, Swift, and visual evidence names the pushed commit.
- [ ] Live rows are either approved evidence or explicitly `NOT RUN (quota approval absent)`.
- [ ] The release package audit and checksums name the final pushed commit.
- [ ] The managed installation and operator-owned Codex/CC Switch state remain untouched.
