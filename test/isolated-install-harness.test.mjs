import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { privateFileIsProtected, protectPrivateFile } from "../src/file-security.mjs";
import { redactSensitive } from "../src/sensitive-redactor.mjs";
import { acceptanceCatalogFixture, privateRegularFile, runtimeEnv, acquireIsolationLease, assertCliPreflight, assertCurrentPushedCommit, assertPortsAvailable, assertPushedHarness, completeIsolatedInstaller, createIsolatedEnvironment, createLocalProviderFixture, createLocalRuntime, guardIsolatedRuntimeCallback, isolationLeasePath, ownedProcessAlive, planIsolatedEnvironment, readInstalledCallerSecret, resolvePushedRemote, validateAcceptanceProviderFixture, validDownstreamResponsesLifecycle, verifyCleanInstall, writeAcceptanceCatalog } from "../scripts/verify-isolated-install.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-isolated-install-"));
  return { root, sourceRoot: repositoryRoot };
}

function assertPrivateFile(file) {
  assert.equal(privateFileIsProtected(file), true, `private file is not protected: ${file}`);
}

function committedHarnessGit(commit, { remotes = ["github"], upstream = "github/main" } = {}) {
  return (args, options = {}) => {
    if (args[0] === "status") return "";
    if (args[0] === "remote") return `${remotes.join("\n")}\n`;
    if (args[0] === "rev-parse") return `${upstream}\n`;
    if (args[0] === "show") {
      const file = args[1].slice(commit.length + 1);
      const bytes = readFileSync(path.join(repositoryRoot, file));
      return options.encoding === "buffer" ? bytes : bytes.toString("utf8");
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

test("Windows private-file validation binds an ACL result to the opened file identity", () => {
  const opened = { dev: 7, ino: 11, mode: 0o100600, isFile: () => true, isSymbolicLink: () => false };
  const replacement = { ...opened, ino: 12 };
  let reads = 0;
  assert.equal(privateRegularFile("C:\\acceptance\\caller-secret", opened, {
    platform: "win32",
    lstat: () => (++reads === 1 ? opened : replacement),
    protectedFile: () => true,
  }), false);
  assert.equal(privateRegularFile("C:\\acceptance\\caller-secret", opened, {
    platform: "win32",
    lstat: () => opened,
    protectedFile: () => true,
  }), true);
  const bigintOpened = { dev: 9n, ino: 9007199254740993n, mode: 0o100600, isFile: () => true, isSymbolicLink: () => false };
  assert.equal(privateRegularFile("C:\\acceptance\\caller-secret", bigintOpened, {
    platform: "win32",
    lstat: (_file, options) => {
      assert.deepEqual(options, { bigint: true });
      return bigintOpened;
    },
    protectedFile: () => true,
  }), true);
});

test("isolated environment owns every mutable target and rejects production collisions before callbacks", () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, uid: 502, nonce: "unit" });
    assert.equal(env.root, realpathSync(root));
    for (const value of [env.codexHome, env.codexBin, env.stateRoot, env.supportRoot, env.launchAgentsDir, env.target.routerPlistPath, env.target.trayPlistPath, env.target.appPath, env.browserProfile, env.credentialsPath, env.logPath]) {
      assert.ok(value.startsWith(`${env.root}${path.sep}`), value);
    }
    assert.equal(runtimeEnv(env).CODEX_BIN, process.env.CODEX_BIN);
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
    protectPrivateFile(path.join(env.stateRoot, "caller-secret"));
    assert.equal(readInstalledCallerSecret(env), installerSecret);
    const base = callerBaseUrl(env.target.ports.router, readInstalledCallerSecret(env));
    assert.match(base, new RegExp(installerSecret));
    assert.doesNotMatch(redactSensitive(`caller URL ${base}`, { profile: "log" }), new RegExp(installerSecret));

    if (process.platform !== "win32") {
      chmodSync(path.join(env.stateRoot, "caller-secret"), 0o644);
      assert.throws(() => readInstalledCallerSecret(env), /private mode/);
      chmodSync(path.join(env.stateRoot, "caller-secret"), 0o600);
    }
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

test("local provider fixture accepts only the exact Responses and Messages dialects", async () => {
  const fixture = await createLocalProviderFixture();
  const post = (suffix, body) => fetch(`${fixture.baseUrl}${suffix}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const responsesString = await post("/responses", { model: "deepseek-v4-flash", stream: true, input: "plain Responses input" });
    assert.equal(responsesString.status, 200);
    assert.match(await responsesString.text(), /event: response\.created/);
    assert.equal((await post("/responses", { model: "deepseek-v4-flash", stream: true, input: [{ role: "user", content: "array Responses input" }] })).status, 200);
    const messages = await post("/messages", { model: "glm-5.2", stream: true, max_tokens: 8, messages: [{ role: "user", content: "Messages input" }] });
    assert.equal(messages.status, 200);
    const messagesSse = await messages.text();
    for (const event of ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]) assert.match(messagesSse, new RegExp(`event: ${event}`));
    assert.equal(fixture.requests.length, 3);

    assert.equal((await post("/responses", { model: "glm-5.2", stream: true, input: "wrong model" })).status, 422);
    assert.equal((await post("/responses", { model: "deepseek-v4-flash", stream: false, input: "missing stream" })).status, 422);
    assert.equal((await post("/responses", { model: "deepseek-v4-flash", stream: true, input: [], messages: [] })).status, 422);
    assert.equal((await post("/messages", { model: "glm-5.2", stream: true, messages: [{ role: "user", content: "missing max" }] })).status, 422);
    assert.equal((await post("/messages", { model: "glm-5.2", stream: true, max_tokens: 8, messages: [], input: "mixed" })).status, 422);
    assert.equal((await post("/wrong-path", { model: "deepseek-v4-flash", input: "wrong path" })).status, 404);
    assert.equal(fixture.requests.length, 3);
    assert.equal(fixture.attempts.length, 9);
    assert.deepEqual(fixture.attempts.slice(0, 3).map(({ path, method, model, accepted, transport }) => ({ path, method, model, accepted, transport })), [
      { path: "/v1/responses", method: "POST", model: "deepseek-v4-flash", accepted: true, transport: "responses" },
      { path: "/v1/responses", method: "POST", model: "deepseek-v4-flash", accepted: true, transport: "responses" },
      { path: "/v1/messages", method: "POST", model: "glm-5.2", accepted: true, transport: "messages" },
    ]);
    for (const attempt of fixture.attempts) {
      assert.equal(Object.hasOwn(attempt, "payload"), false);
      assert.equal(Object.hasOwn(attempt, "content"), false);
    }
    assert.equal(fixture.attempts.filter((attempt) => !attempt.accepted).length, 6);
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});

test("acceptance runtime fixture seam admits only an owned loopback-safe observation schema", async () => {
  const server = http.createServer((_request, response) => response.writeHead(204).end());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const attempts = [{ path: "/v1/responses", method: "POST", model: "deepseek-v4-flash", accepted: true, reason: "accepted", transport: "responses" }];
    const safe = { server, baseUrl, attempts, requests: [attempts[0]] };
    assert.equal(validateAcceptanceProviderFixture(safe), safe);
    assert.throws(() => validateAcceptanceProviderFixture({ ...safe, baseUrl: "https://example.com/v1" }), /loopback/);
    assert.throws(() => validateAcceptanceProviderFixture({ ...safe, baseUrl: `http://[::1]:${server.address().port}/v1` }), /owned loopback/i);
    assert.throws(() => validateAcceptanceProviderFixture({ ...safe, attempts: [{ ...safe.attempts[0], payload: "must-not-escape" }] }), /closed|payload/i);
    assert.throws(() => validateAcceptanceProviderFixture({ ...safe, server: { listening: true, close() {}, address: () => ({ address: "127.0.0.1", port: server.address().port }) } }), /owned|listening|server/i);
    assert.throws(() => validateAcceptanceProviderFixture({ ...safe, attempts: [{ ...safe.attempts[0], path: "/v1/responses?secret=forbidden" }] }), /closed safe schema/i);
    const mismatched = { ...attempts[0], transport: "messages" };
    assert.throws(() => validateAcceptanceProviderFixture({ ...safe, attempts: [mismatched], requests: [mismatched] }), /closed safe schema/i);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("an injected acceptance fixture is used once by real materialized start and is closed after restart cleanup", {
  skip: process.platform !== "darwin" && "the production launch target is macOS-only; portable fixture-schema tests run above",
}, async () => {
  const acceptanceRoot = path.join(repositoryRoot, "generated", "acceptance");
  mkdirSync(acceptanceRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(acceptanceRoot, `task3-fixture-runtime-${process.pid}-`));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  let injectedFixture;
  let factoryCalls = 0;
  let installerCalls = 0;
  let runtime;
  try {
    const env = createIsolatedEnvironment({ root, nonce: `fixture-runtime-${process.pid}`, sourceCommit });
    runtime = await createLocalRuntime(env, {
      sourceCommit,
      allowReleased: true,
      requireSwift: false,
      installerRunner: (isolated) => {
        installerCalls += 1;
        mkdirSync(isolated.stateRoot, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(isolated.stateRoot, "caller-secret"), "fixture_only_caller_capability_0123456789abcdef\n", { mode: 0o600 });
        writeFileSync(path.join(isolated.stateRoot, "internal-secret"), "fixture_only_internal_capability_0123456789abcdef\n", { mode: 0o600 });
        return "fixture-only materialized-start setup";
      },
      providerFixtureFactory: async ({ registerServer }) => {
        factoryCalls += 1;
        injectedFixture = await createLocalProviderFixture({ registerServer });
        return injectedFixture;
      },
    });
    await runtime.callbacks.install(env);
    await Promise.all([runtime.callbacks.start(env), runtime.callbacks.start(env)]);
    await runtime.callbacks.route(env, "responses");
    await runtime.callbacks.route(env, "messages");
    await runtime.callbacks.lifecycle(env, "restart");
    assert.equal(installerCalls, 1);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(injectedFixture.requests.map(({ path, transport }) => ({ path, transport })), [{ path: "/v1/responses", transport: "responses" }, { path: "/v1/messages", transport: "messages" }]);
  } finally {
    await runtime?.dispose();
    assert.equal(injectedFixture?.server.listening || false, false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing fixture factory closes every server it registered before router spawn", async () => {
  const acceptanceRoot = path.join(repositoryRoot, "generated", "acceptance");
  mkdirSync(acceptanceRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(acceptanceRoot, `task3-fixture-failure-${process.pid}-`));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  let server;
  let runtime;
  try {
    const env = createIsolatedEnvironment({ root, nonce: `fixture-failure-${process.pid}`, sourceCommit });
    runtime = await createLocalRuntime(env, {
      sourceCommit,
      allowReleased: true,
      requireSwift: false,
      providerFixtureFactory: async ({ registerServer }) => {
        server = http.createServer((_request, response) => response.writeHead(204).end());
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        registerServer(server);
        throw new Error("planned fixture setup failure");
      },
    });
    await assert.rejects(runtime.callbacks.start(env), /planned fixture setup failure/);
    assert.equal(server.listening, false);
  } finally {
    await runtime?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a custom fixture that skips registerServer is rejected and its returned Node server is closed", async () => {
  const acceptanceRoot = path.join(repositoryRoot, "generated", "acceptance");
  mkdirSync(acceptanceRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(acceptanceRoot, `task3-fixture-unregistered-${process.pid}-`));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  let fixture;
  let runtime;
  try {
    const env = createIsolatedEnvironment({ root, nonce: `fixture-unregistered-${process.pid}`, sourceCommit });
    runtime = await createLocalRuntime(env, {
      sourceCommit,
      allowReleased: true,
      requireSwift: false,
      providerFixtureFactory: async () => {
        fixture = await createLocalProviderFixture();
        return fixture;
      },
    });
    await assert.rejects(runtime.callbacks.start(env), /must register/);
    assert.equal(fixture.server.listening, false);
  } finally {
    await runtime?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose during a deferred registered fixture closes it and prevents router spawn", async () => {
  const acceptanceRoot = path.join(repositoryRoot, "generated", "acceptance");
  mkdirSync(acceptanceRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(acceptanceRoot, `task3-fixture-dispose-${process.pid}-`));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  let server;
  let baseUrl;
  let releaseFactory;
  let factoryStarted;
  let runtime;
  let unhandled;
  const onUnhandled = (reason) => { unhandled = reason; };
  try {
    const env = createIsolatedEnvironment({ root, nonce: `fixture-dispose-${process.pid}`, sourceCommit });
    runtime = await createLocalRuntime(env, {
      sourceCommit,
      allowReleased: true,
      requireSwift: false,
      providerFixtureFactory: async ({ registerServer }) => {
        server = http.createServer((_request, response) => response.writeHead(204).end());
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        registerServer(server);
        baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
        factoryStarted();
        await new Promise((resolve) => { releaseFactory = resolve; });
        return { server, baseUrl, attempts: [], requests: [] };
      },
    });
    const entered = new Promise((resolve) => { factoryStarted = resolve; });
    const starting = runtime.callbacks.start(env);
    await entered;
    const disposing = runtime.dispose();
    process.on("unhandledRejection", onUnhandled);
    releaseFactory();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(unhandled, undefined);
    await assert.rejects(starting, /disposed/);
    await disposing;
    assert.equal(server.listening, false);
    assert.equal(existsSync(env.logPath), false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    releaseFactory?.();
    await runtime?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dispose aborts a permanently pending fixture without waiting for its factory and rejects late registration", async () => {
  const acceptanceRoot = path.join(repositoryRoot, "generated", "acceptance");
  mkdirSync(acceptanceRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(acceptanceRoot, `task3-fixture-pending-${process.pid}-`));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  let server;
  let lateServer;
  let signal;
  let registerServer;
  let factoryStarted;
  let runtime;
  try {
    const env = createIsolatedEnvironment({ root, nonce: `fixture-pending-${process.pid}`, sourceCommit });
    runtime = await createLocalRuntime(env, {
      sourceCommit,
      allowReleased: true,
      requireSwift: false,
      providerFixtureFactory: async (context) => {
        ({ signal, registerServer } = context);
        server = http.createServer((_request, response) => response.writeHead(204).end());
        await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        registerServer(server);
        factoryStarted();
        await new Promise(() => {});
      },
    });
    const entered = new Promise((resolve) => { factoryStarted = resolve; });
    void runtime.callbacks.start(env);
    await entered;
    assert.equal(signal.aborted, false);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("dispose deadline")), 1_000));
    await Promise.race([runtime.dispose(), timeout]);
    assert.equal(signal.aborted, true);
    assert.equal(server.listening, false);
    await assertPortsAvailable(env.target.ports);
    lateServer = http.createServer((_request, response) => response.writeHead(204).end());
    await new Promise((resolve, reject) => { lateServer.once("error", reject); lateServer.listen(0, "127.0.0.1", resolve); });
    assert.throws(() => registerServer(lateServer), /disposed|aborted/);
    await new Promise((resolve) => lateServer.once("close", resolve));
    assert.equal(lateServer.listening, false);
  } finally {
    server?.close();
    lateServer?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("downstream client lifecycle requires Responses created and completed events", () => {
  const valid = "event: response.created\r\ndata: {\"type\":\"response.created\"}\r\n\r\ndata: {\"type\":\"response.completed\"}\n\ndata: [DONE]\n\n";
  assert.equal(validDownstreamResponsesLifecycle(valid), true);
  assert.equal(validDownstreamResponsesLifecycle("data: {\"type\":\"response.completed\"}\n\nevent: response.created\ndata: {\"type\":\"response.created\"}\n\n"), false);
  assert.equal(validDownstreamResponsesLifecycle("event: response.created\ndata: {\"type\":\"response.created\"}\n\nevent: response.created\ndata: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"), false);
  assert.equal(validDownstreamResponsesLifecycle("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"), false);
  assert.equal(validDownstreamResponsesLifecycle("event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: response.created\ndata: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.completed\"}\n\n"), false);
  assert.equal(validDownstreamResponsesLifecycle("event: response.created\ndata: not-json\n\ndata: {\"type\":\"response.completed\"}\n\n"), false);
});

test("acceptance catalog remains pinned when the stable publisher path is overwritten", () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "catalog-override" });
    mkdirSync(env.stateRoot, { recursive: true, mode: 0o700 });
    writeAcceptanceCatalog(env);
    writeFileSync(path.join(env.stateRoot, "merged-models.json"), JSON.stringify({ models: [{ slug: "native/accidental" }] }), { mode: 0o600 });
    assert.equal(runtimeEnv(env).CODEX_ROUTER_CATALOG, env.acceptanceCatalogPath);
    assert.deepEqual(JSON.parse(readFileSync(env.acceptanceCatalogPath, "utf8")), acceptanceCatalogFixture());
    assert.equal(lstatSync(env.acceptanceCatalogPath).isSymbolicLink(), false);
    assertPrivateFile(env.acceptanceCatalogPath);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    if (process.platform !== "win32") assert.equal(statSync(path.join(root, "installer.txt")).mode & 0o777, 0o600);
    assert.equal(existsSync(path.join(root, "evidence", "clean-install.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pushed harness resolves github then origin then upstream without probing before local provenance", () => {
  const commit = "a".repeat(40);
  const source = (argument) => readFileSync(path.join(repositoryRoot, argument.slice(commit.length + 1)));
  const resolver = (remotes, upstream) => (args, options = {}) => {
    if (args[0] === "remote") return `${remotes.join("\n")}\n`;
    if (args[0] === "rev-parse") return `${upstream}\n`;
    if (args[0] === "show") return options.encoding === "buffer" ? source(args[1]) : source(args[1]).toString("utf8");
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };

  assert.deepEqual(resolvePushedRemote({ git: resolver(["github", "origin"], "origin/main") }), { remote: "github", ref: "refs/heads/main" });
  assert.deepEqual(resolvePushedRemote({ git: resolver(["origin"], "origin/main") }), { remote: "origin", ref: "refs/heads/main" });
  assert.deepEqual(resolvePushedRemote({ git: resolver(["fork"], "fork/release/candidate") }), { remote: "fork", ref: "refs/heads/release/candidate" });
  assert.throws(() => resolvePushedRemote({ git: resolver([], "") }), /cannot resolve.*remote/i);

  const dirtyCalls = [];
  assert.throws(() => assertPushedHarness(commit, {
    git(args) { dirtyCalls.push(args); if (args[0] === "status") return "?? scripts/verify-isolated-install.mjs\n"; throw new Error("network or source read must not run for dirty harness"); },
    remoteProbe() { throw new Error("network must not run for dirty harness"); },
  }), /dirty or untracked/i);
  assert.deepEqual(dirtyCalls, [["status", "--porcelain", "--", "scripts/verify-isolated-install.mjs"]]);

  const probes = [];
  assert.equal(assertPushedHarness(commit, {
    git(args, options = {}) {
      if (args[0] === "status") return "";
      if (args[0] === "show") return options.encoding === "buffer" ? source(args[1]) : source(args[1]).toString("utf8");
      if (args[0] === "remote") return "origin\n";
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
    remoteProbe(remote, ref) { probes.push([remote, ref]); return `${commit}\t${ref}\n`; },
  }), true);
  assert.deepEqual(probes, [["origin", "refs/heads/main"]]);

  assert.throws(() => assertPushedHarness(commit, {
    git: committedHarnessGit(commit, { remotes: ["origin"], upstream: "origin/main" }),
    remoteProbe: (_remote, ref) => `${"b".repeat(40)}\t${ref}\n`,
  }), /source commit is not origin\/main/);
});

test("current pushed commit gate checks HEAD before its resolved remote", () => {
  const commit = "c".repeat(40);
  const calls = [];
  assert.throws(() => assertCurrentPushedCommit(commit, {
    git(args) { calls.push(args); if (args.join(" ") === "rev-parse HEAD") return `${"d".repeat(40)}\n`; throw new Error("remote resolution must not run after HEAD mismatch"); },
    remoteProbe() { throw new Error("network must not run after HEAD mismatch"); },
  }), /current source commit/);
  assert.deepEqual(calls, [["rev-parse", "HEAD"]]);

  const probes = [];
  assert.equal(assertCurrentPushedCommit(commit, {
    git(args) {
      if (args.join(" ") === "rev-parse HEAD") return `${commit}\n`;
      if (args[0] === "remote") return "origin\n";
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
    remoteProbe(remote, ref) { probes.push([remote, ref]); return `${commit}\t${ref}\n`; },
  }), true);
  assert.deepEqual(probes, [["origin", "refs/heads/main"]]);

  assert.throws(() => assertCurrentPushedCommit(commit, {
    git(args) {
      if (args.join(" ") === "rev-parse HEAD") return `${commit}\n`;
      if (args[0] === "remote") return "origin\n";
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    },
    remoteProbe: (_remote, ref) => `${"d".repeat(40)}\t${ref}\n`,
  }), /source commit is not origin\/main/);
});

test("pre-push unit guards reject stale provenance and non-macOS roots without writing or passed evidence", () => {
  const { sourceRoot } = fixture();
  mkdirSync(path.join(sourceRoot, "generated", "acceptance"), { recursive: true });
  const root = mkdtempSync(path.join(sourceRoot, "generated", "acceptance", "task2-clean-cli-"));
  try {
    const before = existsSync(path.join(root, "checkout"));
    assert.throws(() => assertCliPreflight(root, { platform: "linux" }), /macOS-only/);
    assert.equal(existsSync(path.join(root, "checkout")), before);
    const stale = "a".repeat(40);
    assert.throws(() => assertPushedHarness(stale, { remoteProbe: (_remote, ref) => `${"b".repeat(40)}\t${ref}\n`, git: committedHarnessGit(stale) }), /github\/main/);
    assert.throws(() => assertPushedHarness("a".repeat(40), { remoteProbe: () => "a".repeat(40), git: (args) => args[0] === "status" ? "?? scripts/verify-isolated-install.mjs" : "" }), /dirty or untracked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
