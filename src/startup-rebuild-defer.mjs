import { randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { SOURCE_ROOT, STATE_DIR } from "./paths.mjs";
import { privateFileIsProtected, writePrivateJson } from "./file-security.mjs";

const MAX_MARKER_BYTES = 4_096;
const WAIT_INTERVAL_MS = 100;
const STDERR_CAP_BYTES = 64 * 1024;
const ARMED_PREFIX = "startup-rebuild-defer.armed.";
const ARMED_SUFFIX = ".json";

function token128() { return randomBytes(16).toString("hex"); }
function identityOf(stat) { return Object.freeze({ dev: BigInt(stat.dev), ino: BigInt(stat.ino) }); }
function sameIdentity(left, right) { return left && right && left.dev === right.dev && left.ino === right.ino; }

function regularPrivate(pathname, stat, isPrivate) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Startup rebuild defer marker is not a private regular file.");
  if (!isPrivate(pathname)) throw new Error("Startup rebuild defer marker is not private.");
}

export function startupRebuildDeferPath(stateDir = STATE_DIR, token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ""))) throw new Error("Startup rebuild defer armed path requires its 128-bit token.");
  return path.join(stateDir, `${ARMED_PREFIX}${token}${ARMED_SUFFIX}`);
}
export function startupRebuildCompletionPath(stateDir, token) { return path.join(stateDir, `startup-rebuild-defer.complete.${token}.json`); }
function consumedPath(stateDir, consumeToken) { return path.join(stateDir, `startup-rebuild-defer.consumed.${consumeToken}.json`); }

/** Stable PID-reuse defense for the production macOS updater. */
export function processStartIdentity(pid, { execFile = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid parent process id.");
  const value = execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  }).trim();
  if (!value) throw new Error("Could not resolve parent process start identity.");
  return Object.freeze({ kind: "ps-lstart", value });
}

function parentMatches(marker, { kill = process.kill, parentIdentity = processStartIdentity } = {}) {
  try { kill(marker.parentPid, 0); } catch { return false; }
  try {
    const current = parentIdentity(marker.parentPid);
    return current?.kind === marker.parentStart?.kind && current?.value === marker.parentStart?.value;
  } catch { return false; }
}

function validMarker(marker) {
  return marker && marker.version === 2
    && typeof marker.token === "string" && /^[a-f0-9]{32}$/.test(marker.token)
    && typeof marker.transactionToken === "string" && /^[a-f0-9]{32}$/.test(marker.transactionToken)
    && Number.isSafeInteger(marker.parentPid) && marker.parentPid > 0
    && marker.parentStart?.kind === "ps-lstart" && typeof marker.parentStart.value === "string" && marker.parentStart.value.length > 0;
}

function readBoundJson(pathname, expectedIdentity, { open = openSync, close = closeSync, fstat = fstatSync, stat = statSync, read = readFileSync, noFollow = constants.O_NOFOLLOW || 0 } = {}) {
  const descriptor = open(pathname, constants.O_RDONLY | noFollow);
  try {
    const opened = identityOf(fstat(descriptor, { bigint: true }));
    if (!sameIdentity(opened, expectedIdentity)) throw new Error("Startup rebuild defer marker changed inode during consume.");
    const contents = read(descriptor, "utf8");
    if (Buffer.byteLength(contents) === 0 || Buffer.byteLength(contents) > MAX_MARKER_BYTES) throw new Error("Startup rebuild defer marker has an invalid size.");
    const after = identityOf(stat(pathname, { bigint: true }));
    if (!sameIdentity(after, opened)) throw new Error("Startup rebuild defer marker changed inode after read.");
    return JSON.parse(contents);
  } finally { close(descriptor); }
}

/** Arm a token-bound, non-secret handoff for exactly one immediate service start. */
export function armStartupRebuildDefer({ stateDir = STATE_DIR, parentPid = process.pid, parentIdentity = processStartIdentity, token = token128(), transactionToken = token128() } = {}) {
  if (!/^[a-f0-9]{32}$/.test(token) || !/^[a-f0-9]{32}$/.test(transactionToken)) throw new Error("Startup rebuild defer tokens must be random 128-bit hex values.");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const marker = { version: 2, token, transactionToken, parentPid, parentStart: parentIdentity(parentPid) };
  const armedPath = startupRebuildDeferPath(stateDir, token);
  writePrivateJson(armedPath, marker, { directoryMode: 0o700 });
  const armedIdentity = identityOf(lstatSync(armedPath, { bigint: true }));
  return Object.freeze({ stateDir, armedPath, armedIdentity, token, transactionToken });
}

/** Rename before opening and bind the entire read to the same inode. */
export function consumeStartupRebuildDefer({ stateDir = STATE_DIR, kill = process.kill, parentIdentity = processStartIdentity, isPrivate = privateFileIsProtected, consumeToken = token128(), afterRename, fs = {} } = {}) {
  const lstat = fs.lstat || lstatSync;
  const readdir = fs.readdir || readdirSync;
  const rename = fs.rename || renameSync;
  const unlink = fs.unlink || unlinkSync;
  let names;
  try { names = readdir(stateDir); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  const candidates = [];
  for (const name of names) {
    const match = new RegExp(`^${ARMED_PREFIX}([a-f0-9]{32})\\.json$`).exec(name);
    if (!match) continue;
    const armedPath = path.join(stateDir, name);
    let armedStat;
    try { armedStat = lstat(armedPath, { bigint: true }); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    regularPrivate(armedPath, armedStat, isPrivate);
    const armedIdentity = identityOf(armedStat);
    let marker;
    try { marker = readBoundJson(armedPath, armedIdentity, fs); } catch {
      try { if (sameIdentity(identityOf(lstat(armedPath, { bigint: true })), armedIdentity)) unlink(armedPath); } catch {}
      continue;
    }
    if (!validMarker(marker) || marker.token !== match[1] || !parentMatches(marker, { kill, parentIdentity })) {
      try { if (sameIdentity(identityOf(lstat(armedPath, { bigint: true })), armedIdentity)) unlink(armedPath); } catch {}
      continue;
    }
    candidates.push({ armedPath, armedIdentity, marker });
  }
  if (candidates.length !== 1) return undefined;
  const [{ armedPath, armedIdentity }] = candidates;
  const consumed = consumedPath(stateDir, consumeToken);
  try { rename(armedPath, consumed); } catch { return undefined; }
  let handoff;
  try {
    afterRename?.({ armedPath, consumed, armedIdentity });
    const consumedStat = lstat(consumed, { bigint: true });
    if (!sameIdentity(identityOf(consumedStat), armedIdentity)) {
      throw new Error("Startup rebuild defer marker changed inode during consume.");
    }
    // On Windows this invokes the ACL inspector only after the renamed path
    // is rebound to the same inode captured before rename.
    regularPrivate(consumed, consumedStat, isPrivate);
    const marker = readBoundJson(consumed, armedIdentity, fs);
    if (validMarker(marker) && parentMatches(marker, { kill, parentIdentity })) {
      handoff = Object.freeze({ stateDir, consumed, completion: startupRebuildCompletionPath(stateDir, marker.token), token: marker.token, transactionToken: marker.transactionToken, consumedIdentity: armedIdentity, parentPid: marker.parentPid, parentStart: marker.parentStart });
    }
    return handoff;
  } catch (error) {
    if (/not a private regular file|not private|changed inode/.test(String(error?.message || error))) throw error;
    return undefined;
  } finally {
    // Invalid data is never left armed. Valid handoff ownership transfers to start.
    if (!handoff) {
      try {
        const current = lstat(consumed, { bigint: true });
        if (sameIdentity(identityOf(current), armedIdentity)) unlink(consumed);
      } catch { /* never delete a replacement inode */ }
    }
  }
}

export function signalStartupRebuildCompletion(handle, { afterValidate } = {}) {
  if (!handle?.stateDir || !/^[a-f0-9]{32}$/.test(handle.token) || !/^[a-f0-9]{32}$/.test(handle.transactionToken)) return false;
  const consumed = hasValidConsumedMarker(handle);
  if (!consumed) return false;
  const completion = startupRebuildCompletionPath(handle.stateDir, handle.token);
  afterValidate?.(consumed);
  try {
    renameSync(consumed.pathname, completion);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const stat = lstatSync(completion, { bigint: true });
  if (!sameIdentity(identityOf(stat), consumed.identity)) throw new Error("Deferred startup completion changed inode during rename.");
  regularPrivate(completion, stat, privateFileIsProtected);
  const marker = readBoundJson(completion, consumed.identity);
  if (!validMarker(marker) || marker.token !== handle.token || marker.transactionToken !== handle.transactionToken) {
    throw new Error("Deferred startup completion did not retain its token-bound marker.");
  }
  return true;
}

function hasValidConsumedMarker(handle, { isPrivate = privateFileIsProtected } = {}) {
  let names;
  try { names = readdirSync(handle.stateDir); } catch { return false; }
  const prefix = "startup-rebuild-defer.consumed.";
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const pathname = path.join(handle.stateDir, name);
    try {
      const stat = lstatSync(pathname, { bigint: true });
      regularPrivate(pathname, stat, isPrivate);
      const marker = readBoundJson(pathname, identityOf(stat));
      if (validMarker(marker) && marker.token === handle.token && marker.transactionToken === handle.transactionToken) {
        return { pathname, identity: identityOf(stat) };
      }
    } catch {
      // A stale or foreign consumed entry never authorizes completion.
    }
  }
  return false;
}

export function cleanupStartupRebuildDefer(handle, { lstat = lstatSync, unlink = unlinkSync } = {}) {
  if (!handle?.armedPath || !handle?.token) return false;
  try {
    const stat = lstat(handle.armedPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (!sameIdentity(identityOf(stat), handle.armedIdentity)) return false;
    const marker = JSON.parse(readFileSync(handle.armedPath, "utf8"));
    if (marker?.token !== handle.token || marker?.transactionToken !== handle.transactionToken) return false;
    unlink(handle.armedPath);
    return true;
  } catch { return false; }
}

function completionMatches(handoff, isPrivate = privateFileIsProtected) {
  try {
    const stat = lstatSync(handoff.completion, { bigint: true });
    regularPrivate(handoff.completion, stat, isPrivate);
    const value = readBoundJson(handoff.completion, identityOf(stat));
    return validMarker(value) && value.token === handoff.token && value.transactionToken === handoff.transactionToken;
  } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function abortError() {
  return Object.assign(new Error("Deferred startup rebuild was aborted."), { name: "AbortError" });
}

function retryClass(error) {
  if (error?.category === "catalog-lock" || error?.code === "catalog_publication_locked" || error?.code === "model_overlay_locked") {
    return { category: "catalog-lock", initialMs: 100, maxMs: 5_000 };
  }
  if (error?.category === "child-health") {
    return { category: "child-health", initialMs: 1_000, maxMs: 60_000 };
  }
  const detail = String(error?.message || error || "");
  return /\b(lock|locked|timeout)\b/i.test(detail)
    ? { category: "catalog-lock", initialMs: 100, maxMs: 5_000 }
    : { category: "child-health", initialMs: 1_000, maxMs: 60_000 };
}

function wait(milliseconds, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Wait for parent completion or exact parent death; caller then self-heals. */
export async function waitForStartupRebuildHandoff(handoff, { kill = process.kill, parentIdentity = processStartIdentity, isPrivate = privateFileIsProtected, intervalMs = WAIT_INTERVAL_MS, delay = wait, signal } = {}) {
  while (true) {
    if (signal?.aborted) throw abortError();
    if (completionMatches(handoff, isPrivate) || !parentMatches(handoff, { kill, parentIdentity })) return;
    await delay(intervalMs, { signal });
  }
}

/** Schedule exactly one post-handoff rebuild after completion or parent death. */
export function scheduleStartupRebuildSelfHeal(handoff, {
  rebuild,
  onError = () => {},
  waitForHandoff = waitForStartupRebuildHandoff,
  cleanup = cleanupConsumedStartupRebuildDefer,
  signal,
  retryDelay = wait,
  initialRetryMs,
  maxRetryMs,
  onRetry = () => {},
} = {}) {
  if (typeof rebuild !== "function") throw new Error("Deferred startup rebuild requires rebuild().");
  return (async () => {
    try {
      await waitForHandoff(handoff, { signal });
      let retryMs;
      let retryMax;
      let lastCategory;
      let attempt = 0;
      while (!signal?.aborted) {
        try {
          await rebuild({ signal });
          return true;
        } catch (error) {
          if (signal?.aborted && error?.name !== "AbortError") {
            throw Object.assign(new Error("Deferred startup rebuild termination failed."), {
              code: "deferred_startup_rebuild_termination_failed",
              category: "termination",
              cause: error,
            });
          }
          attempt += 1;
          const profile = retryClass(error);
          if (lastCategory !== profile.category) {
            retryMs = initialRetryMs ?? profile.initialMs;
            retryMax = maxRetryMs ?? profile.maxMs;
            lastCategory = profile.category;
          }
          onRetry(error, { attempt, delayMs: retryMs, category: profile.category });
          await retryDelay(retryMs, { signal });
          retryMs = Math.min(retryMax, retryMs * 2);
        }
      }
      return false;
    } catch (error) {
      if (error?.name === "AbortError") return false;
      onError(error);
      throw error;
    } finally {
      cleanup(handoff);
    }
  })();
}

/**
 * Production rebuild seam: the service owns this detached child and kills its
 * process group on abort, so SIGTERM cannot leave an in-process catalog write
 * racing after the router has been stopped.
 */
function productionGroupProbe(pgid) {
  let output;
  try {
    output = execFileSync("/bin/ps", ["-axo", "pgid=,stat="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch (error) {
    throw new Error(`Could not verify deferred startup rebuild process group: ${error?.code || error?.message || String(error)}`);
  }
  for (const line of String(output).split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw new Error("Could not parse deferred startup rebuild process group status.");
    if (Number(match[1]) === pgid && !match[2].startsWith("Z")) return true;
  }
  return false;
}

export function spawnDeferredStartupRebuild({
  sourceRoot = SOURCE_ROOT,
  signal,
  spawnImpl = spawn,
  platform = process.platform,
  childArgs = [path.join(sourceRoot, "src", "deferred-startup-rebuild-child.mjs")],
  termGraceMs = 2_000,
  groupWaitAttempts = 80,
  groupWaitMs = 25,
  groupProbe = productionGroupProbe,
} = {}) {
  if (platform !== process.platform && (spawnImpl === spawn || groupProbe === productionGroupProbe)) {
    throw new Error("Deferred startup rebuild platform overrides require fully injected process primitives.");
  }
  if (platform === "win32") {
    return Promise.reject(new Error("Deferred startup rebuild child cancellation is supported only on macOS/POSIX service targets."));
  }
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, childArgs, {
      cwd: sourceRoot,
      stdio: ["ignore", "ignore", "pipe"],
      detached: platform !== "win32",
      windowsHide: true,
      env: process.env,
    });
    let stderr = Buffer.alloc(0);
    let aborted = false;
    let settled = false;
    let exitSeen = false;
    let closeSeen = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const groupGone = async (attempts = groupWaitAttempts) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          if (!child.pid || !groupProbe(child.pid)) return true;
        } catch (error) {
          throw new Error(`Deferred startup rebuild termination verification failed: ${error.message}`, { cause: error });
        }
        await new Promise((resolve) => setTimeout(resolve, groupWaitMs));
      }
      try { return !child.pid || !groupProbe(child.pid); }
      catch (error) { throw new Error(`Deferred startup rebuild termination verification failed: ${error.message}`, { cause: error }); }
    };
    const maybeSettleAfterClose = async (code, exitSignal) => {
      if (!exitSeen || !closeSeen) return;
      if (aborted || signal?.aborted) return;
      if (code === 0) settle(undefined, true);
      else {
        const category = code === 75 ? "catalog-lock" : "child-health";
        const error = Object.assign(new Error(`Deferred startup rebuild child failed (${category}).`), {
          code: category === "catalog-lock" ? "catalog_publication_locked" : "deferred_startup_rebuild_child_failed",
          category,
        });
        settle(error);
      }
    };
    const signalGroup = (name) => {
      try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch {} }
    };
    const onAbort = () => {
      if (aborted || settled) return;
      aborted = true;
      signalGroup("SIGTERM");
      void (async () => {
        try {
          const graceAttempts = Math.max(1, Math.ceil(termGraceMs / groupWaitMs));
          if (await groupGone(graceAttempts)) return settle(abortError());
          signalGroup("SIGKILL");
          if (await groupGone()) return settle(abortError());
          signalGroup("SIGKILL");
          if (await groupGone()) return settle(abortError());
          settle(new Error("Deferred startup rebuild process group remained live after TERM and SIGKILL."));
        } catch (error) {
          settle(error);
        }
      })();
    };
    child.stderr?.on("data", (chunk) => {
      if (stderr.byteLength >= STDERR_CAP_BYTES) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([stderr, bytes.subarray(0, STDERR_CAP_BYTES - stderr.byteLength)]);
    });
    child.once("error", (error) => {
      if (aborted || signal?.aborted) return;
      settle(Object.assign(new Error("Deferred startup rebuild child could not be spawned."), {
        code: "deferred_startup_rebuild_spawn_failed", category: "child-health", cause: error,
      }));
    });
    child.once("exit", (code, exitSignal) => {
      exitSeen = true;
      void maybeSettleAfterClose(code, exitSignal);
    });
    child.once("close", (code, exitSignal) => {
      closeSeen = true;
      void maybeSettleAfterClose(code, exitSignal);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function cleanupConsumedStartupRebuildDefer(handoff, { lstat = lstatSync, unlink = unlinkSync } = {}) {
  for (const [pathname, expected] of [[handoff?.consumed, handoff?.consumedIdentity], [handoff?.completion, handoff?.consumedIdentity]]) {
    if (!pathname) continue;
    try {
      const stat = lstat(pathname, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (expected && !sameIdentity(identityOf(stat), expected)) continue;
      unlink(pathname);
    } catch { /* only token-scoped best-effort cleanup */ }
  }
}
