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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Keep the CLI gate ahead of the manifest module's provider/skill imports. A
// non-macOS update must reject before even loading registry-backed state, let
// alone fetching or replacing a checkout. The full manifest writer remains in
// install-manifest.mjs for the install path.
function readInstallManifestSnapshot() {
  if (!existsSync(INSTALL_MANIFEST_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(INSTALL_MANIFEST_PATH, "utf8"));
    return parsed?.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function git(args, options = {}) {
  const output = execFileSync("git", ["-C", SOURCE_ROOT, ...args], {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function requireManagedCheckout() {
  if (process.env.CODEX_ROUTER_PACKAGE_MANAGER === "homebrew") {
    throw new Error(
      "This installation is managed by Homebrew. Upgrade it with `brew upgrade codex-router`.",
    );
  }
  if (!existsSync(path.join(SOURCE_ROOT, ".git"))) {
    throw new Error(
      "This release is not a Git checkout. Re-run the installation command to upgrade it.",
    );
  }
  const origin = git(["remote", "get-url", "origin"]);
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
export function localModifications() {
  return git(["status", "--porcelain", "--untracked-files=no"])
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
function requireReplaceableCheckout(force) {
  const changes = localModifications();
  if (changes.length === 0) return;
  if (!force) throw new Error(localModificationsMessage(changes));
  git(["reset", "--hard", "HEAD"], { inherit: true });
}

// `posixScript` picks which bin/ entry point the POSIX branch runs. Windows
// has only the one installer -- codex-router.ps1 maps both `install` and
// `enable` onto `install.ps1 -CheckoutInstall` -- so the Windows half is
// identical either way, which is exactly why control.mjs reuses this instead
// of hand-rolling a second PowerShell argument list that nothing tested.
export function currentCheckoutInstaller(
  platform = process.platform,
  target = TARGET,
  { posixScript = "install" } = {},
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
          path.join(SOURCE_ROOT, "install.ps1"),
          "-CheckoutInstall",
          "-Target",
          target,
        ],
      }
    : { command: path.join(SOURCE_ROOT, "bin", posixScript), args: [] };
}

function installCurrentCheckout() {
  const installer = currentCheckoutInstaller();
  const result = spawnSync(installer.command, installer.args, {
    cwd: SOURCE_ROOT,
    stdio: "inherit",
    env: { ...process.env, MODEL_ROUTER_TARGET: TARGET },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Installer exited with status ${result.status}.`);
  }
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

function restartOldRuntime(target) {
  if (target.platform !== "darwin") return true;
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", "service.mjs"), "restart"],
    { cwd: SOURCE_ROOT, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Old Router service restart exited with ${result.status}.`);
  return true;
}

/**
 * Public update/rollback boundary. The runtime snapshot is captured before
 * the replacement installer runs, and cleanup is reachable only after the
 * Router, browser, and Swift contracts have all passed.
 */
export async function runRuntimeMigration({
  target = currentServiceTarget(),
  runtimeRoots,
  snapshot,
  installReplacement = installCurrentCheckout,
  verifyReplacement = () => verifyInstalledRuntime(target),
  publishReplacement = rebuildNodeSnapshotsAfterUpdate,
  cleanupOld,
  restoreSnapshot = (value) => restoreOwnedRuntime(value),
  restartOldService = () => restartOldRuntime(target),
} = {}) {
  const paths = ownedRuntimePaths(target, runtimeRoots || snapshot?.options || {});
  const runtimeSnapshot = snapshot || snapshotOwnedRuntime(paths);
  if (snapshot && (snapshot.target !== target || JSON.stringify(snapshot.options) !== JSON.stringify(paths.options))) {
    throw new Error("Runtime migration snapshot is bound to a different ServiceTarget or runtime roots.");
  }
  return migrateRuntime({
    snapshot: runtimeSnapshot,
    installReplacement,
    verifyReplacement,
    publishReplacement,
    cleanupOld: cleanupOld || ((runtimeSnapshot) => removeOwnedRuntime(paths, { ids: OLD_RUNTIME_ARTIFACTS, snapshot: runtimeSnapshot })),
    restoreSnapshot,
    restartOldService,
  });
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
    path.join(sourceRoot, "dist", "Model Router.app"),
  ];
  return (
    candidates.some((candidate) => existsSync(candidate)) ||
    Boolean(registered && existsSync(registered))
  );
}

// The tray is rebuilt from the same checkout that owns the router, so an
// update never leaves a stale companion binary behind. Best-effort: the router
// update itself succeeded, and a failed tray refresh must not roll it back.
function refreshTrayCompanion() {
  const target = currentServiceTarget();
  if (!trayRefreshRequired({ target })) return;
  const launcher = path.join(target.sourceRoot, "bin", "model-router-tray");
  const result = spawnSync(launcher, [], { cwd: SOURCE_ROOT, stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`Menu-bar companion refresh did not finish: ${result.error.message}\n`);
  } else if (result.status !== 0) {
    process.stderr.write(`Menu-bar companion refresh exited with status ${result.status}.\n`);
  }
}

function revisionExists(revision) {
  try {
    git(["cat-file", "-e", `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function restoreRevision(revision) {
  git(["switch", "--detach", revision], { inherit: true });
  installCurrentCheckout();
}

export function checkForUpdate() {
  requireManagedCheckout();
  git(["fetch", "--quiet", "origin", "main"]);
  const current = git(["rev-parse", "HEAD"]);
  const available = git(["rev-parse", "origin/main"]);
  return { current, available, updateAvailable: current !== available };
}

export function installationNeedsRefresh(manifest, revision) {
  return manifest?.current?.commit !== revision;
}

/** Complete update publication after the installer has rebuilt the base catalog. */
export function rebuildNodeSnapshotsAfterUpdate({ run = spawnSync } = {}) {
  const result = run(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", "node-snapshot-triggers.mjs"), "registry-update"],
    {
      cwd: SOURCE_ROOT,
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

export async function updateCheckout({ force = false, runtime = {} } = {}) {
  const status = checkForUpdate();
  if (!status.updateAvailable) {
    if (!installationNeedsRefresh(readInstallManifestSnapshot(), status.current)) {
      return { ...status, updated: false, reinstalled: false };
    }
    await runRuntimeMigration({ ...runtime, installReplacement: runtime.installReplacement || installCurrentCheckout });
    refreshTrayCompanion();
    return { ...status, updated: false, reinstalled: true };
  }
  requireReplaceableCheckout(force);
  let branch = git(["branch", "--show-current"]);
  if (!branch) {
    git(["switch", "main"], { inherit: true });
    branch = "main";
  }
  if (branch !== "main") {
    throw new Error("Updates require the managed checkout to be on its main branch.");
  }
  git(["update-ref", "refs/codex-router/rollback", status.current]);
  git(["merge", "--ff-only", status.available], { inherit: true });
  await runRuntimeMigration({
    ...runtime,
    installReplacement: runtime.installReplacement || installCurrentCheckout,
    restoreSnapshot: runtime.restoreSnapshot || (async (runtimeSnapshot) => {
      restoreOwnedRuntime(runtimeSnapshot);
      restoreRevision(status.current);
    }),
  });
  refreshTrayCompanion();
  return { ...status, updated: true, reinstalled: true };
}

export async function rollbackCheckout({ force = false, runtime = {} } = {}) {
  requireManagedCheckout();
  // A rollback checks out a different revision, so it overwrites tracked edits
  // exactly the way an update does.
  requireReplaceableCheckout(force);
  const current = git(["rev-parse", "HEAD"]);
  let target;
  try {
    target = git(["rev-parse", "refs/codex-router/rollback"]);
  } catch {
    target = readInstallManifestSnapshot()?.history?.find((entry) => entry.commit)?.commit;
  }
  if (!target || !revisionExists(target)) {
    throw new Error("No locally cached working revision is available to roll back to.");
  }
  if (target === current) throw new Error("The rollback revision is already installed.");
  git(["update-ref", "refs/codex-router/rollback", current]);
  // A bare checkout without an install manifest is not a managed runtime
  // installation yet (for example, a deterministic control-child fixture),
  // so preserve the old checkout-only rollback path. Real managed installs
  // and injected acceptance transactions always take the snapshot gate.
  if (Object.keys(runtime).length || existsSync(INSTALL_MANIFEST_PATH)) {
    await runRuntimeMigration({
      ...runtime,
      installReplacement: runtime.installReplacement || (() => restoreRevision(target)),
      restoreSnapshot: runtime.restoreSnapshot || (async (runtimeSnapshot) => {
        restoreOwnedRuntime(runtimeSnapshot);
        restoreRevision(current);
      }),
    });
  } else {
    restoreRevision(target);
  }
  return { rolledBack: true, from: current, to: target };
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
