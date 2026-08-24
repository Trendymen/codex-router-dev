import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnsupportedPlatform } from "./platform-gate.mjs";
import { CALLER_SECRET_PATH, currentServiceTarget, INSTALL_MANIFEST_PATH, SOURCE_ROOT, TARGET } from "./paths.mjs";
import {
  ownedRuntimePaths,
  removeOwnedRuntime,
  restoreOwnedRuntime,
  snapshotOwnedRuntime,
} from "./owned-runtime-paths.mjs";
import { migrateRuntime } from "./runtime-migration.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import {
  armStartupRebuildDefer,
  cleanupStartupRebuildDefer,
  signalStartupRebuildCompletion,
} from "./startup-rebuild-defer.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import { buildCapabilityManifest } from "./capability-manifest.mjs";
import { desktopCommandDefinitions } from "./desktop-commands.mjs";
import { isPanelRoute, panelLocalCommand } from "./desktop-panel.mjs";

const OLD_RUNTIME_ARTIFACTS = Object.freeze([
  "legacy-router-plist",
  "legacy-prototype-plist",
  "legacy-tray-app",
  "legacy-venv",
  "legacy-litellm-config",
  "legacy-gateway-config",
]);

export const NON_PRODUCTION_RUNTIME_CALLBACKS = Object.freeze([
  "preflight",
  "installReplacement",
  "verifyReplacement",
  "publishReplacement",
  "cleanupOld",
  "restoreSnapshot",
  "restartOldService",
  "refreshTray",
]);

const MIGRATION_RUNTIME_CALLBACKS = Object.freeze(
  NON_PRODUCTION_RUNTIME_CALLBACKS.filter((name) => name !== "refreshTray"),
);

function requireNonProductionRuntimeCallbacks(target, runtime, operation, callbacks = NON_PRODUCTION_RUNTIME_CALLBACKS) {
  if (target.mode === "production") return;
  for (const name of callbacks) {
    if (typeof runtime[name] !== "function") {
      throw new Error(`Non-production ${operation} requires isolated ${name} callback.`);
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Keep the CLI gate ahead of the manifest module's provider/skill imports. A
// non-macOS update must reject before even loading registry-backed state, let
// alone fetching or replacing a checkout. The full manifest writer remains in
// install-manifest.mjs for the install path.
export function installManifestPathForTarget(target = currentServiceTarget()) {
  // The production manifest path remains the exact compatibility constant. An
  // isolated target must derive its marker from its validated state root; it
  // must never inherit the process-wide path selected for a real installation.
  if (target.mode === "production") return INSTALL_MANIFEST_PATH;
  if (!target.stateRoot) throw new Error("Non-production update target requires a stateRoot.");
  return path.join(target.stateRoot, "install-manifest.json");
}

function readInstallManifestSnapshot(target = currentServiceTarget()) {
  const manifestPath = installManifestPathForTarget(target);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function git(args, options = {}) {
  const output = execFileSync("git", ["-C", options.sourceRoot || SOURCE_ROOT, ...args], {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function targetGit(target, gitImpl) {
  const invoke = gitImpl || git;
  return (args, options = {}) => invoke(args, { ...options, sourceRoot: target.sourceRoot });
}

function requireManagedCheckout(target, gitImpl) {
  if (process.env.CODEX_ROUTER_PACKAGE_MANAGER === "homebrew") {
    throw new Error(
      "This installation is managed by Homebrew. Upgrade it with `brew upgrade codex-router`.",
    );
  }
  if (!existsSync(path.join(target.sourceRoot, ".git"))) {
    throw new Error(
      "This release is not a Git checkout. Re-run the installation command to upgrade it.",
    );
  }
  const origin = gitImpl(["remote", "get-url", "origin"]);
  const configured = process.env.CODEX_ROUTER_REPOSITORY_URL;
  const allowed = new Set([
    configured,
    "https://github.com/duolahypercho/codex-router",
    "https://github.com/duolahypercho/codex-router.git",
    "git@github.com:duolahypercho/codex-router.git",
  ].filter(Boolean));
  if (!allowed.has(origin)) {
    throw new Error(`The origin remote is not a recognized Codex Router repository: ${origin}`);
  }
}

// Exported so the Windows bootstrap installer, which reimplements this refusal
// in PowerShell and cannot import it, can be tested against the same number.
export const DIRTY_PREVIEW_LIMIT = 10;

// Only tracked edits are at stake. A fast-forward merge never replaces an
// untracked file, and git refuses the rare collision on its own with a precise
// message, so counting untracked files as "local changes" only ever stranded
// people: one stray file in the checkout and every future update was refused,
// with nothing in the error to say which file or how to get past it.
export function localModifications(gitImpl = git) {
  return gitImpl(["status", "--porcelain", "--untracked-files=no"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function localModificationsMessage(changes, sourceRoot = SOURCE_ROOT) {
  const preview = changes
    .slice(0, DIRTY_PREVIEW_LIMIT)
    .map((line) => `  ${line}`)
    .join("\n");
  const remainder = changes.length - DIRTY_PREVIEW_LIMIT;
  return [
    `The checkout has local changes to ${changes.length} tracked file${
      changes.length === 1 ? "" : "s"
    }; refusing to replace them during update:`,
    preview,
    ...(remainder > 0 ? [`  ...and ${remainder} more`] : []),
    "",
    `Keep them:    git -C ${sourceRoot} stash`,
    "Discard them: re-run the same command with --force",
  ].join("\n");
}

// Called only where the checkout is actually about to be rewritten, so a
// checkout with edits still answers "is an update available?" and still
// reinstalls at the same commit.
function requireReplaceableCheckout(force, target, gitImpl) {
  const changes = localModifications(gitImpl);
  if (changes.length === 0) return;
  if (!force) throw new Error(localModificationsMessage(changes, target.sourceRoot));
  gitImpl(["reset", "--hard", "HEAD"], { inherit: true });
}

// `posixScript` picks which bin/ entry point the POSIX branch runs. Windows
// has only the one installer -- codex-router.ps1 maps both `install` and
// `enable` onto `install.ps1 -CheckoutInstall` -- so the Windows half is
// identical either way, which is exactly why control.mjs reuses this instead
// of hand-rolling a second PowerShell argument list that nothing tested.
export function currentCheckoutInstaller(
  platform = process.platform,
  target = TARGET,
  { posixScript = "install", sourceRoot = SOURCE_ROOT, deferCatalogPublication = false } = {},
) {
  return platform === "win32"
    ? {
        command: "powershell.exe",
        args: [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(sourceRoot, "install.ps1"),
          "-CheckoutInstall",
          "-Target",
          target,
          ...(deferCatalogPublication ? ["-DeferCatalogPublication"] : []),
        ],
      }
    : { command: path.join(sourceRoot, "bin", posixScript), args: deferCatalogPublication ? ["--defer-catalog-publication"] : [] };
}

function installCurrentCheckout(target = currentServiceTarget(), { deferCatalogPublication = false } = {}) {
  const startupMarker = deferCatalogPublication
    ? armStartupRebuildDefer({ stateDir: target.stateRoot })
    : undefined;
  const installer = currentCheckoutInstaller(target.platform, TARGET, { sourceRoot: target.sourceRoot, deferCatalogPublication });
  try {
    const result = spawnSync(installer.command, installer.args, {
      cwd: target.sourceRoot,
      stdio: "inherit",
      env: { ...process.env, MODEL_ROUTER_TARGET: TARGET },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Installer exited with status ${result.status}.`);
    }
  } catch (error) {
    cleanupStartupRebuildDefer(startupMarker);
    throw error;
  }
  return startupMarker;
}

export async function verifyBrowserCapabilityContract(target, { fetchImpl = fetch, callerKey: suppliedCallerKey } = {}) {
  const base = `http://${target.host}:${target.ports.router}`;
  let callerKey = suppliedCallerKey;
  if (callerKey === undefined) {
    try {
      callerKey = readFileSync(CALLER_SECRET_PATH, "utf8").trim();
    } catch (error) {
      throw new Error(`Browser panel contract verification failed: caller key is unavailable (${errorMessage(error)}).`, { cause: error });
    }
  }
  if (!callerKey) throw new Error("Browser panel contract verification failed: caller key is empty.");
  const mint = await fetchImpl(`${base}/_codex-router/${callerKey}/panel-sessions`, {
    method: "POST",
    headers: {
      host: `${target.host}:${target.ports.router}`,
      authorization: `Bearer ${callerKey}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!mint.ok) throw new Error(`Browser panel contract verification failed: session bootstrap HTTP ${mint.status}.`);
  const minted = await mint.json();
  if (typeof minted?.nonce !== "string" || !minted.nonce) throw new Error("Browser panel contract verification failed: nonce is missing.");
  const bootstrap = await fetchImpl(`${base}/panel-bootstrap/${minted.nonce}`, {
    redirect: "manual",
    headers: { host: `${target.host}:${target.ports.router}` },
  });
  const cookie = bootstrap.headers?.get?.("set-cookie")?.split(";", 1)[0];
  if (bootstrap.status !== 303 || !cookie) throw new Error("Browser panel contract verification failed: bootstrap cookie is missing.");
  const response = await fetchImpl(`${base}/panel/`, {
    headers: { host: `${target.host}:${target.ports.router}`, cookie },
  });
  if (!response.ok && response.status !== 304) {
    throw new Error(`Browser panel contract verification failed: HTTP ${response.status}.`);
  }
  const body = await response.text();
  if (!body.includes("__CODEX_ROUTER_MANIFEST__") || !body.includes("__TAURI__")) {
    throw new Error("Browser panel contract verification failed: capability bridge is missing.");
  }
  if (!isPanelRoute("/panel/") || !isPanelRoute("/panel/app.js")) {
    throw new Error("Browser panel contract verification failed: static asset routes are incomplete.");
  }
  const manifest = buildCapabilityManifest();
  const localManifest = panelLocalCommand("platform_info")()?.capabilityManifest;
  if (manifest.capabilitySchemaVersion !== localManifest?.capabilitySchemaVersion) {
    throw new Error("Browser panel contract verification failed: manifest versions disagree.");
  }
  for (const command of manifest.commands || []) {
    if (!desktopCommandDefinitions().has(command.name)) {
      throw new Error(`Browser panel contract verification failed: ${command.name} is not executable.`);
    }
  }
  return { ok: true, commands: manifest.commands?.length || 0 };
}

export function verifySwiftCommandContract(target, {
  exists = existsSync,
  read = readFileSync,
  run = spawnSync,
  expectedManifest = buildCapabilityManifest(),
} = {}) {
  if (target.platform !== "darwin") return { ok: true, skipped: true };
  const source = path.join(target.sourceRoot, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift");
  const packageManifest = path.join(target.sourceRoot, "apps", "macos", "ModelRouterTray", "Package.swift");
  const bridge = path.join(target.sourceRoot, "src", "desktop-command-bridge.mjs");
  if (!exists(target.appBinary) || !exists(source) || !exists(packageManifest) || !exists(bridge)) {
    throw new Error("Swift command contract verification failed: app, package, or bridge is missing.");
  }
  const swift = read(source, "utf8");
  const bridgeSource = read(bridge, "utf8");
  for (const pattern of [/capabilitySchemaVersion/, /executeCanonicalCommand\(/, /DesktopCommandBridge/]) {
    if (!pattern.test(`${swift}\n${bridgeSource}`)) {
      throw new Error(`Swift command contract verification failed: missing ${pattern}.`);
    }
  }
  const probe = run(target.appBinary, ["--codex-router-capability-probe"], {
    cwd: target.sourceRoot,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (probe?.error) throw probe.error;
  if (probe?.status !== 0) throw new Error(`Swift command contract probe exited with ${probe?.status ?? "unknown"}.`);
  let envelope;
  try {
    envelope = JSON.parse(String(probe?.stdout || ""));
  } catch (error) {
    throw new Error("Swift command contract probe returned invalid JSON.", { cause: error });
  }
  const reported = envelope?.value?.capabilityManifest;
  if (envelope?.ok !== true || !reported || reported.capabilitySchemaVersion !== expectedManifest.capabilitySchemaVersion) {
    throw new Error("Swift command contract probe returned an incompatible capability manifest.");
  }
  const expectedCommands = (expectedManifest.commands || []).map(({ name }) => name).sort();
  const reportedCommands = (reported.commands || []).map(({ name }) => name).sort();
  if (JSON.stringify(reportedCommands) !== JSON.stringify(expectedCommands)) {
    throw new Error("Swift command contract probe returned a different command set.");
  }
  return { ok: true };
}

async function verifyInstalledRuntime(target) {
  const health = await waitForRouterHealth({
    target: TARGET,
    url: `http://${target.host}:${target.ports.router}/health`,
  });
  if (!health.ok) throw new Error(`Router health verification failed: ${health.error}`);

  const callerPath = path.join(target.stateRoot, "caller-secret");
  const callerKey = existsSync(callerPath) ? readFileSync(callerPath, "utf8").trim() : undefined;
  await verifyBrowserCapabilityContract(target, { callerKey });
  verifySwiftCommandContract(target);
  return true;
}

function restartOldRuntime(target, { deferStartupRebuild = false } = {}) {
  if (target.platform !== "darwin") return true;
  const startupMarker = deferStartupRebuild
    ? armStartupRebuildDefer({ stateDir: target.stateRoot })
    : undefined;
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(target.sourceRoot, "src", "service.mjs"), "restart"],
      { cwd: target.sourceRoot, env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Old Router service restart exited with ${result.status}.`);
  } catch (error) {
    cleanupStartupRebuildDefer(startupMarker);
    throw error;
  }
  return startupMarker || true;
}

/**
 * Public update/rollback boundary. The runtime snapshot is captured before
 * the replacement installer runs, and cleanup is reachable only after the
 * Router, browser, and Swift contracts have all passed.
 */
export async function runRuntimeMigration(options = {}) {
  const target = options.target || currentServiceTarget();
  const {
    runtimeRoots,
    snapshot,
    preflight,
    cleanupOld,
  } = options;
  requireNonProductionRuntimeCallbacks(target, options, "runtime migration", MIGRATION_RUNTIME_CALLBACKS);
  const catalogLock = options.catalogLock || withCatalogPublicationLock;
  const overlayLock = options.overlayLock || withModelOverlayLock;
  const signalCompletion = options.signalStartupRebuildCompletion || signalStartupRebuildCompletion;
  const cleanupDefer = options.cleanupStartupRebuildDefer || cleanupStartupRebuildDefer;
  let replacementMarker;
  let rollbackMarker;
  let committed = false;
  try {
    const result = await overlayLock(async (modelOverlayLockContext) => catalogLock(async (catalogLockContext) => {
    const paths = ownedRuntimePaths(target, runtimeRoots || (typeof snapshot === "object" ? snapshot?.options : undefined) || {});
    const runtimeSnapshot = typeof snapshot === "function"
      ? await snapshot()
      : snapshot || snapshotOwnedRuntime(paths);
    if (runtimeSnapshot && (runtimeSnapshot.target !== target || JSON.stringify(runtimeSnapshot.options) !== JSON.stringify(paths.options))) {
      throw new Error("Runtime migration snapshot is bound to a different ServiceTarget or runtime roots.");
    }
    const installReplacement = options.installReplacement || (() => installCurrentCheckout(target, { deferCatalogPublication: true }));
    const verifyReplacement = options.verifyReplacement || (() => verifyInstalledRuntime(target));
    const publishReplacement = options.publishReplacement || (() => rebuildNodeSnapshotsAfterUpdate({
      target,
      modelOverlayLockContext,
      catalogLockContext,
    }));
    const restoreSnapshot = options.restoreSnapshot || ((value) => restoreOwnedRuntime(value));
    const restartOldService = options.restartOldService || (() => restartOldRuntime(target, { deferStartupRebuild: true }));
    return migrateRuntime({
      snapshot: runtimeSnapshot,
      preflight,
      installReplacement: async (value) => {
        const marker = await installReplacement(value);
        if (marker?.token) replacementMarker = marker;
      },
      verifyReplacement,
      publishReplacement: (value) => publishReplacement(value, {
        modelOverlayLockContext,
        catalogLockContext,
      }),
      cleanupOld: cleanupOld || ((value) => removeOwnedRuntime(paths, { ids: OLD_RUNTIME_ARTIFACTS, snapshot: value })),
      restoreSnapshot,
      restartOldService: async (value) => {
        const marker = await restartOldService(value);
        if (marker?.token) rollbackMarker = marker;
      },
    });
    }, { stateDir: target.stateRoot }), { stateDir: target.stateRoot });
    committed = true;
    return result;
  } finally {
    // Completion is deliberately outside both locks. A service that has
    // already passed health can now self-heal through its ordinary startup
    // rebuild without ever waiting on its updater parent.
    const completedMarker = committed ? replacementMarker : rollbackMarker;
    // The child also self-heals on exact parent death, so completion signalling
    // is best-effort and must never mask an update success or primary failure.
    try { if (completedMarker) signalCompletion(completedMarker); } catch {}
    try { cleanupDefer(replacementMarker); } catch {}
    try { cleanupDefer(rollbackMarker); } catch {}
  }
}

function registeredTrayBundlePath(label) {
  const resolvedLabel = label || currentServiceTarget().trayLabel;
  try {
    const value = execFileSync(
      "defaults",
      [
        "read",
        resolvedLabel,
        "ModelRouterTray.loginItemBundlePath",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function trayRefreshRequired({
  platform = process.platform,
  home = os.homedir(),
  sourceRoot = SOURCE_ROOT,
  registeredPath,
  target,
} = {}) {
  if (platform !== "darwin") return false;
  const resolvedTarget = target || (
    home === os.homedir() && sourceRoot === SOURCE_ROOT ? currentServiceTarget() : undefined
  );
  const registered = registeredPath ?? registeredTrayBundlePath(resolvedTarget?.trayLabel);
  const candidates = [
    resolvedTarget?.appPath || path.join(home, "Applications", "Model Router.app"),
    path.join(resolvedTarget?.sourceRoot || sourceRoot, "dist", "Model Router.app"),
  ];
  return (
    candidates.some((candidate) => existsSync(candidate)) ||
    Boolean(registered && existsSync(registered))
  );
}

// The tray is rebuilt from the same checkout that owns the router, so an
// update never leaves a stale companion binary behind. Best-effort: the router
// update itself succeeded, and a failed tray refresh must not roll it back.
function refreshTrayCompanion(target) {
  if (!trayRefreshRequired({ target })) return;
  const launcher = path.join(target.sourceRoot, "bin", "model-router-tray");
  const result = spawnSync(launcher, [], { cwd: target.sourceRoot, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Menu-bar companion refresh did not finish: ${result.error.message}\n`);
  } else if (result.status !== 0) {
    process.stderr.write(`Menu-bar companion refresh exited with status ${result.status}.\n`);
  }
}

async function refreshTrayAfterRuntime(target, runtime) {
  if (target.mode === "production") return refreshTrayCompanion(target);
  return runtime.refreshTray(target);
}

function revisionExists(revision, gitImpl = git) {
  try {
    gitImpl(["cat-file", "-e", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function switchRevision(revision, gitImpl = git) {
  // Keep the managed checkout on its existing branch. A failed migration uses
  // this hard reset to restore the old source tree before the one old-service
  // restart owned by migrateRuntime.
  gitImpl(["reset", "--hard", revision], { inherit: true });
}

function restoreRevision(
  revision,
  {
    gitImpl = git,
    reinstall = false,
    deferCatalogPublication = false,
    target = currentServiceTarget(),
  } = {},
) {
  switchRevision(revision, gitImpl);
  if (reinstall) return installCurrentCheckout(target, { deferCatalogPublication });
}

export async function restoreRuntimeAndRevision(
  runtimeSnapshot,
  revision,
  {
    restoreRuntime = restoreOwnedRuntime,
    restoreRevision: restoreRevisionImpl = (value) => switchRevision(value),
  } = {},
) {
  const failures = [];
  try {
    await restoreRuntime(runtimeSnapshot);
  } catch (error) {
    failures.push(error);
  }
  // Always attempt the revision reset, even if restoring the owned runtime
  // failed. Leaving the checkout on the replacement revision makes the next
  // service restart boot a mixed runtime and hides the original failure.
  try {
    await restoreRevisionImpl(revision);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      "Runtime and source revision restoration failed.",
      { cause: failures[0] },
    );
  }
  return true;
}

async function captureRuntimeSnapshot(target, runtime = {}) {
  if (runtime.snapshot !== undefined) {
    return typeof runtime.snapshot === "function" ? await runtime.snapshot() : runtime.snapshot;
  }
  const paths = ownedRuntimePaths(target, runtime.runtimeRoots || {});
  return snapshotOwnedRuntime(paths);
}

export function checkForUpdate({ gitImpl, target = currentServiceTarget() } = {}) {
  const scopedGit = targetGit(target, gitImpl);
  requireManagedCheckout(target, scopedGit);
  scopedGit(["fetch", "--quiet", "origin", "main"]);
  const current = scopedGit(["rev-parse", "HEAD"]);
  const available = scopedGit(["rev-parse", "origin/main"]);
  return { current, available, updateAvailable: current !== available };
}

export function installationNeedsRefresh(manifest, revision) {
  return manifest?.current?.commit !== revision;
}

/** Complete update publication after the installer has rebuilt the base catalog. */
export async function rebuildNodeSnapshotsAfterUpdate({
  run = spawnSync,
  target = currentServiceTarget(),
  modelOverlayLockContext,
  catalogLockContext,
} = {}) {
  if (catalogLockContext) {
    const [{ rebuildAfterRegistryUpdate }, { nodeRegistryModels }] = await Promise.all([
      import("./node-snapshot-triggers.mjs"),
      import("./model-contract.mjs"),
    ]);
    await rebuildAfterRegistryUpdate({
      models: nodeRegistryModels(),
      modelOverlayLockContext,
      catalogLockContext,
    });
    return true;
  }
  const result = run(
    process.execPath,
    [path.join(target.sourceRoot, "src", "node-snapshot-triggers.mjs"), "registry-update"],
    {
      cwd: target.sourceRoot,
      env: process.env,
      encoding: "utf8",
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    throw new Error(String(result?.stderr || "Node snapshot rebuild after update failed.").trim());
  }
  return true;
}

export async function updateCheckout({
  force = false,
  runtime = {},
  gitImpl = git,
  target = currentServiceTarget(),
} = {}) {
  requireNonProductionRuntimeCallbacks(target, runtime, "updateCheckout");
  const scopedGit = targetGit(target, gitImpl);
  const status = checkForUpdate({ gitImpl, target });
  if (!status.updateAvailable) {
    if (!installationNeedsRefresh(readInstallManifestSnapshot(target), status.current)) {
      return { ...status, updated: false, reinstalled: false };
    }
    await runRuntimeMigration({
      ...runtime,
      target,
      snapshot: () => captureRuntimeSnapshot(target, runtime),
      preflight: runtime.preflight,
      installReplacement: runtime.installReplacement || (() => installCurrentCheckout(target, { deferCatalogPublication: true })),
      restartOldService: runtime.restartOldService,
      restoreSnapshot: runtime.restoreSnapshot,
    });
    await refreshTrayAfterRuntime(target, runtime);
    return { ...status, updated: false, reinstalled: true };
  }
  // Capture all owned runtime bytes before any checkout mutation. In
  // particular, a snapshot failure must not leave a merged revision behind.
  let branch;
  const preflight = async (snapshotValue) => {
    await runtime.preflight?.(snapshotValue);
    requireReplaceableCheckout(force, target, scopedGit);
    branch = scopedGit(["branch", "--show-current"]);
    if (!branch) {
      throw new Error("Updates require the managed checkout to be on its main branch.");
    }
  };
  const installReplacement = runtime.installReplacement || (() => {
    // Revision mutation is part of the replacement step, after snapshot and
    // preflight have both succeeded. The old revision remains recoverable until
    // this step is reached.
    scopedGit(["update-ref", "refs/codex-router/rollback", status.current]);
    scopedGit(["merge", "--ff-only", status.available], { inherit: true });
    return installCurrentCheckout(target, { deferCatalogPublication: true });
  });
  await runRuntimeMigration({
    ...runtime,
    target,
    snapshot: () => captureRuntimeSnapshot(target, runtime),
    preflight,
    installReplacement,
    restoreSnapshot: runtime.restoreSnapshot || ((snapshotValue) => restoreRuntimeAndRevision(
      snapshotValue,
      status.current,
      { restoreRevision: (revision) => switchRevision(revision, scopedGit) },
    )),
    restartOldService: runtime.restartOldService,
  });
  await refreshTrayAfterRuntime(target, runtime);
  return { ...status, updated: true, reinstalled: true };
}

export async function rollbackCheckout({ force = false, runtime = {}, gitImpl, target = currentServiceTarget() } = {}) {
  requireNonProductionRuntimeCallbacks(target, runtime, "rollbackCheckout");
  const scopedGit = targetGit(target, gitImpl);
  requireManagedCheckout(target, scopedGit);
  // A rollback checks out a different revision, so it overwrites tracked edits
  // exactly the way an update does.
  const current = scopedGit(["rev-parse", "HEAD"]);
  let rollbackTarget;
  try {
    rollbackTarget = scopedGit(["rev-parse", "refs/codex-router/rollback"]);
  } catch {
    rollbackTarget = readInstallManifestSnapshot(target)?.history?.find((entry) => entry.commit)?.commit;
  }
  if (!rollbackTarget || !revisionExists(rollbackTarget, scopedGit)) {
    throw new Error("No locally cached working revision is available to roll back to.");
  }
  if (rollbackTarget === current) throw new Error("The rollback revision is already installed.");
  const runtimeSnapshot = Object.keys(runtime).length
    ? () => captureRuntimeSnapshot(target, runtime)
    : undefined;
  const preflight = async (snapshotValue) => {
    await runtime.preflight?.(snapshotValue);
    requireReplaceableCheckout(force, target, scopedGit);
  };
  // A bare checkout without an install manifest is not a managed runtime
  // installation yet (for example, a deterministic control-child fixture),
  // so preserve the old checkout-only rollback path. Real managed installs
  // and injected acceptance transactions always take the snapshot gate.
  if (Object.keys(runtime).length || existsSync(installManifestPathForTarget(target))) {
    await runRuntimeMigration({
      ...runtime,
      target,
      ...(runtimeSnapshot ? { snapshot: runtimeSnapshot } : {}),
      preflight,
      installReplacement: runtime.installReplacement || (() => {
        scopedGit(["update-ref", "refs/codex-router/rollback", current]);
        return restoreRevision(rollbackTarget, {
          gitImpl: scopedGit,
          reinstall: true,
          deferCatalogPublication: true,
          target,
        });
      }),
      restoreSnapshot: runtime.restoreSnapshot || ((snapshotValue) => restoreRuntimeAndRevision(
        snapshotValue,
        current,
        { restoreRevision: (revision) => switchRevision(revision, scopedGit) },
      )),
    });
    if (target.mode !== "production") await refreshTrayAfterRuntime(target, runtime);
  } else {
    requireReplaceableCheckout(force, target, scopedGit);
    scopedGit(["update-ref", "refs/codex-router/rollback", current]);
    restoreRevision(rollbackTarget, { gitImpl: scopedGit, reinstall: true, target });
  }
  return { rolledBack: true, from: current, to: rollbackTarget };
}

const COMMANDS = {
  check: checkForUpdate,
  update: updateCheckout,
  rollback: rollbackCheckout,
};

// `check` must stay read-only: the tray and the CLI both use it to answer "is
// an update available?" without touching the installation.
export function resolveCommand(args) {
  return COMMANDS[args.find((argument) => !argument.startsWith("--")) || "update"];
}

// A bare `update --force` has to keep working, so the flag is stripped before
// the subcommand is read rather than being taken for one.
export function parseArguments(args) {
  return { command: resolveCommand(args), force: args.includes("--force") };
}

async function main() {
  const args = process.argv.slice(2);
  const { command, force } = parseArguments(args);
  if (refuseUnsupportedPlatform(`update:${args[0] || "update"}`)) return;
  if (!command) {
    console.error("Usage: update.mjs check|update|rollback [--force]");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(await command({ force }), null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
