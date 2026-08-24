import { mkdirSync } from "node:fs";
import path from "node:path";

import lockfile from "proper-lockfile";

import { STATE_DIR } from "./paths.mjs";

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_RETRY_MS = 250;
// The lock covers only state mutation, publication, and rollback. Detached
// model downloads happen before it is acquired. Keep the stale horizon beyond
// the synchronous Codex probes a catalog publication can perform, while the
// heartbeat makes a live async transaction safe to wait on.
const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
// This capability is deliberately module-private.  A caller that happens to
// know a lock path must not be able to claim it holds the lock, and a context
// from a completed transaction must not reopen a re-entrant path later.
const HELD_CONTEXTS = new WeakMap();

function positiveInteger(value, fallback, minimum = 1) {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

export function modelOverlayLockTarget(stateDir = STATE_DIR) {
  return path.join(stateDir, "model-overlay-transaction");
}

export function assertModelOverlayLockHeld(context, stateDir = STATE_DIR) {
  if (!context || HELD_CONTEXTS.get(context) !== path.resolve(stateDir)) {
    throw new Error("Model-overlay alreadyLocked context is absent, forged, or bound to another state directory.");
  }
  return context;
}

function lockWaitError(waitMs, cause) {
  const seconds = Math.max(1, Math.ceil(waitMs / 1_000));
  const error = new Error(
    `Another model-overlay transaction is still running after ${seconds} second${seconds === 1 ? "" : "s"}. ` +
      "Wait for that router command to finish, then retry; abandoned locks are recovered automatically.",
    { cause },
  );
  error.code = "model_overlay_locked";
  return error;
}

/**
 * Serialize the complete model-overlay transaction across CLI, tray, desktop,
 * and detached worker processes.  Whenever both locks are required, this is
 * the outer lock and catalog-publication is acquired inside it.  Reversing
 * that order can deadlock a state mutation against a migration/uninstall.
 */
export async function withModelOverlayLock(
  operation,
  {
    stateDir = STATE_DIR,
    waitMs = DEFAULT_WAIT_MS,
    retryMs = DEFAULT_RETRY_MS,
    staleMs = DEFAULT_STALE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  } = {},
) {
  const normalizedWaitMs = positiveInteger(waitMs, DEFAULT_WAIT_MS, 0);
  const normalizedRetryMs = positiveInteger(retryMs, DEFAULT_RETRY_MS);
  const normalizedStaleMs = positiveInteger(staleMs, DEFAULT_STALE_MS, 2_000);
  const normalizedHeartbeatMs = Math.min(
    positiveInteger(heartbeatMs, DEFAULT_HEARTBEAT_MS, 1_000),
    normalizedStaleMs / 2,
  );
  const retries = Math.max(
    0,
    Math.ceil(normalizedWaitMs / normalizedRetryMs) - 1,
  );

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const target = modelOverlayLockTarget(stateDir);
  let release;
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      lockfilePath: `${target}.lock`,
      stale: normalizedStaleMs,
      update: normalizedHeartbeatMs,
      retries: {
        retries,
        factor: 1,
        minTimeout: normalizedRetryMs,
        maxTimeout: normalizedRetryMs,
        randomize: false,
      },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") throw lockWaitError(normalizedWaitMs, error);
    throw error;
  }

  const context = Object.freeze({});
  HELD_CONTEXTS.set(context, path.resolve(stateDir));
  let result;
  let operationError;
  try {
    result = await operation(context);
  } catch (error) {
    operationError = error;
  }

  let releaseError;
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }
  HELD_CONTEXTS.delete(context);

  if (operationError) {
    if (releaseError && typeof operationError === "object") {
      try {
        operationError.modelOverlayLockReleaseError = releaseError;
      } catch {
        // Preserve the original operation error even if it is frozen.
      }
    }
    throw operationError;
  }
  if (releaseError) {
    throw new Error(
      `The model-overlay transaction completed, but its lock could not be released (${releaseError.message}).`,
      { cause: releaseError },
    );
  }
  return result;
}
