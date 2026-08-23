import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 11 * 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROCESS_TREE_KILL_TIMEOUT_MS = 30_000;
const PROCESS_TREE_KILL_ATTEMPTS = 3;
const SECRET_WORD = /(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|credential)/i;
const APP_CONTRACT_LIMIT = 1024 * 1024;

function validSourceRoot(candidate) {
  if (!candidate || typeof candidate !== "string") return undefined;
  try {
    const root = realpathSync(path.resolve(candidate));
    const sourceDirectory = path.join(root, "src");
    const controlScript = path.join(root, "src", "control.mjs");
    const binaryDirectory = path.join(root, "bin");
    const controlBinary = path.join(root, "bin", "control");
    if (!existsSync(controlScript) || !existsSync(controlBinary)) return undefined;
    const required = [
      { stat: statSync(root), directory: true },
      { stat: statSync(sourceDirectory), directory: true },
      { stat: statSync(binaryDirectory), directory: true },
      { stat: statSync(controlScript), directory: false },
      { stat: statSync(controlBinary), directory: false },
    ];
    if (required.some((item) => item.directory ? !item.stat.isDirectory() : !item.stat.isFile())) {
      return undefined;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined) {
      if ((required.at(-1).stat.mode & 0o111) === 0) return undefined;
      for (const { stat } of required) {
        if (stat.uid !== uid && stat.uid !== 0) return undefined;
        if ((stat.mode & 0o022) !== 0) return undefined;
      }
    }
    return root;
  } catch {
    return undefined;
  }
}

function markedSourceRoot(marker) {
  if (!marker) return undefined;
  try {
    return validSourceRoot(readFileSync(marker, "utf8").trim());
  } catch {
    return undefined;
  }
}

function stateDirectory() {
  return (
    process.env.MODEL_ROUTER_STATE_DIR ||
    process.env.CODEX_ROUTER_STATE_DIR ||
    process.env.KIMI_CODEX_STATE_DIR ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codex-router")
  );
}

/**
 * The control center can be launched from a development checkout while the
 * installed service and its generated state belong to another checkout. The
 * manifest is the router's ownership record; prefer it over the UI's own
 * checkout so writes and catalog rebuilds use the same registry as the live
 * service. Invalid or missing manifests are deliberately ignored and the
 * normal trusted-root fallback remains available.
 */
function recordedInstallManifest() {
  try {
    const manifestPath = path.join(stateDirectory(), "install-manifest.json");
    const directoryStat = statSync(path.dirname(manifestPath));
    const manifestStat = statSync(manifestPath);
    if (!directoryStat.isDirectory() || !manifestStat.isFile() || manifestStat.size > APP_CONTRACT_LIMIT) return undefined;
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      uid !== undefined
      && (
        directoryStat.uid !== uid
        || (directoryStat.mode & 0o077) !== 0
        || manifestStat.uid !== uid
        || (manifestStat.mode & 0o077) !== 0
      )
    ) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const recorded = manifest?.version === 1 ? manifest.current?.sourceRoot : undefined;
    const sourceRoot = validSourceRoot(recorded);
    if (!sourceRoot) return undefined;
    const rawPackageManager = manifest.current?.packageManager;
    const packageManager = rawPackageManager === null
      ? null
      : typeof rawPackageManager === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(rawPackageManager)
        ? rawPackageManager
        : undefined;
    return { sourceRoot, packageManager };
  } catch {
    return undefined;
  }
}

function recordedSourceRoot() {
  return recordedInstallManifest()?.sourceRoot;
}

function companionSourceRoots() {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "router-root"));
  }
  if (process.platform === "darwin") {
    candidates.push(
      path.join(os.homedir(), "Applications", "Model Router.app", "Contents", "Resources", "router-root"),
    );
  }
  return candidates.map(markedSourceRoot).filter(Boolean);
}

/** The stable checkout locations written by the platform installers. */
export function standardSourceRoots({
  platform = process.platform,
  environment = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === "win32") {
    return environment.LOCALAPPDATA
      ? [path.join(environment.LOCALAPPDATA, "codex-router")]
      : [];
  }
  return [
    ...(environment.XDG_DATA_HOME
      ? [path.join(environment.XDG_DATA_HOME, "codex-router")]
      : []),
    path.join(home, ".local", "share", "codex-router"),
  ];
}

/** Resolve the checkout that owns the router. Never accept an arbitrary cwd. */
export function discoverSourceRoot() {
  // An explicit root is an operator/package-manager decision and must retain
  // precedence. It is still validated below, so a bad override cannot make
  // the app execute an arbitrary path.
  for (const explicit of [process.env.CODEX_ROUTER_SOURCE_ROOT, process.env.MODEL_ROUTER_SOURCE_ROOT]) {
    if (!explicit) continue;
    const root = validSourceRoot(explicit);
    if (root) return root;
  }
  const candidates = [
    recordedSourceRoot(),
    ...companionSourceRoots(),
    path.resolve(HERE, "..", "..", ".."),
    ...standardSourceRoots(),
    // Retained for installations made by router versions that predate the
    // stable platform-specific checkout path.
    path.join(os.homedir(), ".codex-router"),
  ];
  for (const candidate of candidates) {
    const root = validSourceRoot(candidate);
    if (root) return root;
  }
  throw new Error("Codex Router source root could not be located.");
}

function appControlContract(packagePath, { trustedCheckout = false } = {}) {
  try {
    const stat = statSync(packagePath);
    if (!stat.isFile() || stat.size > APP_CONTRACT_LIMIT) return undefined;
    if (trustedCheckout) {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      const parents = [path.dirname(packagePath), path.dirname(path.dirname(packagePath))];
      const parentStats = parents.map((directory) => statSync(directory));
      if (parentStats.some((item) => !item.isDirectory())) return undefined;
      if (
        uid !== undefined
        && [stat, ...parentStats].some((item) => (item.uid !== uid && item.uid !== 0) || (item.mode & 0o022) !== 0)
      ) return undefined;
    }
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    if (
      typeof manifest?.version !== "string"
      || !manifest.version.trim()
      || !Number.isInteger(manifest.controlProtocol)
      || manifest.controlProtocol < 1
    ) return undefined;
    return { version: manifest.version, controlProtocol: manifest.controlProtocol };
  } catch {
    return undefined;
  }
}

/** Refuse UI mutations when the app and installed control argv contract differ. */
export function assertMutationCompatibility(sourceRoot = discoverSourceRoot()) {
  const bundled = appControlContract(path.join(HERE, "..", "package.json"));
  const installed = appControlContract(
    path.join(sourceRoot, "apps", "control-center", "package.json"),
    { trustedCheckout: true },
  );
  if (
    bundled
    && installed
    && bundled.version === installed.version
    && bundled.controlProtocol === installed.controlProtocol
  ) return { bundled, installed };
  throw new Error(
    "This Control Center does not match the installed Codex Router control protocol. "
      + "Install or update the router and desktop app from the same build, then reopen the app.",
  );
}

function safeFailure(message) {
  const text = String(message || "Router command failed.")
    .split("\n")
    .filter((line) => !SECRET_WORD.test(line))
    .join("\n")
    .replace(/(?:sk|key|token|secret)[-_A-Za-z0-9]{12,}/gi, "[redacted]");
  return text.slice(0, 1000) || "Router command failed.";
}

function killChildFallback(child) {
  try { child.kill("SIGKILL"); } catch { /* the process already exited */ }
}

/**
 * A control command can spawn installers, service helpers, and other children.
 * Killing only the direct Node process on timeout leaves those descendants
 * mutating the installation after the UI reports failure. Keep the command in
 * its own POSIX process group, and use Windows' supported tree-kill primitive.
 */
async function terminateProcessTree(child) {
  if (!child?.pid) {
    killChildFallback(child);
    return;
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    const systemTaskkill = systemRoot ? path.join(systemRoot, "System32", "taskkill.exe") : undefined;
    const command = systemTaskkill && existsSync(systemTaskkill) ? systemTaskkill : "taskkill.exe";
    const deadline = Date.now() + PROCESS_TREE_KILL_TIMEOUT_MS;
    for (let attempt = 0; attempt < PROCESS_TREE_KILL_ATTEMPTS && Date.now() < deadline; attempt += 1) {
      const remaining = Math.max(250, deadline - Date.now());
      const successful = await new Promise((resolve) => {
        let settled = false;
        let killer;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          try { killer?.kill("SIGKILL"); } catch { /* best effort */ }
          finish(false);
        }, Math.min(10_000, remaining));
        timer.unref();
        try {
          killer = spawn(command, ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", () => finish(false));
          killer.once("close", (code) => finish(code === 0));
        } catch {
          finish(false);
        }
      });
      if (successful) {
        // taskkill can report the tree while Windows is still reaping one of
        // its descendants; a bounded second pass closes that race under a
        // saturated test runner without changing command timeout semantics.
        if (attempt + 1 < PROCESS_TREE_KILL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        return;
      }
    }
    killChildFallback(child);
    return;
  }

  try { process.kill(-child.pid, "SIGTERM"); }
  catch {
    try { child.kill("SIGTERM"); } catch { /* the process already exited */ }
  }
  // Even if the group leader exits promptly, a descendant may ignore TERM.
  // Hold the mutation open through the escalation so app quit cannot cancel it.
  await new Promise((resolve) => setTimeout(resolve, 250));
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { killChildFallback(child); }
}

/**
 * Run one of the fixed router commands. `args` are always an argv array and
 * never pass through a shell. `stdin` is used solely for API credentials.
 */
function runEntrypoint(entry, args = [], { stdin, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES, allowNonZero = false } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Router command arguments must be strings.");
  }
  const sourceRoot = discoverSourceRoot();
  const childEnvironment = {
    ...process.env,
    MODEL_ROUTER_SOURCE_ROOT: sourceRoot,
    MODEL_ROUTER_TARGET: "codex",
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  };
  const recordedInstall = recordedInstallManifest();
  if (recordedInstall?.sourceRoot === sourceRoot && recordedInstall.packageManager !== undefined) {
    if (recordedInstall.packageManager === null) delete childEnvironment.CODEX_ROUTER_PACKAGE_MANAGER;
    else childEnvironment.CODEX_ROUTER_PACKAGE_MANAGER = recordedInstall.packageManager;
  }
  return new Promise((resolve, reject) => {
    // A packaged Electron binary can run trusted Node entrypoints without a
    // separately installed runtime. In CLI/tests process.execPath is already
    // Node; in the desktop host ELECTRON_RUN_AS_NODE switches that same signed
    // executable into its Node mode.
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: sourceRoot,
      detached: process.platform !== "win32",
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let aborting = false;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const abortCommand = async (error) => {
      if (settled || aborting) return;
      aborting = true;
      clearTimeout(timer);
      await terminateProcessTree(child);
      finish(reject, error);
    };
    timer = setTimeout(() => {
      void abortCommand(new Error("Router command timed out."));
    }, Math.max(250, Math.min(timeoutMs, MAX_TIMEOUT_MS)));
    child.stdout.on("data", (chunk) => {
      if (settled || aborting) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        void abortCommand(new Error("Router command output exceeded its limit."));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (settled || aborting) return;
      // Keep stderr in memory only; never write it to a log or console.
      if (stderr.length < 16_384) {
        stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length);
      }
    });
    child.stdin.on("error", () => { /* termination can close the pipe mid-write */ });
    child.on("error", (error) => {
      if (!aborting) finish(reject, new Error(safeFailure(error.message)));
    });
    child.on("close", (code, signal) => {
      if (aborting) return;
      if (code === 0 || allowNonZero) finish(resolve, { stdout, stderr, code, signal });
      else finish(reject, new Error(safeFailure(stderr) || `Router command failed (${code ?? signal}).`));
    });
    if (stdin === undefined) child.stdin.end();
    else {
      if (typeof stdin !== "string" && !Buffer.isBuffer(stdin)) {
        void abortCommand(new TypeError("Credential input must be text."));
      } else {
        child.stdin.end(stdin);
      }
    }
  });
}

export function runControl(args = [], options = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Router command arguments must be strings.");
  }
  const sourceRoot = discoverSourceRoot();
  return runEntrypoint(path.join(sourceRoot, "src", "control.mjs"), args, options);
}

export async function runControlJson(args = [], options = {}) {
  const result = await runControl(args, options);
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Router returned invalid JSON.");
  }
}

export async function runRouterScript(scriptName, args = [], options = {}) {
  if (!/^[a-z0-9-]+\.mjs$/i.test(scriptName)) throw new Error("Invalid router script.");
  const sourceRoot = discoverSourceRoot();
  const script = path.join(sourceRoot, "src", scriptName);
  if (!existsSync(script)) throw new Error("Router script is unavailable.");
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("Router script arguments must be strings.");
  }
  return runEntrypoint(script, args, options);
}
