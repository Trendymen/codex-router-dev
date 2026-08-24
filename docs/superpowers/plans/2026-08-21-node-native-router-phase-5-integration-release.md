# Node-Native Router Phase 5 Integration and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the pushed Node-only implementation through full tests, builds, isolated installation/migration, UI/runtime acceptance, optional explicitly approved live provider probes, and a reversible local release package without touching the managed installation.

**Architecture:** The reviewed Phase 1-4 implementation is committed and pushed before any actual build, install, service, app, browser, visual, or live validation. A compact acceptance matrix indexes named, independent, checked-in specialist oracles instead of copying specification prose; every specialist oracle owns an exact row set asserted by its own test. Every actual validation runs in isolated homes/ports/labels; failures first gain a unit regression, then a reviewed fix commit is pushed before the failed validation is repeated.

**Tech Stack:** Node.js 22.19+, Swift toolchain, macOS `launchd`, fixture HTTP servers, isolated `CODEX_HOME`, browser DevTools, Git/GitHub CLI.

**Spec:** `docs/superpowers/specs/2026-08-21-node-native-macos-router-design.md`

## Global Constraints

- Complete Appendices A-J and every Section 17 success criterion.
- Before Task 1 actual validation, reviewed implementation commits must exist on `github/main`.
- The current managed checkout, live LaunchAgents, CC Switch database, Codex config/auth, provider credential files, and ports remain untouched.
- Use isolated state roots, `CODEX_HOME`, app support, LaunchAgent labels, ports, key files, and browser profile.
- HTTP 200, process presence, test green, or command success alone never counts as runtime/visual acceptance.
- Live quota-consuming verification runs only when an explicit approval record is present; absence records `NOT RUN (quota approval absent)` and does not block non-live completion.
- Provider live acceptance is DeepSeek-only. Qwen, Bailian, and GLM live rows record `NOT RUN (out of current provider scope)`; their checked-in unit/fixture contracts remain required and must never issue a real request.
- Every Appendix A-J requirement is covered by a named, independent, checked-in specialist oracle whose own test asserts its exact row set. The compact acceptance matrix indexes those oracles, owners, and required evidence; it never copies specification prose or generates expected rows from production code.
- Every post-push defect receives a unit regression, implementation fix, scoped review, new commit, and another push before re-validation.
- Every pushed fix invalidates the full Node checks, Swift test/build, and artifact audit; rerun all three on the new pushed HEAD. In addition, installer/update/cleanup changes invalidate Task 2, runtime/protocol/security changes invalidate the relevant Task 3 scenarios, UI changes invalidate both affected layouts/appearances, and provider-wire changes invalidate the approved DeepSeek live probes. Final packaging occurs only after one complete baseline and all affected actual acceptance evidence share the same final pushed commit.
- A local release package may be built; deployment or managed-install replacement remains a separate user-approved operation.

---

## File Structure

- `test/acceptance/acceptance-matrix.json`: compact 36-theme index of specialist oracles, owners, required evidence, and runtime status.
- `test/acceptance/oracles/reasoning.json`: Appendix A reasoning lifecycle, legal fixtures, and error-code set.
- `test/fixtures/node-route-matrix.json`: Appendix B exact model/route matrix.
- `test/acceptance/oracles/tool-glm.json`: Appendix C tool, forced-buffer, GLM, continuation, and golden-vector rows.
- `test/acceptance/oracles/retry-failover.json`: Appendix D exact retry/failover decision rows.
- `test/acceptance/oracles/ownership-catalog.json`: Appendix E ownership, trigger, lock, atomicity, and snippet rows.
- `test/fixtures/required-capabilities.json`: Appendix F exact command/UI capability matrix.
- `test/acceptance/oracles/upgrade-platform.json`: Appendix G upgrade, preservation, cleanup, and platform rows.
- `test/acceptance/oracles/vision-allow.json`: Appendix H exact reader allow/exclude matrix.
- `test/acceptance/oracles/public-error.json`: Appendix I public errors, internal mappings, stream shapes, and redaction surfaces.
- `test/acceptance/oracles/browser-security.json`: Appendix J bootstrap, session, validation, confirmation, header, and security-test rows.
- `test/acceptance/oracles/testing-success.json`: Sections 15.1-15.5 bullets and Section 17.1-17.9 criteria.
- `scripts/prepare-acceptance-build.mjs`: materializes the exact reviewed Git HEAD below one isolation root, then creates a validated non-production ServiceTarget, in-root tool wrappers/context, and complete in-root build artifact tree without installing or launching anything.
- `scripts/verify-acceptance.mjs`: validates the static matrix plus per-evidence runtime report and binds final evidence to one pushed source commit.
- `scripts/verify-node-only-build.mjs`: built-artifact executable-path audit.
- `scripts/verify-isolated-install.mjs`: isolated install/service/UI contract harness.
- `scripts/verify-upgrade-preservation.mjs`: released-fixture migration/rollback harness.
- `generated/acceptance/`: gitignored logs, screenshots, reports, package manifests, and checksums.
- `docs/DEVELOPMENT.md`, `README.md`, `AGENTS.md`: final supported-product and validation commands.

### Task 1: Push the reviewed implementation baseline, then run full test/build validation

**Files:**
- Create: `test/acceptance/acceptance-matrix.json`
- Create: `test/acceptance/oracles/reasoning.json`
- Create: `test/acceptance/oracles/tool-glm.json`
- Create: `test/acceptance/oracles/retry-failover.json`
- Create: `test/acceptance/oracles/ownership-catalog.json`
- Create: `test/acceptance/oracles/upgrade-platform.json`
- Create: `test/acceptance/oracles/vision-allow.json`
- Create: `test/acceptance/oracles/public-error.json`
- Create: `test/acceptance/oracles/browser-security.json`
- Create: `test/acceptance/oracles/testing-success.json`
- Create: `test/acceptance/task-1-paths.txt`
- Delete if present: `test/acceptance/normative-requirements.json`
- Create: `scripts/verify-node-only-build.mjs`
- Create: `scripts/prepare-acceptance-build.mjs`
- Create: `scripts/verify-acceptance.mjs`
- Create: `scripts/verify-task-scope.mjs`
- Create: `test/acceptance-matrix.test.mjs`
- Create: `test/acceptance-oracles.test.mjs`
- Create: `test/prepare-acceptance-build.test.mjs`
- Create: `test/verify-acceptance.test.mjs`
- Create: `test/verify-task-scope.test.mjs`
- Modify: `test/reasoning-summary-compat.test.mjs`
- Modify: `test/model-contract.test.mjs`
- Modify: `test/tool-dialect.test.mjs`
- Modify: `test/anthropic-messages-adapter.test.mjs`
- Modify: `test/native-retry.test.mjs`
- Modify: `test/model-failover.test.mjs`
- Modify: `test/state-owner.test.mjs`
- Modify: `test/catalog-generation.test.mjs`
- Modify: `test/capability-contract.test.mjs`
- Modify: `test/protocol-proof-verifier.test.mjs`
- Modify: `test/upgrade-preservation.test.mjs`
- Modify: `test/platform-gate.test.mjs`
- Modify: `test/vision-bridge.test.mjs`
- Modify: `test/public-error-redaction.test.mjs`
- Modify: `test/panel-sessions.test.mjs`
- Modify: `test/desktop-panel.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadAcceptanceMatrix() -> AcceptanceTheme[]`, where every theme has `id`, `oracle`, `owners`, and `requiredEvidence[]`; each required-evidence row has `kind`, `initialState`, and `allowedNotRunReasons`, with no theme-level status.
- Produces: `loadAcceptanceOracle(path) -> AcceptanceOracle`, which validates one named oracle without deriving expected rows from production code.
- Produces: `prepareAcceptanceBuild({isolationRoot,sourceCommit}) -> acceptance-build.json`, containing canonical absolute `sourceRoot`, `fixtureContext`, `bundlePath`, and `buildRoot`; every path is below the same isolation root, the target uses non-production labels/ports, and it is build-only.
- Produces: `executeAcceptanceSwift({manifest,action,evidence})`, where `action` is `test-swift` or `build-swift`; it consumes only canonical paths from the manifest and is independent of caller cwd.
- Produces: `recordAcceptanceEvidence(entry) -> AcceptanceEvidence`, where every entry has `themeId`, `kind`, `state`, `reason`, `artifact`, and `sourceCommit`.
- Produces: `verifyAcceptance({matrix,evidence,sourceCommit,final}) -> VerificationFinding[]`.
- Produces: `beginFinalEvidence({evidence,sourceCommit})`, which starts a new final evidence generation and makes earlier-commit entries ineligible for `--final`.
- Produces: `verifyTaskScope({mode,allowedPaths}) -> ScopeFinding[]`, comparing either the worktree or staged path set to an exact allowlist.
- Produces: `verifyNodeOnlyBuild(artifactRoot) -> AuditFinding[]`.

- [ ] **Step 1: Write and run the specialist-oracle and compact-index tests before push**

Create exactly 36 acceptance themes. Appendix A contributes four themes (`reasoning-identity-state`, `reasoning-stream-final`, `reasoning-abort-nonstream`, `reasoning-errors`); B contributes two (`stable-routes`, `experimental-proof-gates`); C contributes three (`tool-names-conversion`, `forced-tool-boundaries`, `glm-messages-continuation`); D contributes two (`retry`, `failover`); E contributes two (`ownership-writes`, `catalog-lifecycle-atomicity`); F contributes two (`capability-command-ui`, `protocol-proof-lifecycle`); G contributes two (`upgrade-preservation`, `platform-removal`); H contributes one (`vision-allow`); I contributes two (`public-errors`, `redaction-leaks`); J contributes two (`write-sessions`, `browser-security`); Sections 15.1-15.5 contribute five; and Section 17.1-17.9 contribute nine.

Each theme names one checked-in specialist oracle above, real implementation owners, and exact required evidence classes. `test/acceptance-oracles.test.mjs` contains the independent expected row IDs for every oracle; it asserts complete equality with the oracle documents and never imports production tables to create expectations. The listed specialist tests are modified to consume and assert production behavior against the complete oracle row set: Appendix A → `test/reasoning-summary-compat.test.mjs`; B → `test/model-contract.test.mjs`; C → `test/tool-dialect.test.mjs` and `test/anthropic-messages-adapter.test.mjs`; D → `test/native-retry.test.mjs` and `test/model-failover.test.mjs`; E → `test/state-owner.test.mjs` and `test/catalog-generation.test.mjs`; F → `test/capability-contract.test.mjs` and `test/protocol-proof-verifier.test.mjs`; G → `test/upgrade-preservation.test.mjs` and `test/platform-gate.test.mjs`; H → `test/vision-bridge.test.mjs`; I → `test/public-error-redaction.test.mjs`; J → `test/panel-sessions.test.mjs` and `test/desktop-panel.test.mjs`. Each consumer iterates every applicable oracle row and performs a real production assertion; the independent row-set test still hard-codes expected row IDs.

Assert the compact matrix contains exactly the 36 named themes, every oracle path exists, every owner path exists, and every oracle is referenced. Assert no matrix row contains copied specification prose or per-requirement cartesian expansion. Runtime/UI/visual/isolated-install/live evidence starts `pending`; Qwen/Bailian/GLM live evidence is `NOT RUN (out of current provider scope)`, while DeepSeek live evidence remains pending. HTTP/test/build success never counts as visual acceptance. The obsolete 691-row normative manifest must be absent.

```bash
node --test test/acceptance-matrix.test.mjs test/acceptance-oracles.test.mjs test/prepare-acceptance-build.test.mjs test/verify-acceptance.test.mjs test/verify-task-scope.test.mjs
```

- [ ] **Step 2: Commit and push all reviewed Phase 1-4 code plus the acceptance harness**

```bash
git status --short
git diff --check
node scripts/verify-task-scope.mjs worktree --allow-file test/acceptance/task-1-paths.txt
git add -A --pathspec-from-file=test/acceptance/task-1-paths.txt
node scripts/verify-task-scope.mjs index --allow-file test/acceptance/task-1-paths.txt
git diff --quiet
test -z "$(git ls-files --others --exclude-standard)"
git commit -m "test: add node-native acceptance matrix"
git push github main
```

`test/acceptance/task-1-paths.txt` is a checked-in newline-delimited exact allowlist containing every Task 1 create/modify/delete path above, including itself and the obsolete manifest deletion. Abort if either scope verifier reports an extra or missing path, if any unstaged tracked or untracked file remains after staging, or if the worktree is non-empty after commit. Confirm remote `refs/heads/main` equals local `HEAD`. This push must happen before the remaining steps.

- [ ] **Step 3: After push, run the full Node checks**

```bash
node scripts/verify-acceptance.mjs run --profile task1-node-check --evidence generated/acceptance/evidence.json --artifact generated/acceptance/npm-check.log --source-commit "$(git rev-parse HEAD)" -- npm run check
node scripts/verify-acceptance.mjs run --profile task1-node-test --evidence generated/acceptance/evidence.json --artifact generated/acceptance/npm-test.log --source-commit "$(git rev-parse HEAD)" -- npm test
```

Record command, commit, exit code, pass/fail counts, and output path in `generated/acceptance/full-tests.md`.

- [ ] **Step 4: After push, compile and test Swift**

```bash
node scripts/prepare-acceptance-build.mjs prepare --isolation-root generated/acceptance/task1-build --source-commit "$(git rev-parse HEAD)" --evidence generated/acceptance/evidence.json
node scripts/prepare-acceptance-build.mjs test-swift --manifest generated/acceptance/task1-build/acceptance-build.json --evidence generated/acceptance/evidence.json
node scripts/prepare-acceptance-build.mjs build-swift --manifest generated/acceptance/task1-build/acceptance-build.json --evidence generated/acceptance/evidence.json
node scripts/prepare-acceptance-build.mjs finalize --manifest generated/acceptance/task1-build/acceptance-build.json --evidence generated/acceptance/evidence.json
```

`prepare` refuses any production label, default port, path outside the explicit isolation root, missing source entrypoint/asset, or non-empty root without its own acceptance marker. It copies tracked bytes and modes for the exact `sourceCommit` into the root, creates validated acceptance labels/ports, in-root wrappers, and a build-only fixture context, then writes canonical absolute paths to `acceptance-build.json`. `test-swift`, `build-swift`, and `finalize` accept only that manifest; `build-swift` invokes the copied source's build script with the manifest's absolute Bundle and fixture-context paths. `test/prepare-acceptance-build.test.mjs` executes these subcommands from a cwd outside both the repository and isolation root and proves they never depend on relative path resolution. No subcommand runs `open`, `launchctl`, setup, install, or update.

- [ ] **Step 5: Audit built artifacts**

```bash
node scripts/verify-acceptance.mjs run --profile task1-artifact-audit --evidence generated/acceptance/evidence.json --artifact generated/acceptance/artifact-audit.log --source-commit "$(git rev-parse HEAD)" -- node scripts/verify-node-only-build.mjs generated/acceptance/task1-build/build-root
```

Expected: no Python/LiteLLM/Rust/Tauri executable/import/dependency/service/release path; required Node Router, Swift app, browser assets, registry, and catalogs are present.

- [ ] **Step 6: Fix any failure through the mandatory post-push loop**

Write a failing unit regression, run it RED, implement the fix, run focused unit tests GREEN, obtain scoped review, commit, and push. On the new pushed HEAD rerun `npm run check`, `npm test`, Swift test/build, artifact audit, and the failed or otherwise invalidated actual validation from the matrix above. Never leave a validation fix unpushed.

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
- Both verification CLIs require `--evidence PATH` and append validated `{themeId,kind,state,reason,artifact,sourceCommit}` entries atomically.

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
node scripts/verify-isolated-install.mjs --root generated/acceptance/clean-install --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
```

Verify installer prerequisites, file modes, Node-only LaunchAgent arguments, service boot, protected caller auth, Router health, direct fixture routing on both transports, catalog publication, browser command contract, Swift command contract, stop/start/restart, and uninstall preservation.

- [ ] **Step 4: Run released-fixture upgrade and rollback cases**

```bash
node scripts/verify-upgrade-preservation.mjs --root generated/acceptance/upgrade --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
```

Verify success cleanup and forced failure at replacement install, bootstrap, Router health, browser contract, and Swift contract. Compare protected bytes/modes before/after and confirm old-service restoration on every failure.

- [ ] **Step 5: Apply the mandatory post-push fix loop for any failure**

Add a unit regression, review the fix, commit, and push. Rerun the full Node/Swift/artifact baseline on the new pushed HEAD, then repeat the failed Task 2 scenario and every Task 2 scenario affected by installer/update/cleanup changes.

### Task 3: Validate Router, browser, and Swift runtime/visual behavior

**Files:**
- Create: `scripts/acceptance-runtime.mjs`
- Create: `test/acceptance-runtime.test.mjs`
- Create at runtime only: `generated/acceptance/evidence.json`

**Interfaces:**
- Produces: `startAcceptanceRuntime(env) -> RuntimeHandle`.
- Produces: `runtimeAcceptanceReport(handle) -> AcceptanceReport`.
- Produces: `generated/acceptance/evidence.json` entries with `{themeId,kind,state,reason,artifact,sourceCommit}`. `state` is one of `passed`, `failed`, `pending`, or `not_run`; `not_run` requires an allowed reason.
- Produces: `finalNonLiveAcceptance({root,buildRoot,browserProfile,evidence,sourceCommit})`, rerunning all Task 3 non-live protocol/UI capture steps without reusing an older artifact.

- [ ] **Step 1: Unit-test runtime harness ownership and cleanup**

Assert it starts/stops only isolated labels/PIDs, never kills unknown port owners, redacts capability URLs, and always cleans children/browser profiles on failure.

```bash
node --test test/acceptance-runtime.test.mjs
```

- [ ] **Step 2: Commit and push the runtime harness before use**

```bash
git add scripts/acceptance-runtime.mjs test/acceptance-runtime.test.mjs
git commit -m "test: add runtime acceptance harness"
git push github main
```

- [ ] **Step 3: Exercise direct fixture routing and protocol behavior**

Run local upstream fixtures through the real isolated service. Verify streaming/non-streaming reasoning, tool call/output continuation, forced-tool boundaries, images, usage, abort, truncation, public errors, retry/failover decisions, native bypass, search forwarding, proof-gated canaries, and no LiteLLM process/port.

```bash
node scripts/acceptance-runtime.mjs start --root generated/acceptance/runtime --build-root generated/acceptance/task1-build/build-root --evidence generated/acceptance/evidence.json
node scripts/acceptance-runtime.mjs protocol --root generated/acceptance/runtime --evidence generated/acceptance/evidence.json
```

`start` writes only below the explicit root, uses validated non-production labels and ports, snapshots the known managed process/path set read-only, and prints a redacted runtime handle file. `protocol` consumes local fixture endpoints only and records one evidence entry per required runtime kind.

- [ ] **Step 4: Exercise browser write sessions in an isolated browser profile**

Verify nonce bootstrap, clean URL, cookie/CSRF/Origin/Host, replay, confirmations, credential input behavior, every visible supported control, absent unsupported controls, cache/security headers, logout/restart revocation, no console errors, and no sensitive values in history/storage/network/log snapshots.

```bash
node scripts/acceptance-runtime.mjs browser-session --root generated/acceptance/runtime --profile generated/acceptance/browser/profile --evidence generated/acceptance/evidence.json
```

The command prints the exact isolated loopback URL and profile path. Use the isolated Playwright browser session against that URL; do not reuse the operator browser profile. Save console/network/storage snapshots below `generated/acceptance/browser/`, then pass their paths to `record-visual` below.

- [ ] **Step 5: Inspect browser desktop and narrow-window layouts**

Capture screenshots under `generated/acceptance/browser/`; inspect overflow, clipping, inaccessible actions, disabled-vs-absent controls, secret-field affordances, confirmation flow, loading/error states, and capability-version incompatibility. Record visual findings separately from HTTP/tool success.

```bash
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind browser-desktop --artifact generated/acceptance/browser/desktop.png --verdict passed
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind browser-narrow --artifact generated/acceptance/browser/narrow.png --verdict passed
```

Each visual record also contains viewport, appearance, inspected states, reviewer identity, issues, and the exact pushed source commit; the command rejects a missing screenshot or an empty inspection list.

- [ ] **Step 6: Launch and inspect the isolated Swift app**

Verify menu sections, every supported action against fixture state, absent removed controls, Dynamic Island local settings, health/usage/error states, quota/confirmation labels, no crashes/log leaks, and visual layout in light/dark appearance. Store screenshots/logs under `generated/acceptance/swift/`.

```bash
node scripts/acceptance-runtime.mjs swift-session --root generated/acceptance/runtime --bundle "generated/acceptance/task1-build/build-root/Applications/Model Router.app" --evidence generated/acceptance/evidence.json
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind swift-light --artifact generated/acceptance/swift/light.png --verdict passed
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind swift-dark --artifact generated/acceptance/swift/dark.png --verdict passed
node scripts/acceptance-runtime.mjs stop --root generated/acceptance/runtime --evidence generated/acceptance/evidence.json
node scripts/verify-acceptance.mjs --matrix test/acceptance/acceptance-matrix.json --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
```

`swift-session` launches only the explicit built bundle with the isolated runtime environment and never installs a plist, opens the production app path, or uses a production label. `stop` owns only PIDs/labels from the runtime handle and refuses unknown owners.

- [ ] **Step 7: Apply the mandatory post-push fix loop for any failure**

Add a unit/source regression, review, commit, and push. Rerun the full Node/Swift/artifact baseline on the new pushed HEAD, then re-run the failed runtime/visual scenario and every affected Task 3 scenario. Every visual fix is rebuilt and re-inspected after its push.

### Task 4: Run explicitly approved live protocol proofs and Codex probes

**Files:**
- Create: `generated/acceptance/live-proofs.md` at runtime only
- Modify at runtime only: `generated/acceptance/evidence.json`

**Interfaces:**
- Consumes: the installed DeepSeek credential without reading or printing it.
- Produces: DeepSeek live evidence plus explicit non-DeepSeek `NOT RUN` rows. No Qwen, Bailian, or GLM proof record is created.

- [ ] **Step 1: Check for an explicit quota-approval record without prompting**

Accept only the current execution instruction or protected operator state that explicitly authorizes quota-consuming live probes. If absent, write `NOT RUN (quota approval absent)` for DeepSeek live rows and continue to Task 5. Independently write `NOT RUN (out of current provider scope)` for every Qwen, Bailian, and GLM live row.

```bash
node scripts/acceptance-runtime.mjs record-not-run --evidence generated/acceptance/evidence.json --providers deepseek --reason quota_approval_absent
```

Run this command only when approval is absent; when approval exists, Steps 2 and 4 must replace the DeepSeek pending rows with passed/failed evidence.

- [ ] **Step 2: Verify supported stable routes when approval exists**

For DeepSeek Flash and Pro only, verify declared transport, non-stream text/terminal, streaming reasoning final shape, auto function call, tool-result continuation, authoritative usage, standalone search, and no Chat fallback. Use the minimum requests needed to prove these boundaries.

```bash
node scripts/acceptance-runtime.mjs live-deepseek --root generated/acceptance/live --slugs deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro --evidence generated/acceptance/evidence.json --report generated/acceptance/live-proofs.md
```

The command first repeats the same probes against local fixtures, then permits network egress only to the configured DeepSeek endpoint. Any non-loopback, non-DeepSeek destination aborts before connection and records a failed isolation finding; credentials, provider bodies, prompts, reasoning, tool arguments, and capability URLs never enter the report.

- [ ] **Step 3: Record non-DeepSeek live proof rows as not run**

Do not run `protocol-proof verify` for Qwen, Bailian, or GLM slugs and do not enable any non-DeepSeek canary. Record `NOT RUN (out of current provider scope)` while retaining their checked-in unit/fixture oracle results as separate non-live evidence.

```bash
node scripts/acceptance-runtime.mjs record-not-run --evidence generated/acceptance/evidence.json --providers qwen-plan,bailian,glm --reason out_of_current_provider_scope
```

- [ ] **Step 4: Exercise real Codex CLI/Desktop in the isolated profile**

Using DeepSeek only, verify model catalog parsing, routed turn, tool boundary summary stability, tool-result continuation, image input where declared, and standalone search. Do not alter the operator's active CC Switch provider or live Codex config.

```bash
node scripts/acceptance-runtime.mjs codex-cli --root generated/acceptance/live --providers deepseek --evidence generated/acceptance/evidence.json
node scripts/acceptance-runtime.mjs codex-desktop-session --root generated/acceptance/live --providers deepseek --evidence generated/acceptance/evidence.json
node scripts/verify-acceptance.mjs --matrix test/acceptance/acceptance-matrix.json --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
```

Both commands create or reuse only the isolated `CODEX_HOME` and profile below the explicit root. The Desktop command prints the exact isolated launch instruction and evidence paths; the operator-facing app/config and active CC Switch selection remain read-only.

- [ ] **Step 5: Apply the mandatory post-push fix loop for any failure**

Add a sanitized fixture plus unit regression, review, commit, and push. Rerun the full Node/Swift/artifact baseline and affected Task 3 protocol scenarios on the new pushed HEAD, then repeat the approved failed DeepSeek live probe. Never store provider bodies, prompts, reasoning, arguments, credentials, or full capability URLs.

### Task 5: Finalize docs, package, review, and push all fixes

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/INSTALL.md`
- Modify or delete: `docs/DESKTOP-TRAY.md`
- Modify: `docs/HOW-IT-WORKS.md`
- Modify or replace with a Vision-only reader document: `docs/LOCAL-MODELS.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/package-release.sh`
- Create: `test/documentation-contract.test.mjs`
- Create: `test/workflow-contract.test.mjs`

**Interfaces:**
- Produces: macOS Node-only documentation, CI/release gates, and reversible local package metadata.

- [ ] **Step 1: Write failing docs/workflow contract unit tests**

Assert supported providers/transports, macOS-only scope, CC Switch ownership, search snippet, browser session model, Vision-only locals, no live-managed-install mutation, post-push acceptance commands, and no current-product Python/LiteLLM/Tauri/Windows/Linux instructions. The documentation contract scans `README.md`, `AGENTS.md`, and every tracked user-facing `docs/**/*.md`; it excludes only `docs/superpowers/**`, `docs/research/**`, `docs/benchmarks/**`, and explicitly named historical evidence directories. Rewrite or remove `docs/DESKTOP-TRAY.md`, `docs/HOW-IT-WORKS.md`, and `docs/LOCAL-MODELS.md` so they cannot advertise removed runtime/product paths, and update all inbound links. Assert workflows build/test Node+Swift and audit artifacts without removed runtime jobs, and assert `.github/workflows/python-lock.yml` and every equivalent Python-lock workflow are absent.

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
git add -A README.md AGENTS.md docs/DEVELOPMENT.md docs/INSTALL.md docs/DESKTOP-TRAY.md docs/HOW-IT-WORKS.md docs/LOCAL-MODELS.md .github/workflows/ci.yml .github/workflows/release.yml scripts/package-release.sh test/documentation-contract.test.mjs test/workflow-contract.test.mjs
git commit -m "docs: finalize node-native macos router"
git push github main
```

- [ ] **Step 5: Run independent final Spec and quality reviews before final evidence/package**

Create one bounded final review package for the complete implementation range, Spec, compact matrix, specialist oracles, current evidence report, and deferred/incident ledger. Dispatch two independent `reviewer` threads with the same scope ID: one `REVIEW_MODE: SPEC_COMPLIANCE`, one `REVIEW_MODE: CODE_QUALITY`, both `REVIEW_PHASE: INITIAL`. Any Critical or Important finding blocks the next step.

- [ ] **Step 6: Fix, commit, push, and re-review every final finding**

One combined fix wave handles all blocking findings. Each fix includes a unit regression and focused GREEN run before commit. Push the fix, then send each original reviewer `REVIEW_PHASE: RE_REVIEW` with its complete prior findings, scoped fix diff, and real focused evidence. Both reviewers must pass. After this step, no code or tracked document may change unless package validation fails and the workflow explicitly loops back here.

- [ ] **Step 7: On the last pushed commit, rebuild all evidence and the package**

```bash
git fetch github main
test "$(git rev-parse HEAD)" = "$(git rev-parse github/main)"
node scripts/verify-acceptance.mjs begin-final --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
node scripts/verify-acceptance.mjs run --profile task1-node-check --evidence generated/acceptance/evidence.json --artifact generated/acceptance/final-npm-check.log --source-commit "$(git rev-parse HEAD)" -- npm run check
node scripts/verify-acceptance.mjs run --profile task1-node-test --evidence generated/acceptance/evidence.json --artifact generated/acceptance/final-npm-test.log --source-commit "$(git rev-parse HEAD)" -- npm test
node scripts/prepare-acceptance-build.mjs prepare --isolation-root generated/acceptance/final-build --source-commit "$(git rev-parse HEAD)" --evidence generated/acceptance/evidence.json
node scripts/prepare-acceptance-build.mjs test-swift --manifest generated/acceptance/final-build/acceptance-build.json --evidence generated/acceptance/evidence.json
node scripts/prepare-acceptance-build.mjs build-swift --manifest generated/acceptance/final-build/acceptance-build.json --evidence generated/acceptance/evidence.json
node scripts/prepare-acceptance-build.mjs finalize --manifest generated/acceptance/final-build/acceptance-build.json --evidence generated/acceptance/evidence.json
node scripts/verify-acceptance.mjs run --profile task1-artifact-audit --evidence generated/acceptance/evidence.json --artifact generated/acceptance/final-artifact-audit.log --source-commit "$(git rev-parse HEAD)" -- node scripts/verify-node-only-build.mjs generated/acceptance/final-build/build-root
node scripts/verify-isolated-install.mjs --root generated/acceptance/final-clean-install --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
node scripts/verify-upgrade-preservation.mjs --root generated/acceptance/final-upgrade --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
node scripts/acceptance-runtime.mjs final-nonlive --root generated/acceptance/final-runtime --build-root generated/acceptance/final-build/build-root --browser-profile generated/acceptance/final-browser/profile --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)"
```

The `final-nonlive` command repeats the Task 3 protocol, browser, Swift, cleanup, screenshot capture, and evidence steps against the final commit. Inspect the newly captured browser desktop/narrow and Swift light/dark images, then record those four visual verdicts with `record-visual`; old screenshots cannot be rebound to the new commit.

```bash
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind browser-desktop --artifact generated/acceptance/final-browser/desktop.png --verdict passed
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind browser-narrow --artifact generated/acceptance/final-browser/narrow.png --verdict passed
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind swift-light --artifact generated/acceptance/final-runtime/swift/light.png --verdict passed
node scripts/acceptance-runtime.mjs record-visual --evidence generated/acceptance/evidence.json --kind swift-dark --artifact generated/acceptance/final-runtime/swift/dark.png --verdict passed
```

If DeepSeek live approval exists, run:

```bash
node scripts/acceptance-runtime.mjs live-deepseek --root generated/acceptance/final-live --slugs deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro --evidence generated/acceptance/evidence.json --report generated/acceptance/final-live-proofs.md
node scripts/acceptance-runtime.mjs codex-cli --root generated/acceptance/final-live --providers deepseek --evidence generated/acceptance/evidence.json
node scripts/acceptance-runtime.mjs codex-desktop-session --root generated/acceptance/final-live --providers deepseek --evidence generated/acceptance/evidence.json
```

If approval is absent, run:

```bash
node scripts/acceptance-runtime.mjs record-not-run --evidence generated/acceptance/evidence.json --providers deepseek --reason quota_approval_absent
```

In both cases run:

```bash
node scripts/acceptance-runtime.mjs record-not-run --evidence generated/acceptance/evidence.json --providers qwen-plan,bailian,glm --reason out_of_current_provider_scope
```

```bash
node scripts/verify-acceptance.mjs --matrix test/acceptance/acceptance-matrix.json --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)" --final
./scripts/package-release.sh --output generated/release
node scripts/verify-node-only-build.mjs generated/release
```

Record every command and count against the same final pushed commit, plus package path, SHA-256 checksums, manifest, prerequisites, install/rollback instructions, and all acceptance evidence. Do not deploy the package. If package generation/audit fails and a tracked fix is required, return to Step 6: fix, commit, push, re-review with both original reviewers, then repeat all of Step 7 on the new HEAD.

## Final Evidence

- [ ] `npm run check` and `npm test` evidence names the final pushed commit.
- [ ] Swift test/build and artifact-audit evidence names the same final pushed commit.
- [ ] Isolated clean-install, upgrade, rollback, uninstall, runtime, browser, Swift, and visual evidence is valid for and names the final pushed commit.
- [ ] DeepSeek live rows are either approved passed evidence or `NOT RUN (quota approval absent)`; Qwen, Bailian, and GLM live rows are `NOT RUN (out of current provider scope)`.
- [ ] The release package audit and checksums name the final pushed commit.
- [ ] The managed installation and operator-owned Codex/CC Switch state remain untouched.
- [ ] `node scripts/verify-acceptance.mjs --matrix test/acceptance/acceptance-matrix.json --evidence generated/acceptance/evidence.json --source-commit "$(git rev-parse HEAD)" --final` reports no missing, failed, stale, or disallowed evidence rows.
