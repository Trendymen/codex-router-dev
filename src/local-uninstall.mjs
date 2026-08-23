import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isLocalModelEnabled,
  LOCAL_MODELS_STATE_PATH,
  setLocalModelEnabled,
} from "./local-models.mjs";
import {
  readLocalDownload,
  writeLocalDownload,
} from "./local-download.mjs";
import { normalizeLocalModelTag } from "./local-model-ref.mjs";
import {
  applyModelOverlayPublication,
  captureModelOverlayFiles,
  restoreModelOverlayFiles,
  restorePublishedModelOverlay,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { PROVIDER_SELECTION_PATH } from "./paths.mjs";
import { USER_MODELS_PATH } from "./user-models.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");

export async function uninstallLocalModelTransaction(
  tag,
  {
    enabled = isLocalModelEnabled,
    disable = (model) => setLocalModelEnabled(model, false),
    capture = () => captureModelOverlayFiles([
      LOCAL_MODELS_STATE_PATH,
      USER_MODELS_PATH,
      PROVIDER_SELECTION_PATH,
    ]),
    restoreFiles = restoreModelOverlayFiles,
    applyPublication = applyModelOverlayPublication,
    restartService,
    cancelled = () => false,
  } = {},
) {
  return withModelOverlayLock(async () => {
    // The enabled decision and snapshot must be made after acquiring the
    // process-wide lock. This operation keeps the lock through publication so
    // a concurrent route refresh cannot restore a stale local chat entry.
    const wasEnabled = enabled(tag);
    const snapshots = await capture();
    const restore = () => restoreFiles(snapshots);
    await transactModelOverlayMutation({
      lock: false,
      mutate: () => disable(tag),
      restore,
      restart: wasEnabled,
      applyPublication,
      restartService,
    });
    if (cancelled()) {
      await restorePublishedModelOverlay({
        restore,
        restart: wasEnabled,
        applyPublication,
        restartService,
      });
      return { cancelled: true, removed: false, wasEnabled };
    }

    // Withdrawal is intentionally non-destructive: local weights remain in
    // Ollama/LM Studio for a future Vision reader pin.
    return { cancelled: false, removed: false, withdrawn: true, wasEnabled };
  });
}

async function main() {
  const tag = normalizeLocalModelTag(process.argv[2]);
  const startedAt = Date.now();
  const existing = readLocalDownload();
  if (existing?.status === "cancelled") return;

  writeLocalDownload({
    version: 1,
    kind: "uninstall",
    tag,
    status: "uninstalling",
    detail: "Withdrawing model route before removal",
    percent: 0,
    startedAt,
    updatedAt: startedAt,
    controllerPid: null,
    workerPid: process.pid,
  });

  try {
    const removal = await uninstallLocalModelTransaction(tag, {
      cancelled: () => readLocalDownload()?.status === "cancelled",
    });
    if (removal.cancelled) return;

    const finalized = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, "src", "control.mjs"), "local-models", "finalize-uninstall", tag],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, MODEL_ROUTER_TARGET: "codex" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    let publication = {};
    if (typeof finalized.stdout === "string" && finalized.stdout.trim()) {
      try {
        publication = JSON.parse(finalized.stdout.trim());
      } catch {
        // A successful removal is still truthful even if a future control
        // build adds human-readable output around the finalization JSON.
      }
    }
    const catalogError = publication.catalogError || (
      finalized.error || finalized.status !== 0
        ? "The local Vision route was withdrawn, but the catalog could not be refreshed."
        : undefined
    );
    const restartError = publication.restartError;
    const detail = catalogError
      ? "Vision route withdrawn · catalog refresh needed"
      : restartError
        ? "Vision route withdrawn · router restart needed"
        : "Vision route withdrawn · weights retained";
    writeLocalDownload({
      ...readLocalDownload(),
      version: 1,
      kind: "uninstall",
      tag,
      status: "done",
      detail,
      percent: 100,
      startedAt,
      updatedAt: Date.now(),
      controllerPid: null,
      workerPid: null,
      ...(catalogError ? { catalogError } : {}),
      ...(restartError ? { restartError } : {}),
      error: undefined,
    });
  } catch (error) {
    writeLocalDownload({
      ...readLocalDownload(),
      version: 1,
      kind: "uninstall",
      tag,
      status: "error",
      detail: "Removal failed",
      percent: 0,
      startedAt,
      updatedAt: Date.now(),
      controllerPid: null,
      workerPid: process.pid,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
