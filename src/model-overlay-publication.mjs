import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const CHILD_ARGUMENT = "--publish-in-fresh-process";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

// JSON-serializable on purpose: a detached uninstall worker can carry the
// pre-withdrawal state in its protected progress document if a caller needs to
// hand the transaction across a process boundary.
export function captureModelOverlayFiles(
  files,
  {
    exists = existsSync,
    read = readFileSync,
  } = {},
) {
  return [...new Set(files.map((file) => path.resolve(file)))].map((file) => {
    const existed = exists(file);
    return {
      path: file,
      existed,
      contents: existed ? Buffer.from(read(file)).toString("base64") : null,
    };
  });
}

export function restoreModelOverlayFiles(
  snapshots,
  {
    exists = existsSync,
    mkdir = mkdirSync,
    write = writeFileSync,
    chmod = chmodSync,
    protect = protectPrivateFile,
    unlink = unlinkSync,
  } = {},
) {
  for (const snapshot of snapshots) {
    if (!snapshot?.path || !path.isAbsolute(snapshot.path)) {
      throw new Error("A model-overlay snapshot has no absolute path.");
    }
    if (!snapshot.existed) {
      if (exists(snapshot.path)) unlink(snapshot.path);
      continue;
    }
    mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
    write(snapshot.path, Buffer.from(snapshot.contents || "", "base64"), { mode: 0o600 });
    chmod(snapshot.path, 0o600);
    // chmod is the complete privacy boundary on POSIX, but it does not remove
    // inherited ACLs on Windows. A rollback can recreate a file that was
    // deleted during the failed mutation, so apply the same owner-only ACL
    // protection as every normal private-state write.
    protect(snapshot.path);
  }
  return snapshots;
}

/**
 * Rebuild the shared Node routing publication, then every installed client's
 * model list. The provider registry is read directly by the Router; there is
 * no generated gateway document to keep in sync.
 *
 * This is exported for dependency-injected tests and for the fresh child below.
 * Callers that have already loaded model-registry.mjs must use
 * publishModelOverlayFresh(): user-model overlays are read at module load, so
 * rebuilding in their process can silently publish the pre-mutation model set.
 */
export async function rebuildModelOverlayPublication({
  refreshTargets,
} = {}) {
  const refresh = refreshTargets ||
    (await import("./target-integration.mjs")).refreshTargetPickerIfInstalled;

  const targetsRefreshed = refresh();
  return { targetsRefreshed };
}

/**
 * Publish from a new Node process so the registry observes the overlay that was
 * just committed to disk. The child also provides one fail-closed ordering
 * point: the Node route publication is refreshed before the Codex catalog
 * becomes visible.
 */
export function publishModelOverlayFresh({
  spawn = spawnSync,
  executable = process.execPath,
  sourceRoot = REPO_ROOT,
  environment = process.env,
} = {}) {
  const result = spawn(executable, [SELF, CHILD_ARGUMENT], {
    cwd: sourceRoot,
    env: { ...environment, MODEL_ROUTER_TARGET: "codex" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = String(result?.stderr || "").trim();
    throw new Error(detail || "The shared model routes could not be published.");
  }
  return { published: true };
}

/**
 * Complete publication and, when requested, reload the installed router.
 *
 * A synchronous toggle is fail-closed: its publication or restart error is
 * thrown. A download/removal has already changed physical state, so its caller
 * asks for warningOnly and receives the same catalogError/restartError fields
 * the existing progress surfaces understand instead of a false operation
 * failure.
 */
export async function applyModelOverlayPublication({
  warningOnly = false,
  restart = false,
  publish = publishModelOverlayFresh,
  restartService,
} = {}) {
  const warnings = {};
  try {
    await publish();
  } catch (error) {
    if (!warningOnly) throw error;
    warnings.catalogError = errorMessage(error);
    // A restart is the commit point for the running service. Do not load an
    // overlay whose client publication did not finish; the completed
    // physical operation remains truthful and its warning tells the operator
    // that publication (and therefore restart) is still needed.
    return warnings;
  }

  if (restart) {
    try {
      const reload = restartService || (async () => {
        const { restartRouterServiceIfInstalled } = await import("./router-restart.mjs");
        return restartRouterServiceIfInstalled();
      });
      await reload();
    } catch (error) {
      if (!warningOnly) throw error;
      warnings.restartError = errorMessage(error);
    }
  }
  return warnings;
}

export async function restorePublishedModelOverlay({
  restore,
  restart = false,
  warningOnly = false,
  applyPublication = applyModelOverlayPublication,
  restartService,
} = {}) {
  await restore();
  await applyPublication({ restart, restartService, warningOnly });
}

export function aggregateRollbackError(operationError, rollbackError) {
  return new AggregateError(
    [asError(operationError), asError(rollbackError)],
    "The model-overlay operation failed and its previous state could not be fully restored.",
    { cause: asError(operationError) },
  );
}

/**
 * Mutate state, publish it, and restart only after publication succeeds.
 * Any failure restores the exact prior state and republishes/restarts that
 * state. The original error is preserved when rollback succeeds; an
 * AggregateError makes a failed rollback impossible to mistake for success.
 */
export async function transactModelOverlayMutation({
  files,
  capture,
  mutate,
  restore,
  restart = false,
  warningOnly = false,
  applyPublication = applyModelOverlayPublication,
  restartService,
  lock = true,
} = {}) {
  const transaction = async () => {
    // Capture only after the cross-process lock is held. Capturing before the
    // lock lets a queued operation retain a stale snapshot and roll back a
    // later successful mutation when its own publication fails.
    const snapshots = capture
      ? await capture()
      : files
        ? captureModelOverlayFiles(files)
        : undefined;
    const restoreState = snapshots === undefined
      ? restore
      : (nextSnapshots = snapshots) => restore
        ? restore(nextSnapshots)
        : restoreModelOverlayFiles(nextSnapshots);

    const restartRequested = typeof restart === "function" ? await restart() : restart;
    try {
      await mutate();
      return await applyPublication({
        restart: restartRequested,
        restartService,
        warningOnly,
      });
    } catch (operationError) {
      try {
        if (!restoreState) throw new Error("A model-overlay transaction has no rollback state.");
        await restorePublishedModelOverlay({
          restore: restoreState,
          restart: restartRequested,
          warningOnly,
          applyPublication,
          restartService,
        });
      } catch (rollbackError) {
        throw aggregateRollbackError(operationError, rollbackError);
      }
      throw operationError;
    }
  };
  return lock ? withModelOverlayLock(transaction) : transaction();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] !== CHILD_ARGUMENT) {
    console.error(`Usage: node ${path.basename(SELF)} ${CHILD_ARGUMENT}`);
    process.exit(2);
  }
  try {
    const result = await rebuildModelOverlayPublication();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(1);
  }
}
