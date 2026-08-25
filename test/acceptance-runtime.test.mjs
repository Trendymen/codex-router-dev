import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isolationLeasePath } from "../scripts/verify-isolated-install.mjs";
import { createIsolatedEnvironment } from "../scripts/verify-isolated-install.mjs";
import { prepareAcceptanceBuild } from "../scripts/prepare-acceptance-build.mjs";
import {
  assertPushedRuntimeHarness,
  assertControlOwnership,
  assertRuntimeHandle,
  createRuntimeFixture,
  completedSessionArtifact,
  completedTask3ReportsOrPending,
  finalNonLiveAcceptance,
  finalNonLiveBrowserProfile,
  finalTask3RequirementIds,
  protocolAuthorizationPredicates,
  protocolLabEnvironment,
  noOwnedLiteLlmOr4200,
  removeCaptureRoots,
  runtimeCaptureRoot,
  runtimeAcceptanceReport,
  runtimeRootForArtifact,
  readCompletedSessionArtifact,
  runAcceptanceRuntimeCli,
  sanitizeRuntimeHandle,
  startAcceptanceRuntime,
  validateVisualRecord,
  verifiedSwiftBundle,
} from "../scripts/acceptance-runtime.mjs";

const commit = "a".repeat(40);
function root() { return mkdtempSync(path.join(os.tmpdir(), "acceptance-runtime-")); }
let task1Fixture;
function currentTask1Fixture() {
  if (task1Fixture) return task1Fixture;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), isolationRoot = mkdtempSync(path.resolve("generated/acceptance/task3-test-task1-"));
  const manifest = prepareAcceptanceBuild({ isolationRoot, sourceCommit, dryRun: true });
  mkdirSync(manifest.bundlePath, { recursive: true, mode: 0o700 });
  return task1Fixture = Object.freeze({ manifestPath: path.join(isolationRoot, "acceptance-build.json"), manifest, sourceCommit });
}
function handle(dir, overrides = {}) {
  const ports = { router: 49222 };
  const captureRoots = { browser: path.join(path.dirname(dir), `browser-${path.basename(dir)}`), swift: path.join(path.dirname(dir), `swift-${path.basename(dir)}`) };
  return {
    owner: "codex-router-phase5-runtime-v1", sourceCommit: commit, root: dir, handlePath: path.join(dir, "runtime-handle.json"), runtimeId: "runtime-test",
    socket: path.join(dir, "runtime-control.sock"), socketIdentity: { dev: 3, ino: 4 }, handshake: { path: path.join(dir, "runtime-handshake"), identity: { dev: 5, ino: 6 } },
    router: { pid: process.pid, workerPid: process.pid, startedAt: Date.now(), port: 49222, label: "io.github.codex-router.acceptance-runtime-test", routerIdentity: { pid: process.pid, digest: "b".repeat(64) }, workerIdentity: { pid: process.pid, digest: "c".repeat(64) } },
    lease: { path: isolationLeasePath(ports).lock, normalized: isolationLeasePath(ports).normalized, identity: { dev: 1, ino: 2 }, ports: [49222] }, captureRoots, profile: path.join(captureRoots.browser, "profile"), artifacts: { report: path.join(dir, "evidence", "runtime.json") }, ...overrides,
  };
}

async function waitFor(predicate, message, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(message);
}
async function control(handleValue, command) {
  const { default: net } = await import("node:net"), handshake = JSON.parse(readFileSync(handleValue.handshake.path, "utf8"));
  return new Promise((resolve, reject) => { const client = net.createConnection(handleValue.socket); let body = ""; client.setEncoding("utf8"); client.on("data", (value) => { body += value; }); client.once("error", reject); client.once("end", () => resolve(JSON.parse(body))); client.once("connect", () => client.end(`${JSON.stringify({ version: 1, command, runtimeId: handleValue.runtimeId, token: handshake.token })}\n`)); });
}

test("runtime handle only accepts exact lease and closed fields", () => {
  const dir = root(), value = handle(dir);
  assert.doesNotThrow(() => assertRuntimeHandle(value));
  assert.throws(() => assertRuntimeHandle({ ...value, lease: { ...value.lease, path: path.join(dir, "lease.json") } }), /lease/i);
  assert.throws(() => assertRuntimeHandle({ ...value, unknown: true }), /schema/i);
  assert.throws(() => assertRuntimeHandle({ ...value, handshake: { ...value.handshake, token: "must-not-store" } }), /schema/i);
});

test("Task3 provider fixture is loopback-only and records no payload", async () => {
  const fixture = await createRuntimeFixture();
  try {
    const response = await fetch(`${fixture.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", input: "not retained", stream: true }) });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(fixture.attempts[0]).sort(), ["accepted", "method", "model", "path", "reason", "transport"]);
    assert.doesNotMatch(JSON.stringify(fixture.attempts), /retained|input|body|prompt/i);
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});

test("nested protocol Router receives a closed lab environment, not its parent's credentials", () => {
  const dir = root(), parent = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: "/private/real-home",
    CODEX_HOME: "/private/real-codex",
    DEEPSEEK_API_KEY: "parent-deepseek-secret",
    HTTPS_PROXY: "https://parent-proxy.invalid",
    MODEL_ROUTER_CODEX_AUTH: "/private/real-auth.json",
    NODE_OPTIONS: "--require /private/real-hook.js",
  };
  const env = protocolLabEnvironment({ root: dir, stateRoot: path.join(dir, "state"), port: 49101, providerPort: 49102, nativePort: 49103, callerKey: "a".repeat(64), parent });
  assert.equal(env.PATH, parent.PATH);
  assert.equal(env.HOME, path.join(dir, "protocol-home"));
  assert.equal(env.CODEX_HOME, path.join(dir, "protocol-codex-home"));
  assert.equal(env.CODEX_ROUTER_NATIVE_SESSION_FALLBACK, "0");
  assert.match(env.MODEL_ROUTER_CODEX_AUTH, /protocol-missing-auth\.json$/);
  assert.equal(env.DEEPSEEK_API_KEY, "task3-loopback");
  for (const secret of ["HTTPS_PROXY", "NODE_OPTIONS"]) assert.equal(Object.hasOwn(env, secret), false);
  assert.doesNotMatch(JSON.stringify(env), /parent-(?:deepseek-secret|proxy)|real-(?:home|codex|auth|hook)/);
});

test("runtime capture root is a private canonical sibling bound to the runtime id", () => {
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-capture-test-"));
  const capture = runtimeCaptureRoot(dir, "worker-0123456789abcdef");
  assert.equal(path.dirname(capture), path.dirname(dir));
  assert.match(path.basename(capture), /^task3-browser-task3-capture-test-[A-Za-z0-9-]+-worker-0123456789abcdef$/);
  assert.equal(realpathSync(capture), capture);
  assert.equal(statSync(capture).mode & 0o077, 0);
  assert.throws(() => runtimeCaptureRoot(dir, "runtime-test"), /runtime id/i);
});

test("4200 probe excludes a foreign owner but rejects any Task3-owned listener or LiteLLM command", () => {
  assert.equal(noOwnedLiteLlmOr4200({ ownerPids: [35608], ownedPids: [101, 102], commands: ["node src/router.mjs"] }), true);
  assert.equal(noOwnedLiteLlmOr4200({ ownerPids: [102], ownedPids: [101, 102], commands: ["node src/router.mjs"] }), false);
  assert.equal(noOwnedLiteLlmOr4200({ ownerPids: [], ownedPids: [101], commands: ["python litellm"] }), false);
});

test("Task3 fixture abort closes a slow stream without retaining request content", async () => {
  const abort = new AbortController(), fixture = await createRuntimeFixture({ signal: abort.signal, slowStreams: true });
  const controller = new AbortController();
  try {
    const response = await fetch(`${fixture.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", input: "not retained", stream: true }), signal: controller.signal });
    await response.body.getReader().read(); controller.abort(); abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fixture.attempts[0].transport, "responses");
    assert.doesNotMatch(JSON.stringify(fixture.attempts), /retained|input|body|prompt/i);
  } finally { try { await new Promise((resolve) => fixture.server.close(resolve)); } catch {} }
});

test("sanitizeRuntimeHandle reconstructs a closed handle without capabilities", () => {
  const dir = root();
  const safe = sanitizeRuntimeHandle(handle(dir, { callerKey: "abcdefghijklmnopqrstuvwxyz0123456789", callerUrl: "http://127.0.0.1:49222/_codex-router/secret/v1", requestBody: "must-not-store" }));
  const text = JSON.stringify(safe);
  assert.doesNotMatch(text, /secret|abcdefghijklmnopqrstuvwxyz0123456789|must-not-store/i);
  assert.throws(() => assertRuntimeHandle({ ...safe, unexpected: "field" }), /schema/i);
  assert.throws(() => assertRuntimeHandle({ ...safe, root: path.join(dir, "..") }), /isolated root|handle path/i);
});

test("runtime report refuses symlinked and production-labelled handle files", () => {
  const dir = root(), value = sanitizeRuntimeHandle(handle(dir));
  mkdirSync(path.dirname(value.handlePath), { recursive: true }); writeFileSync(value.handlePath, JSON.stringify(value), { mode: 0o600 });
  assert.equal(runtimeAcceptanceReport(value.handlePath, { verifyIdentity: false }).status, "running");
  const linked = path.join(dir, "linked.json"); symlinkSync(value.handlePath, linked);
  assert.throws(() => runtimeAcceptanceReport(linked), /symlink/i);
  writeFileSync(value.handlePath, JSON.stringify({ ...value, router: { ...value.router, label: "io.github.codex-router" } }), { mode: 0o600 });
  assert.throws(() => runtimeAcceptanceReport(value.handlePath), /production label/i);
});

test("control ownership rejects a replaced lease, socket, and reused process identity", () => {
  const dir = root(), value = handle(dir);
  const identity = (pid) => ({ pid, digest: pid === value.router.pid ? "d".repeat(64) : "e".repeat(64) });
  assert.throws(() => assertControlOwnership(value, { inspect: identity }), /ENOENT|lease/i);
  const lease = isolationLeasePath(value.lease.ports); mkdirSync(path.dirname(lease.lock), { recursive: true }); writeFileSync(lease.lock, "owned", { mode: 0o600 });
  try {
    assert.throws(() => assertControlOwnership(value, { inspect: identity }), /replaced lease/i);
    assert.throws(() => assertControlOwnership({ ...value, lease: { ...value.lease, identity: { ...value.lease.identity, ino: 9 } } }, { inspect: identity }), /replaced lease/i);
  } finally { unlinkSync(lease.lock); }
});

test("runtime recorder is private and names exactly eight rows", () => {
  const source = readFileSync(new URL("../scripts/acceptance-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /const RUNTIME_ROWS = Object\.freeze\(\{ r06:.*r55:/s);
  assert.doesNotMatch(source, /export function recordRuntimeEvidence/);
  assert.match(source, /recordRuntimeRowsAtomically/);
  assert.match(source, /if \(previous\) writeFileSync\(file, previous.*else rmSync\(file/s);
  assert.doesNotMatch(source, /127\.0\.0\.1:4200/);
  assert.match(source, /runtime-worker-failure\.json/);
  assert.match(source, /assertRuntimeCommandProvenance\(sourceCommit\)/);
  assert.match(source, /readPrivateNoFollow\(handle\.handshake\.path/);
  assert.match(source, /runtimeId !== handle\.runtimeId/);
  assert.match(source, /waitForWorkerCleanup/);
});

test("post-push gate verifies both runtime harness files through an injected seam", () => {
  const script = readFileSync(new URL("../scripts/acceptance-runtime.mjs", import.meta.url)), suite = readFileSync(new URL("../test/acceptance-runtime.test.mjs", import.meta.url));
  const git = (args, options = {}) => {
    if (args[0] === "rev-parse") return `${commit}\n`;
    if (args[0] === "status") return "";
    if (args[0] === "show") return options.encoding === "buffer" ? (args[1].endsWith(".test.mjs") ? suite : script) : "";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  assert.doesNotThrow(() => assertPushedRuntimeHarness(commit, { git, remoteProbe: () => `${commit}\trefs/heads/main\n` }));
  assert.throws(() => assertPushedRuntimeHarness(commit, { git: (args, options) => args[0] === "status" ? " M scripts/acceptance-runtime.mjs\n" : git(args, options), remoteProbe: () => `${commit}\trefs/heads/main\n` }), /dirty/i);
});

test("validateVisualRecord requires a fresh artifact and inspection", () => {
  const dir = root(), artifact = path.join(dir, "desktop.png"); writeFileSync(artifact, "pixels", { mode: 0o600 });
  const binding = { runtimeId: "worker-0123456789abcdef", captureStartedAt: new Date().toISOString() };
  const record = validateVisualRecord({ kind: "browser-desktop", artifact, sourceCommit: commit, ...binding, verdict: "passed", viewport: "1440x900", appearance: "light", reviewer: "acceptance reviewer", inspected: ["controls", "overflow"], issues: [] });
  assert.equal(record.requirementId, "r49"); assert.equal(record.screenshot.path, artifact); assert.match(record.screenshot.sha256, /^[0-9a-f]{64}$/); assert.ok(record.screenshot.mtimeMs > 0); assert.equal(Object.hasOwn(record, "artifact"), false);
  assert.throws(() => validateVisualRecord({ ...record, inspected: [] }), /inspection/i);
  assert.throws(() => validateVisualRecord({ kind: "browser-desktop", artifact, sourceCommit: commit, captureStartedAt: binding.captureStartedAt, runtimeId: undefined, verdict: "passed", viewport: "1440x900", appearance: "light", reviewer: "acceptance reviewer", inspected: ["controls"], issues: [] }), /runtime binding/i);
  assert.throws(() => validateVisualRecord({ kind: "browser-desktop", artifact, sourceCommit: commit, runtimeId: binding.runtimeId, captureStartedAt: undefined, verdict: "passed", viewport: "1440x900", appearance: "light", reviewer: "acceptance reviewer", inspected: ["controls"], issues: [] }), /timestamp/i);
  const linked = path.join(dir, "linked.png"); symlinkSync(artifact, linked);
  assert.throws(() => validateVisualRecord({ kind: "swift-dark", artifact: linked, sourceCommit: commit, ...binding, verdict: "passed", viewport: "1440x900", appearance: "dark", reviewer: "acceptance reviewer", inspected: ["vision"], issues: [] }), /regular/i);
  assert.equal(validateVisualRecord({ kind: "swift-dark", artifact, sourceCommit: commit, ...binding, verdict: "passed", viewport: "1440x900", appearance: "dark", reviewer: "acceptance reviewer", inspected: ["vision"], issues: [] }).requirementId, "r57");
  assert.equal(validateVisualRecord({ kind: "swift-light", artifact, sourceCommit: commit, ...binding, verdict: "passed", viewport: "1440x900", appearance: "light", reviewer: "acceptance reviewer", inspected: ["vision"], issues: [] }).requirementId, "r57");
});

test("completed session rejects stale source capture but reads its owned archive after source cleanup", () => {
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-archive-test-")), capture = path.join(dir, "capture"), source = path.join(capture, "desktop.png"), started = new Date().toISOString(), runtimeId = "worker-0123456789abcdef";
  mkdirSync(capture, { recursive: true, mode: 0o700 }); writeFileSync(path.join(dir, "browser-session.json"), JSON.stringify({ owner: "codex-router-phase5-runtime-v1", sourceCommit: commit, runtimeId, captureStartedAt: started, status: "pending_manual_session", profile: "profile", url: "http://127.0.0.1:1" }), { mode: 0o600 });
  writeFileSync(source, "pixels", { mode: 0o600 }); utimesSync(source, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.throws(() => completedSessionArtifact(dir, capture, "browser", commit, runtimeId, Date.now() - 120_000, source, "reviewer", ["toolbar"]), /predates/i);
  writeFileSync(source, "fresh pixels", { mode: 0o600 });
  for (const kind of ["console", "network", "storage"]) writeFileSync(`${source}.${kind}.json`, JSON.stringify({ version: 1, kind, observations: [{ status: "clean", code: `${kind}-checked` }] }), { mode: 0o600 });
  const runtimeStartedAt = Date.now() - 120_000;
  completedSessionArtifact(dir, capture, "browser", commit, runtimeId, runtimeStartedAt, source, "reviewer", ["toolbar"]);
  const report = JSON.parse(readFileSync(path.join(dir, "evidence", "browser-session-report.json"), "utf8"));
  assert.equal(report.sourceCapture.sha256, report.archiveCapture.sha256);
  assert.match(report.archiveCapture.path, /evidence[\\/]captures[\\/]/);
  rmSync(capture, { recursive: true, force: true });
  assert.doesNotThrow(() => readCompletedSessionArtifact(dir, "browser", commit, { runtimeId, router: { startedAt: runtimeStartedAt }, captureRoots: { browser: capture } }));
});

test("protocol authorization and forced-tool predicates reject caller, internal, and missing observations", () => {
  for (const providerAuthorization of [undefined, "Bearer caller", "Bearer internal", "Bearer task3-loopback-extra"]) assert.equal(protocolAuthorizationPredicates({ providerAuthorization }).providerAuthorizationSafe, false);
  assert.equal(protocolAuthorizationPredicates({ providerAuthorization: "Bearer task3-loopback" }).providerAuthorizationSafe, true);
  for (const nativeAuthorization of ["Bearer caller", "Bearer internal", "Bearer task3-loopback"]) assert.equal(protocolAuthorizationPredicates({ nativeAuthorization }).nativeAuthorizationSafe, false);
  assert.equal(protocolAuthorizationPredicates({ nativeAuthorization: undefined }).nativeAuthorizationSafe, true);
  assert.equal(protocolAuthorizationPredicates({ forcedTool: true, forcedRequest: true, forcedStatus: 422, forcedBody: "required_tool_not_called" }).forcedToolBoundary, true);
  assert.equal(protocolAuthorizationPredicates({ forcedTool: false, forcedRequest: true, forcedStatus: 422, forcedBody: "required_tool_not_called" }).forcedToolBoundary, false);
});

test("capture cleanup aggregates removal failures so final evidence is withheld", () => {
  const calls = [];
  assert.throws(() => removeCaptureRoots({ browser: "/safe/browser", swift: "/safe/swift" }, { remove: (value) => { calls.push(value); if (value.endsWith("swift")) throw new Error("EPERM"); } }), AggregateError);
  assert.deepEqual(calls, ["/safe/browser", "/safe/swift"]);
});

test("stop treats only absent reports as pending and propagates malformed staged reports", () => {
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-report-state-")), value = handle(dir, { runtimeId: "worker-0123456789abcdef" });
  assert.equal(completedTask3ReportsOrPending(value), null);
  mkdirSync(path.join(dir, "evidence"), { recursive: true, mode: 0o700 }); writeFileSync(path.join(dir, "evidence", "browser-session-report.json"), "not-json", { mode: 0o600 });
  // Once any report exists, the set is staged evidence, not a benign pending
  // state.  Missing siblings must not mask malformed/foreign ownership.
  assert.throws(() => completedTask3ReportsOrPending(value));
  writeFileSync(path.join(dir, "evidence", "swift-session-report.json"), "not-json", { mode: 0o600 }); writeFileSync(path.join(dir, "evidence", "visual-report.json"), "not-json", { mode: 0o600 });
  assert.throws(() => completedTask3ReportsOrPending(value));
});

test("browser session archives closed non-secret sidecars bound to its worker", () => {
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-sidecar-")), capture = path.join(path.dirname(dir), `${path.basename(dir)}-capture`), artifact = path.join(capture, "desktop.png"), runtimeId = "worker-0123456789abcdef", started = Date.now() - 1_000;
  mkdirSync(capture, { recursive: true, mode: 0o700 }); writeFileSync(path.join(dir, "browser-session.json"), JSON.stringify({ owner: "codex-router-phase5-runtime-v1", sourceCommit: commit, runtimeId, captureStartedAt: new Date().toISOString(), status: "pending_manual_session", profile: "profile", url: "http://127.0.0.1:1" }), { mode: 0o600 });
  writeFileSync(artifact, "pixels", { mode: 0o600 });
  for (const kind of ["console", "network", "storage"]) writeFileSync(`${artifact}.${kind}.json`, JSON.stringify({ version: 1, kind, observations: [{ status: "clean", code: `${kind}-checked` }] }), { mode: 0o600 });
  const report = completedSessionArtifact(dir, capture, "browser", commit, runtimeId, started, artifact, "reviewer", ["toolbar"]);
  const value = JSON.parse(readFileSync(report, "utf8"));
  assert.deepEqual(Object.keys(value.sidecars).sort(), ["console", "network", "storage"]);
  for (const sidecar of Object.values(value.sidecars)) {
    assert.equal(sidecar.runtimeId, runtimeId); assert.equal(sidecar.sourceCommit, commit); assert.equal(sidecar.captureStartedAt, value.captureStartedAt);
    assert.match(sidecar.archiveCapture.path, /evidence[\\/]captures[\\/]/); assert.equal(sidecar.sourceCapture.sha256, sidecar.archiveCapture.sha256);
  }
  assert.doesNotThrow(() => readCompletedSessionArtifact(dir, "browser", commit, { runtimeId, router: { startedAt: started }, captureRoots: { browser: capture } }));
});

test("browser sidecars reject secret-bearing content before evidence is written", () => {
  const unsafe = ["Bearer caller-secret", "Authorization", "Cookie", "http://127.0.0.1/capability/token", "storage credential", "requestBody", "response_body", "prompt", "reasoning", "tool_args", "access_token=abc", "refresh-token=abc", "API KEY", "password", "session_id", "auth token", "secret_value"];
  for (const text of unsafe) {
    const dir = mkdtempSync(path.resolve("generated/acceptance/task3-sidecar-secret-")), capture = path.join(path.dirname(dir), `${path.basename(dir)}-capture`), artifact = path.join(capture, "desktop.png"), runtimeId = "worker-0123456789abcdef";
    mkdirSync(capture, { recursive: true, mode: 0o700 }); writeFileSync(path.join(dir, "browser-session.json"), JSON.stringify({ owner: "codex-router-phase5-runtime-v1", sourceCommit: commit, runtimeId, captureStartedAt: new Date().toISOString(), status: "pending_manual_session", profile: "profile", url: "http://127.0.0.1:1" }), { mode: 0o600 }); writeFileSync(artifact, "pixels", { mode: 0o600 });
    for (const kind of ["console", "network", "storage"]) writeFileSync(`${artifact}.${kind}.json`, JSON.stringify({ version: 1, kind, observations: [{ status: "clean", code: kind === "network" ? text : "checked" }] }), { mode: 0o600 });
    assert.throws(() => completedSessionArtifact(dir, capture, "browser", commit, runtimeId, Date.now() - 1_000, artifact, "reviewer", ["toolbar"]), /sidecar|unsafe|secret/i, text);
    assert.equal(existsSync(path.join(dir, "evidence", "browser-session-report.json")), false);
  }
});

test("start runtime settles every acquired resource after injected setup failures", async () => {
  for (const stage of ["runtimeFactory", "prerequisites", "install", "start", "health", "control"]) {
    const parent = root(), env = createIsolatedEnvironment({ root: path.join(parent, `runtime-${stage}`), nonce: `cleanup-${stage}-${Math.random().toString(16).slice(2, 10)}`, sourceCommit: commit }), disposed = [];
    const callbacks = {
      prerequisites: async () => { if (stage === "prerequisites") throw new Error(stage); },
      install: async () => { if (stage === "install") throw new Error(stage); },
      start: async () => { if (stage === "start") throw new Error(stage); return { pid: process.pid }; },
      health: async () => { if (stage === "health") throw new Error(stage); return { ok: true }; },
    };
    await assert.rejects(startAcceptanceRuntime(env, {
      runtimeFactory: async () => { if (stage === "runtimeFactory") throw new Error(stage); return { callbacks, dispose: async () => { disposed.push(stage); } }; },
      operations: { createControlServer: async () => { if (stage === "control") throw new Error(stage); throw new Error("unexpected control creation"); } },
    }), new RegExp(stage));
    assert.deepEqual(disposed, stage === "runtimeFactory" ? [] : [stage]); assert.equal(existsSync(path.join(env.root, "c")), false); assert.equal(existsSync(path.join(env.root, "runtime-handshake")), false); assert.equal(existsSync(path.join(env.root, "runtime-handle.json")), false);
    assert.equal(existsSync(isolationLeasePath(env.target.ports).lock), false);
  }
});

test("Swift session accepts only the bound Task1 manifest and isolated bundle", () => {
  const dir = root(), build = path.join(dir, "build"), bundle = path.join(build, "Model Router.app"), manifest = path.join(dir, "acceptance-build.json");
  mkdirSync(bundle, { recursive: true }); writeFileSync(manifest, JSON.stringify({ sourceCommit: commit, buildOnly: true, buildRoot: build, bundlePath: bundle }), { mode: 0o600 });
  assert.equal(verifiedSwiftBundle(bundle, commit, { manifestPath: manifest }), realpathSync(bundle));
  writeFileSync(manifest, JSON.stringify({ sourceCommit: "b".repeat(40), buildOnly: true, buildRoot: build, bundlePath: bundle }), { mode: 0o600 });
  assert.throws(() => verifiedSwiftBundle(bundle, commit, { manifestPath: manifest }), /not bound/i);
  const linked = path.join(dir, "linked-manifest.json"); symlinkSync(manifest, linked);
  assert.throws(() => verifiedSwiftBundle(bundle, commit, { manifestPath: linked }), /private regular/i);
});

test("Plan sibling capture layout resolves exactly one active runtime", () => {
  const parent = mkdtempSync(path.resolve("generated/acceptance/task3-sibling-test-")), runtime = path.join(parent, "runtime"), browser = path.join(parent, "browser"), artifact = path.join(browser, "desktop.png");
  mkdirSync(runtime, { recursive: true }); mkdirSync(browser, { recursive: true }); writeFileSync(path.join(runtime, "runtime-handle.json"), "{}", { mode: 0o600 }); writeFileSync(artifact, "pixels", { mode: 0o600 });
  assert.equal(runtimeRootForArtifact(artifact), runtime);
  const other = path.join(parent, "other"); mkdirSync(other); writeFileSync(path.join(other, "runtime-handle.json"), "{}", { mode: 0o600 });
  assert.throws(() => runtimeRootForArtifact(artifact), /ambiguous/i);
});

test("Task3 command surface never converts pending browser or Swift sessions into evidence", () => {
  const source = readFileSync(new URL("../scripts/acceptance-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /status: "pending_manual_session"/);
  assert.match(source, /if \(!completed\).*return/s);
  assert.match(source, /completedSessionArtifact\(root, handle\.captureRoots\.browser, "browser"/);
  assert.match(source, /\["r24", "r35", "r59"\]/);
  assert.match(source, /completedSessionArtifact\(root, handle\.captureRoots\.swift, "swift"/);
  assert.match(source, /requirementId: "r47"/);
  assert.match(source, /appendVisualReport\(root, record\)/);
  assert.match(source, /"swift-light"/);
  assert.match(source, /recordFinalTask3Evidence/);
  assert.match(source, /await waitForWorkerCleanup\(handle\);/);
  assert.match(source, /beginFinalEvidence\(\{ evidence: file, sourceCommit \}\)/);
});

test("public session to visual to stop finalization owns exactly seventeen distinct Task3 rows", () => {
  assert.deepEqual([...finalTask3RequirementIds()].sort(), ["r06", "r19", "r22", "r24", "r29", "r31", "r35", "r37", "r41", "r45", "r47", "r49", "r51", "r55", "r57", "r59", "r61"]);
  const source = readFileSync(new URL("../scripts/acceptance-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /browser-session\|record-visual\|swift-session\|stop/);
  assert.match(source, /completedTask3ReportsOrPending\(handle\)/);
  assert.doesNotMatch(source, /try \{ reports = completedTask3Reports\(handle\); \} catch/);
});

function finalSeam(finalRoot, { dispose } = {}) {
  const captureRoots = { browser: path.join(finalRoot, "browser"), swift: path.join(finalRoot, "swift") };
  mkdirSync(finalRoot, { recursive: true, mode: 0o700 }); mkdirSync(captureRoots.browser, { recursive: true, mode: 0o700 }); mkdirSync(captureRoots.swift, { recursive: true, mode: 0o700 });
  const value = handle(finalRoot, { runtimeId: "worker-0123456789abcdef", captureRoots, profile: path.join(captureRoots.browser, "profile"), router: { ...handle(finalRoot).router, startedAt: Date.now() - 1_000 } });
  Object.defineProperty(value, "runtime", { enumerable: false, value: { dispose: async () => { dispose?.(); rmSync(captureRoots.browser, { recursive: true, force: true }); rmSync(captureRoots.swift, { recursive: true, force: true }); } } });
  return value;
}

test("five-parameter final API starts a real seam, runs protocol, and leaves an owned manual continuation", async () => {
  const dir = root(), finalRoot = path.join(dir, "fresh"), evidence = path.join(dir, "evidence.json"); let protocolCalls = 0, disposed = false;
  const live = finalSeam(finalRoot, { dispose: () => { disposed = true; } });
  const result = await finalNonLiveAcceptance({ root: finalRoot, buildRoot: dir, browserProfile: live.profile, evidence, sourceCommit: commit, provenance: () => true, run: { start: async () => live, protocol: async () => { protocolCalls += 1; } } });
  assert.equal(result.status, "pending_manual_capture"); assert.equal(result.browserProfile, live.profile); assert.equal(result.runtimeHandle.runtimeId, live.runtimeId); assert.equal(protocolCalls, 1); assert.equal(disposed, false);
  assert.equal(existsSync(path.join(finalRoot, "browser-session.json")), true); assert.equal(existsSync(path.join(finalRoot, "swift-session.json")), true);
  const resumed = await finalNonLiveAcceptance({ root: finalRoot, buildRoot: dir, browserProfile: live.profile, evidence, sourceCommit: commit, provenance: () => true, run: { activeHandle: live, protocol: async () => { protocolCalls += 1; } } });
  assert.equal(resumed.status, "pending_manual_capture"); assert.equal(protocolCalls, 2); await live.runtime.dispose();
});

test("five-parameter final API without run uses the CLI worker protocol and planned bindings", { timeout: 60_000 }, async () => {
  const fixture = currentTask1Fixture(), parent = mkdtempSync(path.resolve("generated/acceptance/task3-f-"));
  const finalRoot = path.join(parent, "r"), evidence = path.join(finalRoot, "evidence.json"), browserProfile = finalNonLiveBrowserProfile(finalRoot);
  let live;
  try {
    const result = await finalNonLiveAcceptance({ root: finalRoot, buildRoot: fixture.manifest.buildRoot, browserProfile, evidence, sourceCommit: fixture.sourceCommit, task1ManifestPath: fixture.manifestPath, requireSwift: false, provenance: () => true });
    live = result.runtimeHandle;
    assert.equal(result.status, "pending_manual_capture"); assert.equal(result.browserProfile, browserProfile); assert.match(live.runtimeId, /^worker-/);
    assert.equal(JSON.parse(readFileSync(path.join(finalRoot, "evidence", "runtime-stage.json"), "utf8")).status, "completed");
  } finally {
    if (live) { await control(live, "stop"); await waitFor(() => !existsSync(live.socket), "default final worker did not stop"); }
  }
});

test("public browser session to visual to stop publishes exactly seventeen local Task3 rows", { timeout: 60_000 }, async () => {
  const fixture = currentTask1Fixture(), manifest = fixture.manifest, sourceCommit = fixture.sourceCommit;
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-public-matrix-")), evidence = path.join(dir, "evidence.json"), child = spawn(process.execPath, [path.resolve("scripts/acceptance-runtime.mjs"), "--worker", "--root", dir, "--source-commit", sourceCommit, "--no-swift"], { stdio: ["ignore", "ignore", "pipe"] });
  const invoke = (args) => runAcceptanceRuntimeCli(args, { provenance: () => true }); let live;
  const writeCapture = (captureRoot, name, sidecars = false) => {
    const artifact = path.join(captureRoot, name); writeFileSync(artifact, "pixels", { mode: 0o600 });
    if (sidecars) for (const kind of ["console", "network", "storage"]) writeFileSync(`${artifact}.${kind}.json`, JSON.stringify({ version: 1, kind, observations: [{ status: "clean", code: `${kind}-checked` }] }), { mode: 0o600 });
    return artifact;
  };
  const command = (name, extra = []) => [name, "--root", dir, "--evidence", evidence, "--source-commit", sourceCommit, ...extra];
  try {
    await waitFor(() => existsSync(path.join(dir, "runtime-handle.json")) || existsSync(path.join(dir, "runtime-worker-failure.json")), "public worker did not start");
    assert.equal(existsSync(path.join(dir, "runtime-worker-failure.json")), false); live = JSON.parse(readFileSync(path.join(dir, "runtime-handle.json"), "utf8"));
    await invoke(command("protocol"));
    const rejected = writeCapture(live.captureRoots.browser, "rejected-browser.png", true);
    writeFileSync(`${rejected}.network.json`, JSON.stringify({ version: 1, kind: "network", observations: [{ status: "clean", code: "access_token=must-not-archive" }] }), { mode: 0o600 });
    await assert.rejects(invoke(command("record-visual", ["--kind", "browser-desktop", "--artifact", rejected, "--verdict", "passed", "--reviewer", "reviewer", "--inspected", '["visible"]'])), /unsafe|sidecar/i);
    assert.equal(existsSync(path.join(dir, "evidence", "visual-report.json")), false);
    for (const kind of ["browser-desktop", "browser-narrow", "testing-evidence"]) {
      const artifact = writeCapture(live.captureRoots.browser, `${kind}.png`, true);
      await invoke(command("record-visual", ["--kind", kind, "--artifact", artifact, "--verdict", "passed", "--reviewer", "reviewer", "--inspected", '["visible"]']));
    }
    const visual = JSON.parse(readFileSync(path.join(dir, "evidence", "visual-report.json"), "utf8"));
    for (const record of visual.records.filter((record) => record.kind.startsWith("browser-") || record.kind === "testing-evidence")) {
      assert.deepEqual(Object.keys(record.sidecars).sort(), ["console", "network", "storage"]);
      for (const sidecar of Object.values(record.sidecars)) assert.equal(sidecar.archiveCapture.sha256, sidecar.sourceCapture.sha256);
    }
    await invoke(command("swift-session", ["--bundle", manifest.bundlePath, "--task1-manifest", fixture.manifestPath]));
    for (const kind of ["swift-light", "swift-dark", "vision-allow"]) {
      const artifact = writeCapture(live.captureRoots.swift, `${kind}.png`);
      await invoke(command("record-visual", ["--kind", kind, "--artifact", artifact, "--verdict", "passed", "--reviewer", "reviewer", "--inspected", '["visible"]']));
    }
    await invoke(command("stop"));
    const matrix = JSON.parse(readFileSync(evidence, "utf8"));
    assert.notEqual(matrix.finalGeneration, null); assert.deepEqual(matrix.entries.map((entry) => entry.requirementId).sort(), [...finalTask3RequirementIds()].sort()); assert.equal(matrix.entries.length, 17);
  } finally {
    if (live && existsSync(live.socket)) { try { await control(live, "stop"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});

test("production final provenance rejects untracked runtime harness before it starts a worker", async () => {
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-final-provenance-")), finalRoot = path.join(dir, "r");
  await assert.rejects(finalNonLiveAcceptance({ root: finalRoot, buildRoot: dir, browserProfile: finalNonLiveBrowserProfile(finalRoot), evidence: path.join(dir, "evidence.json"), sourceCommit: commit }), /dirty|untracked|github/i);
  assert.equal(existsSync(finalRoot), false);
});

test("resumed active final restores evidence and disposes its runtime after a human callback failure", async () => {
  const dir = root(), finalRoot = path.join(dir, "active"), evidence = path.join(dir, "evidence.json"), prior = '{"schemaVersion":1,"finalGeneration":null,"entries":[]}\n'; writeFileSync(evidence, prior, { mode: 0o600 });
  let disposed = false; const live = finalSeam(finalRoot, { dispose: () => { disposed = true; } });
  await assert.rejects(finalNonLiveAcceptance({ root: finalRoot, buildRoot: dir, browserProfile: live.profile, evidence, sourceCommit: commit, provenance: () => true, run: { activeHandle: live, protocol: async () => {}, browser: async () => { throw new Error("human failure"); }, swift: async () => {}, visuals: async () => {} } }), /human failure/);
  assert.equal(disposed, true); assert.equal(existsSync(live.captureRoots.browser), false); assert.equal(existsSync(live.captureRoots.swift), false); assert.equal(readFileSync(evidence, "utf8"), prior);
});

test("resumed disk final restores evidence and stops the owned worker after a human callback failure", { timeout: 40_000 }, async () => {
  const fixture = currentTask1Fixture(), dir = mkdtempSync(path.resolve("generated/acceptance/task3-final-disk-")), evidence = path.join(dir, "evidence.json"), prior = '{"schemaVersion":1,"finalGeneration":null,"entries":[]}\n'; writeFileSync(evidence, prior, { mode: 0o600 });
  const child = spawn(process.execPath, [path.resolve("scripts/acceptance-runtime.mjs"), "--worker", "--root", dir, "--source-commit", fixture.sourceCommit, "--no-swift"], { stdio: ["ignore", "ignore", "pipe"] }); let live;
  try {
    await waitFor(() => existsSync(path.join(dir, "runtime-handle.json")) || existsSync(path.join(dir, "runtime-worker-failure.json")), "disk final worker did not start");
    assert.equal(existsSync(path.join(dir, "runtime-worker-failure.json")), false); live = JSON.parse(readFileSync(path.join(dir, "runtime-handle.json"), "utf8"));
    await assert.rejects(finalNonLiveAcceptance({ root: dir, buildRoot: fixture.manifest.buildRoot, browserProfile: live.profile, evidence, sourceCommit: fixture.sourceCommit, task1ManifestPath: fixture.manifestPath, requireSwift: false, provenance: () => true, run: { browser: async () => { throw new Error("disk human failure"); }, swift: async () => {}, visuals: async () => {} } }), /disk human failure/);
    await waitFor(() => !existsSync(live.socket) && !existsSync(live.lease.path) && !existsSync(live.captureRoots.browser) && !existsSync(live.captureRoots.swift) && !existsSync(live.profile), "disk final cleanup did not settle");
    assert.equal(readFileSync(evidence, "utf8"), prior);
  } finally {
    if (live && existsSync(live.socket)) { try { await control(live, "stop"); } catch {} }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});

test("no-op human callbacks cannot open a final generation", async () => {
  const dir = root(), finalRoot = path.join(dir, "fresh"), evidence = path.join(dir, "evidence.json"); let disposed = false;
  const live = finalSeam(finalRoot, { dispose: () => { disposed = true; } });
  await assert.rejects(finalNonLiveAcceptance({ root: finalRoot, buildRoot: dir, browserProfile: live.profile, evidence, sourceCommit: commit, provenance: () => true, run: { start: async () => live, protocol: async () => {}, browser: async () => {}, swift: async () => {}, visuals: async () => {} } }), /browser-session-report|session report/i);
  assert.equal(disposed, true); assert.equal(existsSync(evidence), false);
});

test("final API restores prior evidence when a visual callback fails", async () => {
  const dir = root(), finalRoot = path.join(dir, "fresh"), evidence = path.join(dir, "evidence.json"), prior = '{"schemaVersion":1,"finalGeneration":null,"entries":[]}\n'; writeFileSync(evidence, prior, { mode: 0o600 }); let disposed = false;
  const live = finalSeam(finalRoot, { dispose: () => { disposed = true; } });
  await assert.rejects(finalNonLiveAcceptance({ root: finalRoot, buildRoot: dir, browserProfile: live.profile, evidence, sourceCommit: commit, provenance: () => true, run: { start: async () => live, protocol: async () => {}, browser: async () => {}, swift: async () => {}, visuals: async () => { throw new Error("visual marker failure"); } } }), /visual marker failure/);
  assert.equal(disposed, true); assert.equal(readFileSync(evidence, "utf8"), prior);
});

test("real worker owns its lease/socket and IPC stop cleans every owned runtime handle", { timeout: 40_000 }, async () => {
  const sourceCommit = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-worker-test-"));
  const child = spawn(process.execPath, [path.resolve("scripts/acceptance-runtime.mjs"), "--worker", "--root", dir, "--source-commit", sourceCommit, "--no-swift"], { env: { ...process.env, DEEPSEEK_API_KEY: "parent-secret-must-not-reach-protocol-child", HTTPS_PROXY: "https://parent-proxy.invalid", NODE_OPTIONS: "" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const handleFile = path.join(dir, "runtime-handle.json"); await waitFor(() => existsSync(handleFile) || existsSync(path.join(dir, "runtime-worker-failure.json")), "worker did not report startup");
    assert.equal(existsSync(path.join(dir, "runtime-worker-failure.json")), false, stderr);
    const live = JSON.parse(readFileSync(handleFile, "utf8")); assert.equal(live.router.workerPid, child.pid); assert.equal(await control(live, "status").then((value) => value.ok), true);
    const protocol = await control(live, "protocol");
    assert.deepEqual(protocol, { ok: true, stage: "complete" });
    const stage = JSON.parse(readFileSync(path.join(dir, "evidence", "runtime-stage.json"), "utf8"));
    assert.equal(stage.status, "completed"); assert.deepEqual(stage.assertions.map((entry) => entry.id).sort(), ["r06", "r19", "r22", "r29", "r41", "r45", "r51", "r55"]);
    assert.equal(await control(live, "stop").then((value) => value.ok), true);
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(existsSync(handleFile), false); assert.equal(existsSync(live.socket), false); assert.equal(existsSync(live.lease.path), false); assert.equal(existsSync(live.captureRoots.browser), false); assert.equal(existsSync(live.captureRoots.swift), false);
  } finally { if (!child.killed) child.kill("SIGTERM"); }
});

test("real worker rejects a replaced socket and a reused router identity", { timeout: 40_000 }, async () => {
  const sourceCommit = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-worker-owner-test-"));
  const child = spawn(process.execPath, [path.resolve("scripts/acceptance-runtime.mjs"), "--worker", "--root", dir, "--source-commit", sourceCommit, "--no-swift"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const handleFile = path.join(dir, "runtime-handle.json"); await waitFor(() => existsSync(handleFile) || existsSync(path.join(dir, "runtime-worker-failure.json")), "worker did not report startup");
    assert.equal(existsSync(path.join(dir, "runtime-worker-failure.json")), false, stderr);
    const live = JSON.parse(readFileSync(handleFile, "utf8"));
    assert.throws(() => assertControlOwnership({ ...live, router: { ...live.router, routerIdentity: { ...live.router.routerIdentity, digest: "0".repeat(64) } } }), /process identity changed/);
    unlinkSync(live.socket); writeFileSync(live.socket, "replaced", { mode: 0o600 });
    assert.throws(() => assertControlOwnership(live), /replaced control socket/i);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("router crash makes the worker release its owned control resources", { timeout: 40_000 }, async () => {
  const sourceCommit = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(path.resolve("generated/acceptance/task3-worker-crash-test-"));
  const child = spawn(process.execPath, [path.resolve("scripts/acceptance-runtime.mjs"), "--worker", "--root", dir, "--source-commit", sourceCommit, "--no-swift"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const handleFile = path.join(dir, "runtime-handle.json"); await waitFor(() => existsSync(handleFile) || existsSync(path.join(dir, "runtime-worker-failure.json")), "worker did not report startup");
    assert.equal(existsSync(path.join(dir, "runtime-worker-failure.json")), false, stderr);
    const live = JSON.parse(readFileSync(handleFile, "utf8")); process.kill(live.router.pid, "SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(existsSync(handleFile), false); assert.equal(existsSync(live.socket), false); assert.equal(existsSync(live.lease.path), false); assert.equal(existsSync(live.captureRoots.browser), false); assert.equal(existsSync(live.captureRoots.swift), false);
  } finally { if (!child.killed) child.kill("SIGTERM"); }
});
