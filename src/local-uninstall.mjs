import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isLocalModelEnabled,
  setLocalModelEnabled,
} from "./local-models.mjs";
import {
  readLocalDownload,
  writeLocalDownload,
} from "./local-download.mjs";
import { normalizeLocalModelTag } from "./local-model-ref.mjs";
import { currentServiceTarget, SOURCE_ROOT } from "./paths.mjs";
import {
  CLEANUP_OWNED_RUNTIME_IDS,
  ownedRuntimePaths,
  removeOwnedRuntime,
  resolveOwnedArtifact,
  restoreOwnedRuntime,
  snapshotOwnedRuntime,
} from "./owned-runtime-paths.mjs";
import { migrateRuntime } from "./runtime-migration.mjs";
import { refuseUnsupportedPlatform } from "./platform-gate.mjs";
import { shimReport } from "./codex-shim.mjs";

const SELF = fileURLToPath(import.meta.url);

/**
 * Shared Router-runtime uninstall boundary.
 *
 * This is intentionally separate from uninstallLocalModelTransaction: the
 * latter withdraws a Vision reader route and must never remove its weights.
 * Runtime cleanup receives only IDs from ownedRuntimePaths(), so a caller can
 * never turn this boundary into a recursive or wildcard deletion primitive.
 */
export async function uninstallRouterRuntimeTransaction({
  snapshot,
  target,
  runtimeRoots,
  ownedPaths,
  installReplacement = async () => {},
  verifyReplacement = async () => {},
  cleanupOld,
  restoreSnapshot,
  restartOldService,
} = {}) {
  const resolvedTarget = target || snapshot?.target;
  const paths = resolvedTarget ? ownedRuntimePaths(resolvedTarget, runtimeRoots || snapshot?.options || {}) : undefined;
  if (!paths) throw new Error("Router runtime uninstall requires a validated ServiceTarget.");
  const ids = ownedPaths || (paths ? Object.keys(paths.artifacts) : []);
  for (const id of ids) {
    if (!CLEANUP_OWNED_RUNTIME_IDS.includes(id)) {
      throw new Error(`Router runtime uninstall ID is protected or not cleanup-owned: ${String(id)}`);
    }
  }
  const resolved = ids.map((id) => resolveOwnedArtifact(id, paths));
  return migrateRuntime({
    snapshot,
    installReplacement,
    verifyReplacement,
    cleanupOld: cleanupOld || (async (runtimeSnapshot) => {
      removeOwnedRuntime(paths, { ids, snapshot: runtimeSnapshot });
    }),
    restoreSnapshot,
    restartOldService,
    // The resolved list is passed to an injected cleanup operation for the
    // acceptance harness; production cleanup uses the same resolver again.
    ...(cleanupOld ? { cleanupOld: async (runtimeSnapshot) => cleanupOld(resolved, runtimeSnapshot) } : {}),
  });
}

function runServiceMutation(action) {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", "service.mjs"), action],
    { cwd: SOURCE_ROOT, env: process.env, stdio: "inherit", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Router service ${action} exited with ${result.status}.`);
}

async function uninstallRouterRuntimeFromCli() {
  const target = currentServiceTarget();
  const shim = target.mode === "production" ? shimReport() : undefined;
  const paths = ownedRuntimePaths(target, shim?.installed && shim.shim ? { shimPath: shim.shim } : {});
  const snapshot = snapshotOwnedRuntime(paths);
  const clientTarget = process.argv[3] === "--client-target" ? process.argv[4] : undefined;
  if (!clientTarget || !["codex", "dsh", "gemini"].includes(clientTarget)) {
    throw new Error("Router runtime uninstall requires --client-target codex|dsh|gemini.");
  }
  let removesSharedRuntime = false;
  const result = await uninstallRouterRuntimeTransaction({
    target,
    snapshot,
    installReplacement: async () => {
      const installed = spawnSync(
        process.execPath,
        [
          path.join(SOURCE_ROOT, "src", "target-integration.mjs"),
          "legacy-installed-targets",
        ],
        { cwd: SOURCE_ROOT, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      if (installed.error) throw installed.error;
      if (installed.status !== 0) throw new Error(`Target integration status exited with ${installed.status}.`);
      const others = String(installed.stdout || "")
        .trim()
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item && item !== clientTarget);
      removesSharedRuntime = others.length === 0;
      if (removesSharedRuntime) runServiceMutation("uninstall");

      const operations = clientTarget === "codex"
        ? [
            ["skills-install.mjs", ["uninstall"]],
            ["shim-cli.mjs", ["uninstall"]],
          ]
        : clientTarget === "dsh"
          ? [["dsh-config-manager.mjs", ["uninstall"]]]
          : [["gemini-config-manager.mjs", ["uninstall"]]];
      for (const [script, args] of operations) {
        const child = spawnSync(
          process.execPath,
          [path.join(SOURCE_ROOT, "src", script), ...args],
          { cwd: SOURCE_ROOT, env: process.env, stdio: "inherit", windowsHide: true },
        );
        if (child.error) throw child.error;
        if (child.status !== 0) throw new Error(`${script} exited with ${child.status}.`);
      }
      const remaining = spawnSync(
        process.execPath,
        [path.join(SOURCE_ROOT, "src", "target-integration.mjs"), "installed-targets"],
        { cwd: SOURCE_ROOT, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      if (remaining.error) throw remaining.error;
      if (remaining.status !== 0) throw new Error(`Target integration status exited with ${remaining.status}.`);
      const unexpectedRemaining = String(remaining.stdout || "")
        .trim()
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item && item !== clientTarget);
      if (removesSharedRuntime && unexpectedRemaining.length > 0) {
        throw new Error("Another client integration appeared during uninstall; refusing runtime cleanup.");
      }
    },
    verifyReplacement: async () => {},
    cleanupOld: async (_resolved, runtimeSnapshot) => {
      if (!removesSharedRuntime) return;
      removeOwnedRuntime(paths, { ids: [...CLEANUP_OWNED_RUNTIME_IDS], snapshot: runtimeSnapshot });
    },
    restoreSnapshot: (value) => restoreOwnedRuntime(value),
    restartOldService: async () => runServiceMutation("restart"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function uninstallLocalModelTransaction(
  tag,
  {
    enabled = isLocalModelEnabled,
    disable = (model) => setLocalModelEnabled(model, false),
    cancelled = () => false,
  } = {},
) {
  // Local models are Vision inventory only. Remove the local selection record,
  // but never rebuild a chat overlay, provider selection, or Router service.
  const wasEnabled = enabled(tag);
  if (cancelled()) return { cancelled: true, removed: false, wasEnabled };
  disable(tag);
  if (cancelled()) return { cancelled: true, removed: false, wasEnabled };
  return { cancelled: false, removed: false, withdrawn: true, wasEnabled };
}

async function main() {
  if (process.argv[2] === "--router-runtime") {
    if (refuseUnsupportedPlatform("uninstall:router-runtime")) return;
    await uninstallRouterRuntimeFromCli();
    return;
  }
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

    const detail = "Vision route withdrawn · weights retained";
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
