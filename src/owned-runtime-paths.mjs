import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { isValidatedServiceTarget, validatedIsolationRoot } from "./service-target.mjs";

// Only these IDs can ever be removed. Catalogs, credentials, logs, usage,
// support, and user/Codex documents are snapshot-protected instead.
const CLEANUP_IDS = Object.freeze([
  "router-plist",
  "tray-plist",
  "tray-app",
  "legacy-router-plist",
  "legacy-prototype-plist",
  "legacy-tray-app",
  "legacy-venv",
  "legacy-litellm-config",
  "legacy-gateway-config",
]);

const PROTECTED_IDS = Object.freeze([
  "state-catalog",
  "state-routed-catalog",
  "state-node-routes",
  "state-native-catalog",
  "state-native-catalog-source",
  "state-control-models",
  "state-swift-models",
  "state-browser-models",
  "state-dsh-catalog",
  "state-gemini-catalog",
  "caller-secret",
  "internal-secret",
  "provider-selection",
  "usage-events",
  "router-log",
  "retained-tool-results",
  "support",
  "codex-config",
  "codex-auth",
  "codex-history",
  "codex-backup",
  "codex-skills",
  "dsh-settings",
  "dsh-credentials",
  "gemini-env",
  "credential-deepseek",
  "credential-qwen-plan",
  "credential-anthropic",
  "credential-kimi",
  "credential-kimi-cn",
  "credential-grok",
  "credential-zai",
  "credential-commandcode",
  "credential-github-copilot",
  "credential-gemini",
  "credential-minimax",
  "credential-ollama-cloud",
  "credential-opencode-go",
  "credential-chutes",
  "credential-cerebras",
  "credential-fireworks",
  "credential-groq",
  "credential-huggingface",
  "credential-meta",
  "credential-mistral",
  "credential-nvidia-nim",
  "credential-openrouter",
  "credential-siliconflow",
  "credential-together",
  "credential-xiaomi-mimo",
  "credential-clinepass",
  "credential-zai-api",
  "kimi-oauth-session",
  "grok-oauth-session",
  "devin-credentials",
  "codex-shim",
  "legacy-state-dir",
  "legacy-prototype-state-dir",
  "skill-ownership",
]);

const SNAPSHOT_IDS = Object.freeze([...CLEANUP_IDS, ...PROTECTED_IDS]);
const CLEANUP_SET = new Set(CLEANUP_IDS);
const ALL_IDS = new Set(SNAPSHOT_IDS);
const PRIVATE_IDS = new Set([
  "state-catalog", "state-routed-catalog", "state-node-routes", "state-native-catalog",
  "state-native-catalog-source", "state-control-models", "state-swift-models", "state-browser-models",
  "state-dsh-catalog", "state-gemini-catalog", "caller-secret", "internal-secret", "provider-selection",
  "usage-events", "router-log", "retained-tool-results", "support", "credential-deepseek",
  "credential-qwen-plan", "credential-anthropic", "credential-kimi", "credential-kimi-cn",
  "credential-grok", "credential-zai", "credential-commandcode", "credential-github-copilot",
  "credential-gemini", "credential-minimax", "credential-ollama-cloud", "credential-opencode-go",
  "dsh-credentials", "gemini-env",
  "credential-chutes", "credential-cerebras", "credential-fireworks", "credential-groq",
  "credential-huggingface", "credential-meta", "credential-mistral", "credential-nvidia-nim",
  "credential-openrouter", "credential-siliconflow", "credential-together", "credential-xiaomi-mimo",
  "credential-clinepass", "credential-zai-api", "kimi-oauth-session", "grok-oauth-session",
  "devin-credentials", "codex-config", "codex-auth", "codex-history", "codex-backup",
  "dsh-settings", "codex-shim",
]);
const GLOB_OR_TRAVERSAL = /[*?\[\]{}]|(?:^|[\\/])\.\.(?:[\\/]|$)/;

export const OWNED_RUNTIME_ARTIFACT_IDS = CLEANUP_IDS;
export const CLEANUP_OWNED_RUNTIME_IDS = CLEANUP_IDS;
export const PROTECTED_RUNTIME_IDS = PROTECTED_IDS;
export const SNAPSHOT_RUNTIME_IDS = SNAPSHOT_IDS;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
}

function targetFrom(roots) {
  const target = roots?.target || roots;
  if (!isValidatedServiceTarget(target)) {
    throw new TypeError("Owned runtime paths require a resolver-validated ServiceTarget.");
  }
  for (const name of [
    "sourceRoot",
    "launchAgentsDir",
    "routerPlistPath",
    "trayPlistPath",
    "appPath",
    "stateRoot",
    "supportRoot",
    "logPath",
  ]) requireAbsolute(target[name], `ServiceTarget.${name}`);
  if (target.host !== "127.0.0.1") {
    throw new Error("Owned runtime paths require a loopback ServiceTarget.");
  }
  return target;
}

function definitionsFor(target, {
  shimPath,
  codexHome,
  dshHome,
  geminiHome,
  userHome,
} = {}) {
  const state = target.stateRoot;
  const source = target.sourceRoot;
  if (!codexHome || !dshHome || !geminiHome || !userHome) {
    throw new Error("Owned runtime paths require explicitly resolved Codex, DSH, Gemini, and user roots.");
  }
  const devinAppData = target.mode === "production"
    ? (process.env.APPDATA || path.join(userHome, "AppData", "Roaming"))
    : path.join(userHome, "AppData", "Roaming");
  const devinCredentials = target.platform === "win32"
    ? path.join(devinAppData, "devin", "credentials.toml")
    : path.join(userHome, ".local", "share", "devin", "credentials.toml");
  return {
    "router-plist": target.routerPlistPath,
    "tray-plist": target.trayPlistPath,
    "tray-app": target.appPath,
    "legacy-router-plist": path.join(target.launchAgentsDir, "io.github.kimi-codex-router.plist"),
    "legacy-prototype-plist": path.join(target.launchAgentsDir, "com.ziwenxu.kimi-codex-proxy.plist"),
    "legacy-tray-app": path.join(source, "dist", "Model Router.app"),
    "legacy-venv": path.join(source, ".venv"),
    "legacy-litellm-config": path.join(state, "litellm.yaml"),
    "legacy-gateway-config": path.join(state, "gateway-config.json"),
    "legacy-state-dir": path.join(codexHome, "kimi-router"),
    "legacy-prototype-state-dir": path.join(codexHome, "kimi-proxy"),
    "state-catalog": path.join(state, "merged-models.json"),
    "state-routed-catalog": path.join(state, "routed-models.json"),
    "state-node-routes": path.join(state, "node-routes.json"),
    "state-native-catalog": path.join(state, "native-models.json"),
    "state-native-catalog-source": path.join(state, "native-catalog-source.json"),
    "state-control-models": path.join(state, "control-models.json"),
    "state-swift-models": path.join(state, "swift-models.json"),
    "state-browser-models": path.join(state, "browser-models.json"),
    "state-dsh-catalog": path.join(state, "dsh-models.json"),
    "state-gemini-catalog": path.join(state, "gemini-models.json"),
    "caller-secret": path.join(state, "caller-secret"),
    "internal-secret": path.join(state, "internal-secret"),
    "provider-selection": path.join(state, "enabled-providers.json"),
    "usage-events": path.join(state, "usage-events.jsonl"),
    "router-log": target.logPath,
    "retained-tool-results": path.join(state, "retained-tool-results"),
    support: target.supportRoot,
    "codex-config": path.join(codexHome, "config.toml"),
    "codex-auth": path.join(codexHome, "auth.json"),
    "codex-history": path.join(codexHome, "history.jsonl"),
    "codex-backup": path.join(codexHome, "config.toml.pre-codex-router"),
    "codex-skills": path.join(codexHome, "skills"),
    "dsh-settings": path.join(dshHome, "settings.yaml"),
    "dsh-credentials": path.join(dshHome, ".credentials.yaml"),
    "gemini-env": path.join(geminiHome, ".env"),
    "kimi-oauth-session": path.join(userHome, ".kimi-code", "credentials", "kimi-code.json"),
    "grok-oauth-session": path.join(userHome, ".grok", "auth.json"),
    "devin-credentials": devinCredentials,
    "codex-shim": shimPath || path.join(state, "bin", "codex"),
    "skill-ownership": path.join(state, "managed-skills.json"),
    "credential-deepseek": path.join(state, "deepseek-api-key.secret"),
    "credential-qwen-plan": path.join(state, "qwen-plan-api-key.secret"),
    "credential-anthropic": path.join(state, "anthropic-api-key.secret"),
    "credential-kimi": path.join(state, "kimi-api-key.secret"),
    "credential-kimi-cn": path.join(state, "kimi-api-cn-key.secret"),
    "credential-grok": path.join(state, "xai-api-key.secret"),
    "credential-zai": path.join(state, "zai-coding-api-key.secret"),
    "credential-commandcode": path.join(state, "commandcode-api-key.secret"),
    "credential-github-copilot": path.join(state, "github-copilot-token.secret"),
    "credential-gemini": path.join(state, "gemini-api-key.secret"),
    "credential-minimax": path.join(state, "minimax-token-plan-key.secret"),
    "credential-ollama-cloud": path.join(state, "ollama-cloud-api-key.secret"),
    "credential-opencode-go": path.join(state, "opencode-go-api-key.secret"),
    "credential-chutes": path.join(state, "chutes-api-key.secret"),
    "credential-cerebras": path.join(state, "cerebras-api-key.secret"),
    "credential-fireworks": path.join(state, "fireworks-api-key.secret"),
    "credential-groq": path.join(state, "groq-api-key.secret"),
    "credential-huggingface": path.join(state, "huggingface-api-key.secret"),
    "credential-meta": path.join(state, "meta-api-key.secret"),
    "credential-mistral": path.join(state, "mistral-api-key.secret"),
    "credential-nvidia-nim": path.join(state, "nvidia-nim-api-key.secret"),
    "credential-openrouter": path.join(state, "openrouter-api-key.secret"),
    "credential-siliconflow": path.join(state, "siliconflow-api-key.secret"),
    "credential-together": path.join(state, "together-api-key.secret"),
    "credential-xiaomi-mimo": path.join(state, "xiaomi-mimo-api-key.secret"),
    "credential-clinepass": path.join(state, "clinepass-api-key.secret"),
    "credential-zai-api": path.join(state, "zai-api-key.secret"),
  };
}

function resolveRuntimeRoots(target, options = {}) {
  const defaults = target.mode === "production"
    ? {
        userHome: os.homedir(),
        codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        dshHome: process.env.DSH_HOME || path.join(os.homedir(), ".dsh"),
        geminiHome: path.join(process.env.GEMINI_CLI_HOME || os.homedir(), ".gemini"),
      }
    : {};
  const roots = { ...defaults, ...options };
  for (const name of ["userHome", "codexHome", "dshHome", "geminiHome"]) {
    roots[name] = requireAbsolute(roots[name], `runtime roots.${name}`);
    if (target.mode !== "production") {
      const isolationRoot = validatedIsolationRoot(target);
      if (!isolationRoot || !isInside(isolationRoot, roots[name])) {
        throw new Error(`runtime roots.${name} must remain inside the validated isolationRoot.`);
      }
      rejectLinks(roots[name], [isolationRoot]);
    }
  }
  return roots;
}

function candidateRoots(target, roots = {}) {
  return [
    target.sourceRoot,
    target.launchAgentsDir,
    target.stateRoot,
    target.appPath,
    target.supportRoot,
    path.dirname(target.stateRoot),
    path.dirname(path.dirname(target.stateRoot)),
    roots.userHome,
    roots.codexHome,
    roots.dshHome,
    roots.geminiHome,
  ].map((value) => path.resolve(value));
}

function isInside(root, value) {
  const relative = path.relative(path.resolve(root), path.resolve(value));
  return relative === "" || (
    relative !== "." &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function rejectLinks(value, roots) {
  const resolved = path.resolve(value);
  const boundaries = roots
    .filter((root) => isInside(root, resolved))
    .sort((left, right) => right.length - left.length);
  const boundary = boundaries[0];
  let current = resolved;
  while (true) {
    if (existsSync(current)) {
      let stat;
      try {
        stat = lstatSync(current);
      } catch (error) {
        throw new Error(`Cannot inspect owned runtime path ${current}: ${errorMessage(error)}`, { cause: error });
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Owned runtime path crosses a symlink or junction: ${current}`);
      }
    }
    if (boundary && current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function validateId(id) {
  if (typeof id !== "string" || !id || GLOB_OR_TRAVERSAL.test(id) || !ALL_IDS.has(id)) {
    throw new Error(`Unknown or unsafe owned runtime artifact: ${String(id)}`);
  }
}

function ensureTargetPath(target, id, value, roots = {}) {
  const normalized = requireAbsolute(value, `Owned runtime artifact ${id}`);
  const candidates = candidateRoots(target, roots);
  if (!candidates.some((root) => isInside(root, normalized))) {
    throw new Error(`Owned runtime artifact ${id} is outside the validated ServiceTarget roots.`);
  }
  rejectLinks(normalized, candidates);
  return normalized;
}

export function ownedRuntimePaths(target, options = {}) {
  const validated = targetFrom(target);
  const roots = resolveRuntimeRoots(validated, options);
  const resolvedOptions = { ...roots, ...(options.shimPath ? { shimPath: options.shimPath } : {}) };
  const definitions = definitionsFor(validated, resolvedOptions);
  const artifacts = {};
  for (const id of CLEANUP_IDS) artifacts[id] = ensureTargetPath(validated, id, definitions[id], roots);
  const protectedPaths = {};
  for (const id of PROTECTED_IDS) protectedPaths[id] = ensureTargetPath(validated, id, definitions[id], roots);
  return Object.freeze({
    target: validated,
    options: Object.freeze(resolvedOptions),
    artifacts: Object.freeze(artifacts),
    protected: Object.freeze(protectedPaths),
  });
}

export function resolveOwnedArtifact(id, roots) {
  validateId(id);
  const target = targetFrom(roots);
  const runtimeRoots = resolveRuntimeRoots(target, roots?.options || {});
  const options = { ...runtimeRoots, ...(roots?.options?.shimPath ? { shimPath: roots.options.shimPath } : {}) };
  return ensureTargetPath(target, id, definitionsFor(target, options)[id], runtimeRoots);
}

function entriesFrom(paths) {
  const target = targetFrom(paths);
  const definitions = definitionsFor(target, paths?.options || {});
  const roots = resolveRuntimeRoots(target, paths?.options || {});
  const ids = paths?.ids ? [...paths.ids] : SNAPSHOT_IDS;
  return ids.map((id) => {
    validateId(id);
    return {
      id,
      path: ensureTargetPath(target, id, definitions[id], roots),
      protected: PROTECTED_IDS.includes(id),
      private: PRIVATE_IDS.has(id),
    };
  });
}

function ownershipProof(id, artifactPath, fs) {
  if (!CLEANUP_SET.has(id)) return undefined;
  if (["router-plist", "tray-plist", "tray-app"].includes(id)) {
    return { kind: "resolved-service-target", id };
  }
  if (id === "legacy-router-plist" || id === "legacy-prototype-plist") {
    const text = String(fs.read(artifactPath));
    const marker = id === "legacy-router-plist"
      ? "io.github.kimi-codex-router"
      : "com.ziwenxu.kimi-codex-proxy";
    if (!text.includes(marker)) throw new Error(`Legacy artifact ${id} has no recognized service signature.`);
    return { kind: "legacy-service-signature", marker };
  }
  if (["legacy-litellm-config", "legacy-gateway-config"].includes(id)) {
    const text = String(fs.read(artifactPath)).toLowerCase();
    if (!text.includes("litellm") && !text.includes("gateway") && !text.includes("model_list")) {
      throw new Error(`Legacy artifact ${id} has no recognized gateway signature.`);
    }
    return { kind: "legacy-gateway-signature" };
  }
  if (id === "legacy-venv") {
    const marker = path.join(artifactPath, "pyvenv.cfg");
    if (!fs.exists(marker) || !String(fs.read(marker)).match(/(?:^|\n)\s*(?:home|version)\s*=/i)) {
      throw new Error("Legacy virtual environment has no recognized pyvenv.cfg ownership marker.");
    }
    const allowed = new Set(["bin", "include", "lib", "lib64", "pyvenv.cfg", "scripts", "share"]);
    for (const child of fs.readdir(artifactPath)) {
      if (!allowed.has(child.toLowerCase())) throw new Error(`Legacy virtual environment contains an unknown child: ${child}`);
    }
    return { kind: "legacy-venv-marker", marker: "pyvenv.cfg" };
  }
  if (["legacy-state-dir", "legacy-prototype-state-dir"].includes(id)) {
    const markers = ["merged-models.json", "litellm.yaml", "config.toml"];
    if (!markers.some((name) => fs.exists(path.join(artifactPath, name)))) {
      throw new Error(`Legacy state ${id} has no recognized catalog/config marker.`);
    }
    return { kind: "legacy-state-marker", markers: markers.filter((name) => fs.exists(path.join(artifactPath, name))) };
  }
  if (id === "legacy-tray-app") {
    const info = path.join(artifactPath, "Contents", "Info.plist");
    const binary = path.join(artifactPath, "Contents", "MacOS", "ModelRouterTray");
    if (!fs.exists(info) || !fs.exists(binary)) throw new Error("Legacy tray bundle has no recognized app ownership marker.");
    return { kind: "legacy-tray-bundle", marker: "Contents/Info.plist+MacOS/ModelRouterTray" };
  }
  return { kind: "cleanup-id", id };
}

function snapshotTree(root, fs) {
  const nodes = [];
  const walk = (absolute, relative) => {
    const stat = fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Cannot snapshot a symlink or junction: ${absolute}`);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) {
      nodes.push({ relative, type: "directory", mode });
      for (const child of fs.readdir(absolute).sort((left, right) => left.localeCompare(right))) {
        walk(path.join(absolute, child), relative ? `${relative}/${child}` : child);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported runtime artifact type: ${absolute}`);
    nodes.push({ relative, type: "file", bytes: Buffer.from(fs.read(absolute)), mode });
  };
  walk(root, "");
  return nodes;
}

function captureEntry(entry, fs) {
  if (!fs.exists(entry.path)) return { ...entry, existed: false, type: null, bytes: null, tree: null, mode: null };
  const stat = fs.lstat(entry.path);
  if (stat.isSymbolicLink()) throw new Error(`Cannot snapshot a symlink or junction: ${entry.path}`);
  if (stat.isDirectory()) {
    return {
      ...entry,
      existed: true,
      type: "directory",
      bytes: undefined,
      tree: snapshotTree(entry.path, fs),
      mode: stat.mode & 0o7777,
      ownership: ownershipProof(entry.id, entry.path, fs),
    };
  }
  if (!stat.isFile()) throw new Error(`Unsupported runtime artifact type: ${entry.path}`);
  return {
    ...entry,
    existed: true,
    type: "file",
    bytes: Buffer.from(fs.read(entry.path)),
    tree: null,
    mode: stat.mode & 0o7777,
    ownership: ownershipProof(entry.id, entry.path, fs),
  };
}

function defaultFs() {
  return {
    exists: existsSync,
    lstat: lstatSync,
    read: readFileSync,
    readdir: readdirSync,
    mkdir: mkdirSync,
    write: writeFileSync,
    writeFd: writeSync,
    chmod: chmodSync,
    chmodFd: fchmodSync,
    rename: renameSync,
    unlink: unlinkSync,
    rmdir: rmdirSync,
    open: openSync,
    close: closeSync,
    fsync: fsyncSync,
    protect: protectPrivateFile,
    verifyProtected: privateFileIsProtected,
  };
}

export function snapshotOwnedRuntime(paths, { fs: injected = {} } = {}) {
  const fs = { ...defaultFs(), ...injected };
  const entries = {};
  for (const entry of entriesFrom(paths)) entries[entry.id] = captureEntry(entry, fs);
  return Object.freeze({ version: 2, target: paths.target, options: paths.options, entries: Object.freeze(entries) });
}

function fsyncFile(file, fs, flags = "r+", mode) {
  const descriptor = fs.open(file, flags);
  try {
    if (mode !== undefined) fs.chmodFd(descriptor, mode);
    fs.fsync(descriptor);
  } finally {
    fs.close(descriptor);
  }
}

function writeStagedFile(file, bytes, mode, protectedEntry, fs) {
  const descriptor = fs.open(file, "wx", writableStageMode(mode));
  try {
    const payload = Buffer.from(bytes);
    let offset = 0;
    while (offset < payload.length) {
      const remaining = payload.length - offset;
      const written = fs.writeFd(descriptor, payload, offset, remaining, offset);
      if (!Number.isInteger(written) || written <= 0 || written > remaining) {
        throw new Error(`Staged file write returned an invalid byte count: ${written}`);
      }
      offset += written;
    }
    fs.chmodFd(descriptor, mode);
    fs.fsync(descriptor);
  } finally {
    fs.close(descriptor);
  }
  if (protectedEntry && process.platform === "win32") {
    // The exact POSIX mode may make a Windows handle read-only (the injected
    // ACL helper used by tests is intentionally a no-op). Make the path
    // writable only long enough to apply the path-based ACL, then reopen the
    // same inode, apply the final mode on that handle, and flush it.
    fs.chmod(file, writableStageMode(mode));
    protectWindowsOnly(file, true, fs);
    fsyncFile(file, fs, "r+", mode);
  }
}

function fsyncParent(file, fs) {
  // Windows does not expose a consistently fsync-able directory handle. File
  // contents and ACLs are still flushed there; POSIX gets the parent-dentry
  // durability guarantee after every rename/unlink/rmdir.
  if (process.platform === "win32") return;
  const descriptor = fs.open(path.dirname(file), "r");
  try {
    fs.fsync(descriptor);
  } finally {
    fs.close(descriptor);
  }
}

function fsyncDirectory(directory, fs) {
  if (process.platform === "win32") return;
  const descriptor = fs.open(directory, "r");
  try {
    fs.fsync(descriptor);
  } finally {
    fs.close(descriptor);
  }
}

function removeExact(target, fs) {
  if (!fs.exists(target)) return;
  const stat = fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to remove a symlink or junction: ${target}`);
  if (!stat.isDirectory()) {
    fs.unlink(target);
    fsyncParent(target, fs);
    return;
  }
  for (const child of fs.readdir(target)) removeExact(path.join(target, child), fs);
  fs.rmdir(target);
  fsyncParent(target, fs);
}

function siblingPath(target, tag) {
  return `${target}.${tag}.${process.pid}.${randomUUID()}`;
}

function aggregateRestoreFailures(primary, failures, message) {
  if (failures.length === 0) return primary;
  return new AggregateError([primary, ...failures], message, { cause: primary });
}

function verifyProtectedPath(target, fs) {
  if (process.platform !== "win32") return true;
  if (!fs.verifyProtected(target)) throw new Error(`Restored protected runtime file is not private: ${target}`);
  return true;
}

function writableStageMode(mode) {
  return mode | 0o600;
}

function protectWindowsOnly(target, protectedEntry, fs) {
  if (protectedEntry && process.platform === "win32") fs.protect(target);
}

function replaceFileAtomic(target, bytes, mode, protectedEntry, fs) {
  fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = siblingPath(target, "runtime-restore");
  const backup = siblingPath(target, "runtime-backup");
  let backedUp = false;
  let installed = false;
  let committed = false;
  let oldRestored = false;
  try {
    writeStagedFile(staging, bytes, mode, protectedEntry, fs);
    if (fs.exists(target)) {
      fs.rename(target, backup);
      backedUp = true;
      fsyncParent(target, fs);
    }
    fs.rename(staging, target);
    installed = true;
    fsyncParent(target, fs);
    if (protectedEntry) {
      verifyProtectedPath(target, fs);
    }
    committed = true;
    if (backedUp) {
      removeExact(backup, fs);
      fsyncParent(backup, fs);
    }
  } catch (error) {
    const rollbackFailures = [];
    if (committed) {
      try {
        if (fs.exists(staging)) removeExact(staging, fs);
      } catch (cleanupError) {
        rollbackFailures.push(cleanupError);
      }
      // The restored bytes are already committed. If backup cleanup or its
      // parent fsync failed, retain any remaining backup evidence and never
      // destroy the committed target while reporting that cleanup failure.
      throw aggregateRestoreFailures(error, rollbackFailures, "Atomic file restore committed but cleanup was incomplete.");
    }
    try {
      if (installed && fs.exists(target)) {
        removeExact(target, fs);
        installed = false;
      }
      if (backedUp && fs.exists(backup)) {
        fs.rename(backup, target);
        fsyncParent(target, fs);
        oldRestored = true;
      } else {
        oldRestored = !backedUp;
      }
    } catch (rollbackError) {
      rollbackFailures.push(rollbackError);
    }
    try {
      if (fs.exists(staging)) removeExact(staging, fs);
    } catch (cleanupError) {
      rollbackFailures.push(cleanupError);
    }
    if (oldRestored) {
      try {
        if (fs.exists(backup)) removeExact(backup, fs);
      } catch (cleanupError) {
        rollbackFailures.push(cleanupError);
      }
    }
    throw aggregateRestoreFailures(error, rollbackFailures, "Atomic file restore failed; rollback evidence was retained where necessary.");
  }
}

function stageTree(target, tree, protectedEntry, fs) {
  const staging = siblingPath(target, "runtime-restore");
  fs.mkdir(staging, { recursive: true, mode: tree.find((entry) => entry.relative === "")?.mode ?? 0o700 });
  try {
    for (const entry of tree) {
      const absolute = entry.relative ? path.join(staging, ...entry.relative.split("/")) : staging;
      if (entry.type === "directory") {
        fs.mkdir(absolute, { recursive: true, mode: entry.mode });
        fs.chmod(absolute, entry.mode);
      } else {
        fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
        writeStagedFile(absolute, entry.bytes, entry.mode, protectedEntry, fs);
      }
    }
    const directories = tree
      .filter((entry) => entry.type === "directory")
      .map((entry) => ({ entry, absolute: entry.relative ? path.join(staging, ...entry.relative.split("/")) : staging }))
      .sort((left, right) => right.entry.relative.split("/").length - left.entry.relative.split("/").length);
    for (const { absolute } of directories) fsyncDirectory(absolute, fs);
    return staging;
  } catch (error) {
    const cleanupFailures = [];
    try {
      if (fs.exists(staging)) removeExact(staging, fs);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    throw aggregateRestoreFailures(error, cleanupFailures, "Runtime tree staging failed; cleanup was incomplete.");
  }
}

function replaceDirectoryAtomic(target, tree, mode, protectedEntry, fs) {
  fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = stageTree(target, tree, protectedEntry, fs);
  const backup = siblingPath(target, "runtime-backup");
  let backedUp = false;
  let installed = false;
  let committed = false;
  let oldRestored = false;
  try {
    if (fs.exists(target)) {
      fs.rename(target, backup);
      backedUp = true;
      fsyncParent(target, fs);
    }
    fs.rename(staging, target);
    installed = true;
    fsyncParent(target, fs);
    if (protectedEntry) {
      for (const entry of tree) {
        if (entry.type !== "file") continue;
        const absolute = entry.relative ? path.join(target, ...entry.relative.split("/")) : target;
        verifyProtectedPath(absolute, fs);
      }
    }
    committed = true;
    if (backedUp) {
      removeExact(backup, fs);
      fsyncParent(backup, fs);
    }
  } catch (error) {
    const rollbackFailures = [];
    if (committed) {
      try {
        if (fs.exists(staging)) removeExact(staging, fs);
      } catch (cleanupError) {
        rollbackFailures.push(cleanupError);
      }
      throw aggregateRestoreFailures(error, rollbackFailures, "Atomic directory restore committed but cleanup was incomplete.");
    }
    try {
      if (installed && fs.exists(target)) {
        removeExact(target, fs);
        installed = false;
      }
      if (backedUp && fs.exists(backup)) {
        fs.rename(backup, target);
        fsyncParent(target, fs);
        oldRestored = true;
      } else {
        oldRestored = !backedUp;
      }
    } catch (rollbackError) {
      rollbackFailures.push(rollbackError);
    }
    try {
      if (fs.exists(staging)) removeExact(staging, fs);
    } catch (cleanupError) {
      rollbackFailures.push(cleanupError);
    }
    if (oldRestored) {
      try {
        if (fs.exists(backup)) removeExact(backup, fs);
      } catch (cleanupError) {
        rollbackFailures.push(cleanupError);
      }
    }
    throw aggregateRestoreFailures(error, rollbackFailures, "Atomic directory restore failed; rollback evidence was retained where necessary.");
  }
}

function validateSnapshotEntry(entry, snapshot) {
  if (!entry?.id || !snapshot?.target) throw new Error("Owned runtime snapshot is not resolver-bound.");
  const expected = resolveOwnedArtifact(entry.id, snapshot);
  if (expected !== path.normalize(entry.path)) throw new Error(`Owned runtime snapshot contains an unallowlisted path: ${entry.path}`);
}

export function restoreOwnedRuntime(snapshot, { fs: injected = {} } = {}) {
  if (!snapshot || snapshot.version !== 2 || !snapshot.entries || !snapshot.target) {
    throw new Error("Invalid resolver-bound owned runtime snapshot.");
  }
  const fs = { ...defaultFs(), ...injected };
  for (const entry of Object.values(snapshot.entries)) {
    validateSnapshotEntry(entry, snapshot);
    if (!entry.existed) {
      if (fs.exists(entry.path)) removeExact(entry.path, fs);
      continue;
    }
    if (entry.type === "directory") replaceDirectoryAtomic(entry.path, entry.tree, entry.mode, entry.private, fs);
    else if (entry.type === "file") replaceFileAtomic(entry.path, Buffer.from(entry.bytes), entry.mode, entry.private, fs);
    else throw new Error(`Invalid owned runtime snapshot entry type: ${entry.id}`);
  }
  return snapshot;
}

function comparableTree(tree) {
  return tree.map(({ relative, type, bytes, mode }) => ({
    relative,
    type,
    bytes: bytes ? Buffer.from(bytes).toString("base64") : null,
    mode,
  }));
}

function equivalentEntry(current, expected, fs) {
  if (!expected.existed) return !current.exists;
  // A prior exact owner operation (for example service uninstall removing its
  // plist/app) may already have removed the path. Absence is safe; any present
  // path must still match the captured ownership tree before cleanup starts.
  if (!current.exists) return true;
  if (!current.exists || current.type !== expected.type) return false;
  if (expected.type === "file") {
    return Buffer.compare(Buffer.from(fs.read(expected.path)), Buffer.from(expected.bytes)) === 0 &&
      (fs.lstat(expected.path).mode & 0o7777) === expected.mode;
  }
  return JSON.stringify(comparableTree(snapshotTree(expected.path, fs))) === JSON.stringify(comparableTree(expected.tree));
}

function currentEntry(pathname, fs) {
  if (!fs.exists(pathname)) return { path: pathname, exists: false };
  const stat = fs.lstat(pathname);
  if (stat.isSymbolicLink()) throw new Error(`Cleanup encountered a symlink or junction: ${pathname}`);
  return { path: pathname, exists: true, type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other" };
}

export function removeOwnedRuntime(paths, { ids = CLEANUP_IDS, snapshot, remove } = {}) {
  const target = targetFrom(paths);
  if (!snapshot || snapshot.version !== 2 || snapshot.target !== target || snapshot.options?.shimPath !== paths.options?.shimPath) {
    throw new Error("Runtime cleanup requires the matching resolver-bound snapshot.");
  }
  const fs = defaultFs();
  const plan = [];
  for (const id of ids) {
    validateId(id);
    if (!CLEANUP_SET.has(id)) throw new Error(`Runtime cleanup ID is protected or not cleanup-owned: ${id}`);
    const resolved = resolveOwnedArtifact(id, paths);
    const expected = snapshot.entries[id];
    if (!expected) throw new Error(`Runtime cleanup has no snapshot ownership evidence for ${id}.`);
    if (expected.existed && currentEntry(resolved, fs).exists && expected.ownership) {
      const currentOwnership = ownershipProof(id, resolved, fs);
      if (JSON.stringify(currentOwnership) !== JSON.stringify(expected.ownership)) {
        throw new Error(`Runtime cleanup ownership signature changed or is foreign: ${id}`);
      }
    }
    if (!equivalentEntry(currentEntry(resolved, fs), { ...expected, path: resolved }, fs)) {
      throw new Error(`Runtime cleanup ownership changed or contains foreign content: ${id}`);
    }
    plan.push(resolved);
  }
  for (const resolved of plan) (remove || ((targetPath) => removeExact(targetPath, fs)))(resolved);
  return plan;
}
