import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { redactSensitive } from "../src/sensitive-redactor.mjs";
import { acquireIsolationLease, assertCliPreflight, assertPortsAvailable, assertPushedHarness, completeIsolatedInstaller, createIsolatedEnvironment, guardIsolatedRuntimeCallback, isolationLeasePath, ownedProcessAlive, planIsolatedEnvironment, readInstalledCallerSecret, verifyCleanInstall } from "../scripts/verify-isolated-install.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-isolated-install-"));
  const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  return { root, sourceRoot };
}

test("isolated environment owns every mutable target and rejects production collisions before callbacks", () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, uid: 502, nonce: "unit" });
    assert.equal(env.root, realpathSync(root));
    for (const value of [env.codexHome, env.stateRoot, env.supportRoot, env.launchAgentsDir, env.target.routerPlistPath, env.target.trayPlistPath, env.target.appPath, env.browserProfile, env.credentialsPath, env.logPath]) {
      assert.ok(value.startsWith(`${env.root}${path.sep}`), value);
    }
    assert.notEqual(env.target.routerLabel, "io.github.codex-router");
    assert.notEqual(env.target.trayLabel, "io.github.codex-router.tray");
    assert.notEqual(env.target.ports.router, 4202);
    assert.match(env.target.launchDomain, /^gui\/502$/);

    let calls = 0;
    assert.throws(() => createIsolatedEnvironment({ root, sourceRoot, nonce: "collision", ports: { router: 4202 } }, { beforeWrite() { calls += 1; } }), /collides|production|port/i);
    assert.equal(calls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("planning rejects collisions before it creates a requested root", () => {
  const { root } = fixture();
  const absent = path.join(root, "not-created");
  try {
    assert.equal(existsSync(absent), false);
    assert.throws(() => planIsolatedEnvironment({ root: absent, nonce: "production" }), /invalid isolated environment nonce/);
    assert.equal(existsSync(absent), false);
    assert.throws(() => planIsolatedEnvironment({ root: absent, nonce: "collision", ports: { router: 4202 } }), /collides.*production|production.*port/i);
    assert.equal(existsSync(absent), false);
    assert.throws(() => createIsolatedEnvironment({ root: absent, nonce: "collision", ports: { router: 4202 } }), /collides.*production|production.*port/i);
    assert.equal(existsSync(absent), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("port preflight rejects an occupied derived port without creating the requested root", async () => {
  const { root } = fixture();
  const absent = path.join(root, "not-created");
  const plan = planIsolatedEnvironment({ root: absent, nonce: `occupied-${process.pid}` });
  const server = createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(plan.target.ports.router, "127.0.0.1", resolve); });
    await assert.rejects(assertPortsAvailable(plan.target.ports));
    assert.equal(existsSync(absent), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("port leases are exclusive, never reclaim stale locks, and never release a replacement owner", () => {
  const ports = { oauth: 59_001 + (process.pid % 500), router: 59_002 + (process.pid % 500), api: 59_003 + (process.pid % 500), grokOauth: 59_004 + (process.pid % 500), devinCli: 59_005 + (process.pid % 500) };
  const { lock } = isolationLeasePath(ports);
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  rmSync(lock, { force: true });
  try {
    writeFileSync(lock, JSON.stringify({ token: "stale", pid: 999_999, root: "/tmp/stale", ports: isolationLeasePath(ports).normalized }), { mode: 0o600 });
    assert.throws(() => acquireIsolationLease("/tmp/other-root", ports), /already leased/);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "stale");
    unlinkSync(lock);

    const release = acquireIsolationLease("/tmp/first-root", ports);
    assert.throws(() => acquireIsolationLease("/tmp/second-root", ports), /already leased/);
    unlinkSync(lock);
    writeFileSync(lock, JSON.stringify({ token: "replacement", pid: process.pid, root: "/tmp/replacement", ports: isolationLeasePath(ports).normalized }), { mode: 0o600 });
    assert.throws(() => release(), /refusing to release/);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "replacement");
  } finally { rmSync(lock, { force: true }); }
});

test("owned process state treats either exit status as dead", () => {
  const child = { exitCode: null, signalCode: null };
  const state = { child, alive: true };
  assert.equal(ownedProcessAlive(state, child), true);
  child.signalCode = "SIGTERM";
  assert.equal(ownedProcessAlive(state, child), false);
  child.signalCode = null;
  child.exitCode = 1;
  assert.equal(ownedProcessAlive(state, child), false);
  assert.equal(ownedProcessAlive(state, { exitCode: null, signalCode: null }), false);
});

test("installed caller capability is atomically read from the private installer file and stays redacted", () => {
  const { root, sourceRoot } = fixture();
  const installerSecret = "installed_caller_capability_0123456789abcdef";
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "installer-secret" });
    mkdirSync(env.stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(env.stateRoot, "caller-secret"), `${installerSecret}\n`, { mode: 0o600 });
    assert.equal(readInstalledCallerSecret(env), installerSecret);
    const base = callerBaseUrl(env.target.ports.router, readInstalledCallerSecret(env));
    assert.match(base, new RegExp(installerSecret));
    assert.doesNotMatch(redactSensitive(`caller URL ${base}`, { profile: "log" }), new RegExp(installerSecret));

    chmodSync(path.join(env.stateRoot, "caller-secret"), 0o644);
    assert.throws(() => readInstalledCallerSecret(env), /private mode/);
    chmodSync(path.join(env.stateRoot, "caller-secret"), 0o600);
    writeFileSync(path.join(env.stateRoot, "caller-secret"), "x".repeat(4_097), { mode: 0o600 });
    assert.throws(() => readInstalledCallerSecret(env), /invalid size/);
    rmSync(path.join(env.stateRoot, "caller-secret"));
    symlinkSync(path.join(env.stateRoot, "missing-target"), path.join(env.stateRoot, "caller-secret"));
    assert.throws(() => readInstalledCallerSecret(env), /did not create|regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a completed installer that omits caller-secret fails before harness preparation and never synthesizes one", () => {
  const { root, sourceRoot } = fixture();
  const sentinel = "missing_installer_secret_0123456789abcdef";
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "missing-installer-secret" });
    mkdirSync(env.stateRoot, { recursive: true, mode: 0o700 });
    let error;
    try { completeIsolatedInstaller(env, { runInstaller: () => "installer completed" }); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error);
    assert.match(error.message, /did not create/);
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    assert.equal(existsSync(path.join(env.stateRoot, "caller-secret")), false);
    assert.equal(existsSync(path.join(env.evidenceRoot, "clean-install.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("disposed runtimes reject callbacks before they can reuse cleared capability state", async () => {
  let disposed = false;
  let calls = 0;
  const callback = guardIsolatedRuntimeCallback(() => disposed, async () => { calls += 1; });
  await callback();
  disposed = true;
  await assert.rejects(callback(), /runtime is disposed/);
  assert.equal(calls, 1);
});

test("clean install harness proves the full isolated service and command contract through injected callbacks", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "clean" });
    const calls = [];
    const result = await verifyCleanInstall(env, {
      prerequisites: async (value) => { calls.push("prerequisites"); assert.equal(value, env); },
      install: async (value) => { calls.push("install"); value.write("installer.txt", "node-only\n", 0o600); },
      inspectLaunchArgs: async (value) => { calls.push("launch"); assert.match(value.target.routerLabel, /acceptance/); return [process.execPath, "src/start.mjs"]; },
      start: async (value) => { calls.push("start"); value.write("service.started", "yes\n", 0o600); return { pid: 1234, label: value.target.routerLabel }; },
      authenticate: async (value) => { calls.push("auth"); assert.ok(value.credentialsPath.startsWith(value.root)); },
      health: async () => { calls.push("health"); return { ok: true }; },
      route: async (_value, transport) => { calls.push(`route:${transport}`); return { transport, catalog: true }; },
      catalog: async () => { calls.push("catalog"); return { published: true }; },
      browser: async (value) => { calls.push("browser"); assert.ok(value.browserProfile.startsWith(value.root)); },
      swift: async (value) => { calls.push("swift"); assert.ok(value.target.appPath.startsWith(value.root)); },
      lifecycle: async (_value, action) => { calls.push(`lifecycle:${action}`); },
      uninstall: async (value) => { calls.push("uninstall"); assert.equal(value.target.routerLabel.includes("acceptance"), true); },
    });
    assert.deepEqual(result.status, "passed");
    assert.deepEqual(calls, ["prerequisites", "install", "launch", "start", "auth", "health", "route:responses", "route:messages", "catalog", "browser", "swift", "lifecycle:stop", "lifecycle:start", "lifecycle:restart", "uninstall"]);
    assert.equal(readFileSync(path.join(root, "installer.txt"), "utf8"), "node-only\n");
    assert.equal(statSync(path.join(root, "installer.txt")).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(root, "evidence", "clean-install.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pre-push unit guards reject stale provenance and non-macOS roots without writing or passed evidence", () => {
  const { sourceRoot } = fixture();
  mkdirSync(path.join(sourceRoot, "generated", "acceptance"), { recursive: true });
  const root = mkdtempSync(path.join(sourceRoot, "generated", "acceptance", "task2-clean-cli-"));
  try {
    const before = existsSync(path.join(root, "checkout"));
    assert.throws(() => assertCliPreflight(root, { platform: "linux" }), /macOS-only/);
    assert.equal(existsSync(path.join(root, "checkout")), before);
    assert.throws(() => assertPushedHarness("a".repeat(40), { remoteProbe: () => "b".repeat(40), git: () => "" }), /github\/main/);
    assert.throws(() => assertPushedHarness("a".repeat(40), { remoteProbe: () => "a".repeat(40), git: (args) => args[0] === "status" ? "?? scripts/verify-isolated-install.mjs" : "" }), /dirty or untracked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
