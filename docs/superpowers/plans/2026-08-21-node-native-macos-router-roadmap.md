# Node-Native macOS Router Program Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fork's LiteLLM/Tauri runtime with a macOS-only Node router that preserves supported provider protocols, exposes one safe command contract to Swift and browser UIs, and can be upgraded reversibly.

**Architecture:** Work is split into five dependency-ordered plans. Each phase ends in independently reviewable, non-live verification; stable third-party routing is not enabled until the protocol core is complete, and the old runtime is not removed until the Node service and both UI contracts pass.

**Tech Stack:** Node.js 22.19+, native `fetch`/HTTP/SSE, `node:test`, Swift/AppKit/SwiftUI, macOS `launchd`.

**Spec:** `docs/superpowers/specs/2026-08-21-node-native-macos-router-design.md`

## Global Constraints

- Develop only in `/Users/liuzhuo/webstorm_project/codex-router-dev`.
- Do not modify `/Users/liuzhuo/.local/share/codex-router`, live LaunchAgents, CC Switch data, `$CODEX_HOME/config.toml`, or provider credentials during implementation.
- Require Node.js `>=22.19.0`; the shipped product supports macOS only.
- Preserve provider credentials, history, retained results, backups, unsupported-provider secrets, and local model weights.
- Never route an `openai-responses` model through Chat Completions.
- Retry or model failover is legal only before the first relayed byte and only for Appendix D cases.
- Public errors and every diagnostic surface follow Appendix I redaction rules.
- Live provider requests and `protocol-proof verify` require explicit quota approval.
- Deployment to the current managed installation is outside these plans and requires separate user approval.

---

## Phase Order

| Phase | Plan | Independently testable deliverable | Entry gate | Exit gate |
| --- | --- | --- | --- | --- |
| 1 | `2026-08-21-node-native-router-phase-1-model-contract.md` | Strict model matrix, proof-gated canaries, deterministic routed catalog and CC Switch snippet | Accepted Spec | Registry/catalog/ownership tests pass; no live routes changed |
| 2 | `2026-08-21-node-native-router-phase-2-protocol-core.md` | Node Responses and Anthropic adapters, reasoning/tool normalization, bounded retry/failover | Phase 1 merged | Adapter/routing/error suites pass; stable routes use no LiteLLM |
| 3 | `2026-08-21-node-native-router-phase-3-control-plane-ui.md` | One capability-driven Node command contract, secure browser write sessions, aligned Swift/browser UIs, Vision-only local boundary | Phase 2 merged | Command oracle, panel security, Swift and Vision tests pass |
| 4 | `2026-08-21-node-native-router-phase-4-runtime-migration.md` | Node-only service/install/update/uninstall with reversible cleanup; Python/Rust/Tauri execution removed | Phases 2-3 merged | Dependency-removal and upgrade-preservation tests pass |
| 5 | `2026-08-21-node-native-router-phase-5-integration-release.md` | Full regression, isolated clean-install evidence, optional approved live proofs, reversible local package | Phases 1-4 merged | `npm run check`, `npm test`, Swift tests and isolated acceptance pass |

## Integration Rules

- Every task follows RED, GREEN, focused regression, review, then commit.
- Use temporary `CODEX_HOME`, Router state, ports, LaunchAgent labels, and app paths for integration tests.
- Never point an automated test at the operator's real state directory.
- Keep feature activation separate from implementation: experimental routes require exact-slug enable plus matching proof.
- Keep migration separate from deployment: Phase 4 proves migration against fixtures and isolated homes only.
- If a phase changes a public interface named by a later phase, update this roadmap and every dependent plan before implementation continues.

### Task 1: Complete Phase 1 model contract

**Files:**
- Execute: `docs/superpowers/plans/2026-08-21-node-native-router-phase-1-model-contract.md`

**Interfaces:**
- Produces: `ResolvedNodeModel`, `ProtocolProofRecord`, `buildRoutedCatalog()`, and deterministic CC Switch snippet output.
- Consumed by: Phase 2 transport selection and Phase 3 capability snapshots.

- [ ] **Step 1: Execute every Phase 1 task in order**

Run each task's named RED/GREEN commands and stop if registry startup validation or ownership tests fail.

- [ ] **Step 2: Run the Phase 1 gate**

```bash
node --test test/model-contract.test.mjs test/protocol-proof.test.mjs test/catalog.test.mjs test/cc-switch-snippet.test.mjs test/standalone-search-doctor.test.mjs
```

Expected: all pass without provider network calls and without writing outside temporary test directories.

- [ ] **Step 3: Request a scoped code review**

Review only Phase 1 commits against Appendix B, E, and F proof requirements before beginning Phase 2.

### Task 2: Complete Phase 2 protocol core

**Files:**
- Execute: `docs/superpowers/plans/2026-08-21-node-native-router-phase-2-protocol-core.md`

**Interfaces:**
- Consumes: `ResolvedNodeModel` and proof-gated route state from Phase 1.
- Produces: provider request builders, tool mappings, reasoning transforms, public errors, and direct routed dispatch.

- [ ] **Step 1: Execute every Phase 2 task in order**

Do not enable a stable route until its request, stream, non-stream, abort, tool, usage, and failure fixtures pass.

- [ ] **Step 2: Run the Phase 2 gate**

```bash
node --test test/public-error-redaction.test.mjs test/tool-dialect.test.mjs test/reasoning-summary-compat.test.mjs test/node-provider-adapter.test.mjs test/anthropic-messages-adapter.test.mjs test/model-failover-router.test.mjs test/routing.test.mjs
```

Expected: all pass using local fixture servers; assertions prove no stable third-party request reaches the LiteLLM gateway.

- [ ] **Step 3: Request a scoped code review**

Review Phase 2 against Appendices A, C, D, and I before UI work consumes the new snapshots.

### Task 3: Complete Phase 3 control plane and UIs

**Files:**
- Execute: `docs/superpowers/plans/2026-08-21-node-native-router-phase-3-control-plane-ui.md`

**Interfaces:**
- Consumes: model/route/proof snapshots and direct transport status.
- Produces: capability schema version 1, shared desktop commands, browser session protocol, Swift/browser presentation, and one Vision allow matrix.

- [ ] **Step 1: Execute every Phase 3 task in order**

Unknown capability major versions must remain read-only; no UI may retain a mutation absent from the Node command table.

- [ ] **Step 2: Run the Phase 3 gate**

```bash
node --test test/capability-contract.test.mjs test/desktop-commands.test.mjs test/panel-sessions.test.mjs test/desktop-panel.test.mjs test/desktop-ui.test.mjs test/vision-bridge.test.mjs test/vision-bridge-e2e.test.mjs
swift test --package-path apps/macos/ModelRouterTray
```

Expected: shared capabilities are complete in both UIs, removed controls are absent, and browser security fixtures pass.

- [ ] **Step 3: Request a scoped code review**

Review Phase 3 against Appendices F, H, and J, including leakage and replay cases.

### Task 4: Complete Phase 4 runtime migration

**Files:**
- Execute: `docs/superpowers/plans/2026-08-21-node-native-router-phase-4-runtime-migration.md`

**Interfaces:**
- Consumes: healthy direct routing and complete UI contracts.
- Produces: Node-only startup, macOS-only installation, reversible upgrade, closed-allowlist cleanup, and deterministic non-macOS refusal.

- [ ] **Step 1: Execute every Phase 4 task in order**

Keep old-runtime cleanup disabled until the isolated replacement service and both UI contracts report healthy.

- [ ] **Step 2: Run the Phase 4 gate**

```bash
node --test test/startup-cleanup.test.mjs test/dependency-removal.test.mjs test/upgrade-preservation.test.mjs test/target-isolation.test.mjs
```

Expected: fixtures preserve protected bytes and modes, rollback restores old service state, and executable Python/Rust/Tauri paths are absent.

- [ ] **Step 3: Request a scoped code review**

Review destructive path resolution, rollback ordering, and non-macOS no-write behavior against Appendix G.

### Task 5: Complete Phase 5 integration and local release

**Files:**
- Execute: `docs/superpowers/plans/2026-08-21-node-native-router-phase-5-integration-release.md`

**Interfaces:**
- Consumes: all prior phase outputs.
- Produces: independent acceptance evidence and a reversible local release package; does not deploy it.

- [ ] **Step 1: Execute non-live integration and clean-install tasks**

Use isolated homes and labels. A successful HTTP health response alone is not sufficient; exercise routing and both UI command contracts.

- [ ] **Step 2: Run optional live proofs only after explicit approval**

```bash
./bin/model-router codex protocol-proof verify SLUG --yes
```

Expected: one exact declared transport is tested with no fallback. Without approval, record this gate as not run rather than passing.

- [ ] **Step 3: Build but do not deploy the reversible package**

Record package path, checksums, test evidence, and rollback instructions. Do not replace the managed checkout or restart its LaunchAgents.

- [ ] **Step 4: Request final code and plan-conformance review**

Review all commits against the complete Spec and verify deployment remains a separate explicit action.
