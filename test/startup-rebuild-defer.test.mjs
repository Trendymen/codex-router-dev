import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";

import {
  armStartupRebuildDefer,
  cleanupConsumedStartupRebuildDefer,
  cleanupStartupRebuildDefer,
  consumeStartupRebuildDefer,
  scheduleStartupRebuildSelfHeal,
  spawnDeferredStartupRebuild,
  processStartIdentity,
  signalStartupRebuildCompletion,
  startupRebuildCompletionPath,
  startupRebuildDeferPath,
  waitForStartupRebuildHandoff,
} from "../src/startup-rebuild-defer.mjs";

const parentIdentity = () => ({ kind: "ps-lstart", value: "fixture-start" });
const alive = () => {};
function fixture() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-startup-defer-"));
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}
function arm(stateDir, overrides = {}) {
  return armStartupRebuildDefer({
    stateDir,
    parentPid: 4321,
    parentIdentity,
    token: "a".repeat(32),
    transactionToken: "b".repeat(32),
    ...overrides,
  });
}

test("slow live parent remains deferred beyond the former fixed timeout and consume is single-use", () => {
  const { stateDir, cleanup } = fixture();
  try {
    const armed = arm(stateDir);
    const value = JSON.parse(readFileSync(armed.armedPath, "utf8"));
    assert.deepEqual(Object.keys(value).sort(), ["parentPid", "parentStart", "token", "transactionToken", "version"]);
    const handoff = consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity, consumeToken: "c".repeat(32) });
    assert.equal(handoff?.token, armed.token);
    assert.equal(consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity }), undefined);
    cleanupConsumedStartupRebuildDefer(handoff);
  } finally { cleanup(); }
});

test("same PID with different process-start identity is rejected and cleaned", () => {
  const { stateDir, cleanup } = fixture();
  try {
    const armed = arm(stateDir);
    assert.equal(consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity: () => ({ kind: "ps-lstart", value: "reused-pid" }) }), undefined);
    assert.equal(cleanupStartupRebuildDefer(armed), false);
  } finally { cleanup(); }
});

test("unique armed paths isolate old cleanup, discard a dead marker, and fail closed for two live markers", () => {
  const { stateDir, cleanup } = fixture();
  try {
    const old = arm(stateDir, { token: "1".repeat(32) });
    const next = arm(stateDir, { token: "2".repeat(32) });
    assert.equal(cleanupStartupRebuildDefer(old), true);
    assert.equal(consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity, consumeToken: "3".repeat(32) })?.token, next.token);

    const stale = arm(stateDir, { token: "4".repeat(32), parentPid: 4444 });
    const live = arm(stateDir, { token: "5".repeat(32) });
    const kill = (pid) => { if (pid === 4444) throw new Error("dead"); };
    assert.equal(consumeStartupRebuildDefer({ stateDir, kill, parentIdentity, consumeToken: "6".repeat(32) })?.token, live.token);
    assert.equal(existsSync(stale.armedPath), false);

    arm(stateDir, { token: "7".repeat(32) });
    arm(stateDir, { token: "8".repeat(32) });
    assert.equal(consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity }), undefined);
  } finally { cleanup(); }
});

test("consume rejects a replacement inode after rename without deleting the replacement", () => {
  const { stateDir, cleanup } = fixture();
  try {
    arm(stateDir);
    let replacement;
    let consumed;
    assert.throws(() => consumeStartupRebuildDefer({
      stateDir,
      kill: alive,
      parentIdentity,
      afterRename: (value) => {
        consumed = value.consumed;
        replacement = `${consumed}.replacement`;
        renameSync(consumed, replacement);
        writeFileSync(consumed, "{}\n", { mode: 0o600 });
      },
    }), /changed inode/i);
    assert.deepEqual(readFileSync(consumed, "utf8"), "{}\n");
    assert.ok(readFileSync(replacement, "utf8").includes("transactionToken"));
  } finally { cleanup(); }
});

test("completion and parent death each cause exactly one self-heal wait exit and token-scoped cleanup", async () => {
  const { stateDir, cleanup } = fixture();
  try {
    const armed = arm(stateDir);
    const handoff = consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity, consumeToken: "c".repeat(32) });
    assert.equal(signalStartupRebuildCompletion(armed), true);
    await waitForStartupRebuildHandoff(handoff, { kill: alive, parentIdentity, intervalMs: 1 });
    cleanupConsumedStartupRebuildDefer(handoff);
    assert.equal(existsSync(startupRebuildCompletionPath(stateDir, armed.token)), false);
  } catch (error) {
    throw error;
  } finally { cleanup(); }

  const second = fixture();
  try {
    arm(second.stateDir);
    const handoff = consumeStartupRebuildDefer({ stateDir: second.stateDir, kill: alive, parentIdentity, consumeToken: "d".repeat(32) });
    await waitForStartupRebuildHandoff(handoff, { kill: () => { throw new Error("dead"); }, parentIdentity, intervalMs: 1 });
    cleanupConsumedStartupRebuildDefer(handoff);
  } finally { second.cleanup(); }
});

test("completion atomically moves the validated consumed inode and no-ops if service cleans it first", () => {
  const { stateDir, cleanup } = fixture();
  try {
    const armed = arm(stateDir);
    const handoff = consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity, consumeToken: "c".repeat(32) });
    assert.equal(signalStartupRebuildCompletion(armed), true);
    assert.ok(readFileSync(startupRebuildCompletionPath(stateDir, armed.token), "utf8").includes("\"version\": 2"));

    const next = arm(stateDir, { token: "d".repeat(32), transactionToken: "e".repeat(32) });
    const nextHandoff = consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity, consumeToken: "f".repeat(32) });
    assert.equal(signalStartupRebuildCompletion(next, {
      afterValidate: () => cleanupConsumedStartupRebuildDefer(nextHandoff),
    }), false);
    assert.equal(existsSync(startupRebuildCompletionPath(stateDir, next.token)), false);
    cleanupConsumedStartupRebuildDefer(handoff);
  } finally { cleanup(); }
});

test("process-start identity forces C locale independently of caller locale", () => {
  const calls = [];
  const execFile = (_bin, _args, options) => {
    calls.push(options);
    return "Mon Aug 25 10:11:12 2026\n";
  };
  assert.deepEqual(processStartIdentity(42, { execFile }), { kind: "ps-lstart", value: "Mon Aug 25 10:11:12 2026" });
  assert.equal(calls[0].env.LC_ALL, "C");
  assert.equal(calls[0].env.LANG, "C");
});

test("production retry logs use stable categories and never interpolate child error text", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "start.mjs"), "utf8");
  const startupBlock = source.slice(source.indexOf("deferredRebuildPromise ="), source.indexOf("console.error(\"[codex-router] ready"));
  assert.match(startupBlock, /error\?\.code \|\| error\?\.category/);
  assert.doesNotMatch(startupBlock, /error\?\.message|String\(error\)/);
});

test("late completion is a no-op after consumed cleanup and cannot cross token boundaries", () => {
  const { stateDir, cleanup } = fixture();
  try {
    const armed = arm(stateDir);
    const handoff = consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity, consumeToken: "c".repeat(32) });
    cleanupConsumedStartupRebuildDefer(handoff);
    assert.equal(signalStartupRebuildCompletion(armed), false);
    assert.equal(existsSync(startupRebuildCompletionPath(stateDir, armed.token)), false);
    const other = arm(stateDir, { token: "d".repeat(32), transactionToken: "e".repeat(32) });
    consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity, consumeToken: "f".repeat(32) });
    assert.equal(signalStartupRebuildCompletion({ ...other, token: armed.token }), false);
    assert.equal(signalStartupRebuildCompletion(other), true);
  } finally { cleanup(); }
});

test("post-health self-heal rebuilds exactly once after parent completion or crash", async () => {
  const handoff = { token: "a".repeat(32), transactionToken: "b".repeat(32) };
  const events = [];
  await scheduleStartupRebuildSelfHeal(handoff, {
    waitForHandoff: async () => events.push("completion-after-lock-release"),
    rebuild: async () => events.push("rebuild"),
    cleanup: () => events.push("cleanup"),
  });
  assert.deepEqual(events, ["completion-after-lock-release", "rebuild", "cleanup"]);

  const crashed = [];
  await scheduleStartupRebuildSelfHeal(handoff, {
    waitForHandoff: async () => crashed.push("parent-dead-after-health"),
    rebuild: async () => crashed.push("rebuild"),
    cleanup: () => crashed.push("cleanup"),
  });
  assert.deepEqual(crashed, ["parent-dead-after-health", "rebuild", "cleanup"]);
});

test("self-heal retries bounded backoff until success and abort stops pending retry immediately", async () => {
  const handoff = { token: "a".repeat(32), transactionToken: "b".repeat(32) };
  const retries = [];
  let attempts = 0;
  await scheduleStartupRebuildSelfHeal(handoff, {
    waitForHandoff: async () => {},
    rebuild: async () => { attempts += 1; if (attempts < 3) throw new Error("catalog lock timeout"); },
    retryDelay: async () => {},
    onRetry: (_error, detail) => retries.push(detail),
    cleanup: () => {},
  });
  assert.equal(attempts, 3);
  assert.deepEqual(retries.map(({ attempt, delayMs }) => [attempt, delayMs]), [[1, 100], [2, 200]]);

  const controller = new AbortController();
  let abortedAttempts = 0;
  const result = await scheduleStartupRebuildSelfHeal(handoff, {
    signal: controller.signal,
    waitForHandoff: async () => {},
    rebuild: async () => { abortedAttempts += 1; throw new Error("retryable"); },
    retryDelay: async (_ms, { signal }) => { controller.abort(); if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
    cleanup: () => {},
  });
  assert.equal(result, false);
  assert.equal(abortedAttempts, 1);

  const healthRetries = [];
  let healthAttempts = 0;
  await scheduleStartupRebuildSelfHeal(handoff, {
    waitForHandoff: async () => {},
    rebuild: async () => { healthAttempts += 1; if (healthAttempts === 1) throw new Error("child exited code=1"); },
    retryDelay: async () => {},
    onRetry: (_error, detail) => healthRetries.push(detail),
    cleanup: () => {},
  });
  assert.deepEqual(healthRetries.map(({ category, delayMs }) => [category, delayMs]), [["child-health", 1_000]]);

  const shifted = [];
  let shiftedAttempts = 0;
  await scheduleStartupRebuildSelfHeal(handoff, {
    waitForHandoff: async () => {},
    rebuild: async () => {
      shiftedAttempts += 1;
      if (shiftedAttempts === 1) throw new Error("catalog lock timeout");
      if (shiftedAttempts === 2) throw new Error("child exited code=1");
    },
    retryDelay: async () => {},
    onRetry: (_error, detail) => shifted.push([detail.category, detail.delayMs]),
    cleanup: () => {},
  });
  assert.deepEqual(shifted, [["catalog-lock", 100], ["child-health", 1_000]]);
});

test("SIGTERM-style abort stops a live-parent handoff promptly and still cleans its token files", async () => {
  const controller = new AbortController();
  const events = [];
  const promise = scheduleStartupRebuildSelfHeal({ token: "a".repeat(32), transactionToken: "b".repeat(32) }, {
    signal: controller.signal,
    waitForHandoff: async (_handoff, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
    rebuild: async () => events.push("must-not-rebuild"),
    cleanup: () => events.push("cleanup"),
  });
  controller.abort();
  assert.equal(await promise, false);
  assert.deepEqual(events, ["cleanup"]);
});

test("SIGTERM kills an in-flight deferred rebuild child and schedule resolves without an orphan", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 987_654;
  child.stderr = new EventEmitter();
  let killed = 0;
  child.kill = () => {
    killed += 1;
    queueMicrotask(() => {
      child.emit("exit", null, "SIGTERM");
      child.emit("close", null, "SIGTERM");
    });
    return true;
  };
  let spawned = 0;
  const promise = scheduleStartupRebuildSelfHeal({ token: "a".repeat(32), transactionToken: "b".repeat(32) }, {
    signal: controller.signal,
    waitForHandoff: async () => {},
    rebuild: ({ signal }) => spawnDeferredStartupRebuild({ signal, platform: "darwin", groupProbe: () => false, spawnImpl: () => { spawned += 1; return child; } }),
    cleanup: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await promise, false);
  assert.equal(spawned, 1);
  assert.equal(killed, 1);
});

test("owned child escalates TERM to KILL after bounded grace when it ignores TERM", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 987_653;
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => {
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
    });
    return true;
  };
  const running = spawnDeferredStartupRebuild({
    platform: "darwin",
    signal: controller.signal,
    termGraceMs: 1,
    spawnImpl: () => child,
    groupProbe: () => !signals.includes("SIGKILL"),
  });
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("termination reports a bounded explicit error when its process group remains live after KILL", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 987_651;
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => {
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
    });
    return true;
  };
  const running = spawnDeferredStartupRebuild({
    platform: "darwin",
    signal: controller.signal,
    termGraceMs: 1,
    groupWaitAttempts: 1,
    groupWaitMs: 1,
    spawnImpl: () => child,
    groupProbe: () => true,
  });
  controller.abort();
  await assert.rejects(running, /remained live after TERM and SIGKILL/i);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL", "SIGKILL"]);
});

test("abort settles from independent group proof even when child never emits exit or close", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 987_650;
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  const running = spawnDeferredStartupRebuild({
    platform: "darwin",
    signal: controller.signal,
    termGraceMs: 1,
    groupWaitAttempts: 1,
    groupWaitMs: 1,
    spawnImpl: () => child,
    groupProbe: () => false,
  });
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("group probe errors fail closed as termination verification errors", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 987_649;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const running = spawnDeferredStartupRebuild({
    platform: "darwin",
    signal: controller.signal, spawnImpl: () => child,
    groupProbe: () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
  });
  controller.abort();
  await assert.rejects(running, /termination verification failed.*permission denied/i);
});

test("production child seam is detached and targets only the checked-in rebuild helper", async () => {
  const child = new EventEmitter();
  child.pid = 987_652;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  let captured;
  const running = spawnDeferredStartupRebuild({
    platform: "darwin",
    groupProbe: () => false,
    spawnImpl: (command, args, options) => {
      captured = { command, args, options };
      queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); });
      return child;
    },
  });
  assert.equal(await running, true);
  assert.equal(captured.command, process.execPath);
  assert.match(captured.args[0], /src[\\/]deferred-startup-rebuild-child\.mjs$/);
  assert.equal(captured.options.detached, true);
});

test("POSIX owned child and TERM-ignoring grandchild are both gone after abort", {
  skip: process.platform === "win32" && "process-group cancellation is POSIX-only",
}, async () => {
  const { stateDir, cleanup } = fixture();
  const pidFile = path.join(stateDir, "grandchild.pid");
  const controller = new AbortController();
  const grandchild = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
  const child = `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; const c = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}]); process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(()=>{},1000);`;
  let running;
  let childPid;
  let childIdentity;
  let grandchildPid;
  let grandchildIdentity;
  let verifiedGone = false;
  const settledWithin = async (promise, milliseconds = 250) => {
    if (!promise) return true;
    return Promise.race([
      promise.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)),
    ]);
  };
  const killIfSameProcess = (pid, identity, signal) => {
    if (!pid || !identity) return;
    try {
      const current = processStartIdentity(pid);
      if (current.kind !== identity.kind || current.value !== identity.value) return;
      process.kill(pid, signal);
    } catch {}
  };
  try {
    running = spawnDeferredStartupRebuild({
      signal: controller.signal,
      termGraceMs: 20,
      childArgs: ["--input-type=module", "--eval", child],
      spawnImpl: (...args) => {
        const owned = spawn(...args);
        childPid = owned.pid;
        childIdentity = processStartIdentity(childPid);
        return owned;
      },
    });
    for (let attempt = 0; attempt < 50 && !existsSync(pidFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(pidFile), true, "grandchild was not started");
    grandchildPid = Number(readFileSync(pidFile, "utf8"));
    grandchildIdentity = processStartIdentity(grandchildPid);
    controller.abort();
    await assert.rejects(running, { name: "AbortError" });
    assert.throws(() => process.kill(grandchildPid, 0), /ESRCH|no such process/i);
    verifiedGone = true;
  } finally {
    controller.abort();
    await settledWithin(running);
    if (!verifiedGone) {
      if (childPid && childIdentity) {
        try {
          const current = processStartIdentity(childPid);
          if (current.kind === childIdentity.kind && current.value === childIdentity.value) {
            process.kill(-childPid, "SIGKILL");
          }
        } catch {}
      }
      killIfSameProcess(grandchildPid, grandchildIdentity, "SIGKILL");
      await settledWithin(running);
    }
    cleanup();
  }
});

test("nonprivate and link markers fail closed; owner cleanup cannot remove another token", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { stateDir, cleanup } = fixture();
  try {
    const first = arm(stateDir);
    chmodSync(first.armedPath, 0o644);
    assert.throws(() => consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity }), /private/i);
    rmSync(first.armedPath, { force: true });
    symlinkSync("outside.json", first.armedPath, "file");
    assert.throws(() => consumeStartupRebuildDefer({ stateDir, kill: alive, parentIdentity }), /regular file|marker/i);
    rmSync(first.armedPath, { force: true });
    const second = arm(stateDir, { token: "e".repeat(32) });
    assert.equal(cleanupStartupRebuildDefer({ ...second, token: "f".repeat(32) }), false);
    assert.ok(readFileSync(second.armedPath, "utf8").includes("e".repeat(32)));
  } finally { cleanup(); }
});
