import { createHash, randomUUID } from "node:crypto";
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
  readlinkSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { CATALOG_GENERATION_FILES } from "./catalog-generation.mjs";
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
const MANAGED_CATALOG_ID_BY_FILE = Object.freeze({
  "merged-models.json": "state-catalog",
  "routed-models.json": "state-routed-catalog",
  "node-routes.json": "state-node-routes",
  "control-models.json": "state-control-models",
  "swift-models.json": "state-swift-models",
  "browser-models.json": "state-browser-models",
});
const MANAGED_CATALOG_IDS = new Set(Object.values(MANAGED_CATALOG_ID_BY_FILE));

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

function lstatIfPresent(value, fs = { lstat: lstatSync }) {
  try {
    return fs.lstat(value);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function directoryIdentity(value, fs, label) {
  const stat = fs.lstat(value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw catalogTopologyError(`${label} is not a regular directory`);
  }
  return Object.freeze({ dev: BigInt(stat.dev), ino: BigInt(stat.ino) });
}

function assertDirectoryIdentity(value, expected, fs, label) {
  if (!expected || typeof expected.dev !== "bigint" || typeof expected.ino !== "bigint") {
    throw catalogTopologyError(`${label} has no captured directory identity`);
  }
  const actual = directoryIdentity(value, fs, label);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw catalogTopologyError(`${label} changed identity during catalog restore`);
  }
  return actual;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsPlatform(fs) {
  return fs.platform || process.platform;
}

function rejectLinks(value, roots, { allowFinalManagedCatalogLink = false } = {}) {
  const resolved = path.resolve(value);
  const boundaries = roots
    .filter((root) => isInside(root, resolved))
    .sort((left, right) => right.length - left.length);
  const boundary = boundaries[0];
  let current = resolved;
  while (true) {
    let stat;
    try {
      stat = lstatIfPresent(current);
    } catch (error) {
      throw new Error(`Cannot inspect owned runtime path ${current}: ${errorMessage(error)}`, { cause: error });
    }
    if (stat) {
      if (stat.isSymbolicLink()) {
        if (!(allowFinalManagedCatalogLink && current === resolved)) {
          throw new Error(`Owned runtime path crosses a symlink or junction: ${current}`);
        }
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
  rejectLinks(normalized, candidates, { allowFinalManagedCatalogLink: MANAGED_CATALOG_IDS.has(id) });
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

function catalogStateRoot(entries) {
  const stable = entries.find((entry) => MANAGED_CATALOG_IDS.has(entry.id));
  if (!stable) return undefined;
  return path.dirname(stable.path);
}

function catalogStablePaths(stateRoot) {
  return Object.fromEntries(CATALOG_GENERATION_FILES.map((name) => [name, path.join(stateRoot, name)]));
}

function catalogTopologyError(message) {
  return new Error(`Unsafe managed catalog topology: ${message}`);
}

function exactRelativeCatalogTarget(name) {
  return `catalog-generations/current/${name}`;
}

function normalizedStableCatalogTarget(target, name) {
  if (
    typeof target !== "string"
    || !target
    || path.isAbsolute(target)
    || path.win32.isAbsolute(target)
    || target.includes("\0")
  ) throw catalogTopologyError(`stable catalog link has an unsafe target: ${name}`);
  const segments = target.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw catalogTopologyError(`stable catalog link has an unsafe traversal target: ${name}`);
  }
  const normalized = segments.join("/");
  if (normalized !== exactRelativeCatalogTarget(name)) {
    throw catalogTopologyError(`stable catalog link has an unexpected target: ${name}`);
  }
  return normalized;
}

function privateCatalogFile(stat, target, fs) {
  if (!stat.isFile() || stat.nlink !== 1) {
    throw catalogTopologyError(`generation artifact is not a private regular single-link file: ${target}`);
  }
  if (fsPlatform(fs) === "win32") {
    if (!fs.verifyProtected(target)) throw catalogTopologyError(`generation artifact is not ACL-protected: ${target}`);
  } else if ((stat.mode & 0o777) !== 0o600) {
    throw catalogTopologyError(`generation artifact mode is not 0600: ${target}`);
  }
}

function directGenerationName(target) {
  if (
    typeof target !== "string"
    || !target
    || path.isAbsolute(target)
    || target.includes("\\")
    || target.includes("/")
    || target === "."
    || target === ".."
    || target.includes("..")
  ) throw catalogTopologyError("current does not reference a direct in-tree generation");
  return target;
}

function inspectManagedCatalogTopology(entries, fs) {
  const stateRoot = catalogStateRoot(entries);
  if (!stateRoot) return undefined;
  const stablePaths = catalogStablePaths(stateRoot);
  const stableStats = Object.fromEntries(CATALOG_GENERATION_FILES.map((name) => [name, lstatIfPresent(stablePaths[name], fs)]));
  const linked = CATALOG_GENERATION_FILES.filter((name) => stableStats[name]?.isSymbolicLink());
  const generationsDir = path.join(stateRoot, "catalog-generations");
  const current = path.join(generationsDir, "current");
  const generationsStat = lstatIfPresent(generationsDir, fs);
  const topologyAuthorityPresent = generationsStat !== undefined || lstatIfPresent(current, fs) !== undefined;
  if (linked.length === 0 && !topologyAuthorityPresent) return undefined;
  if (generationsStat?.isSymbolicLink()) throw catalogTopologyError("catalog generations root is a symbolic link or junction");
  if (linked.length !== CATALOG_GENERATION_FILES.length) {
    throw catalogTopologyError("catalog stable paths are mixed with regular, missing, or junction artifacts");
  }
  const stateIdentity = directoryIdentity(stateRoot, fs, "catalog state root");
  const generationsIdentity = directoryIdentity(generationsDir, fs, "catalog generations root");
  const currentStat = lstatIfPresent(current, fs);
  if (!currentStat?.isSymbolicLink()) throw catalogTopologyError("catalog current authority is missing or not a symbolic link");
  const generation = directGenerationName(fs.readlink(current));
  const generationDir = path.join(generationsDir, generation);
  const generationStat = lstatIfPresent(generationDir, fs);
  if (!generationStat?.isDirectory() || generationStat.isSymbolicLink()) {
    throw catalogTopologyError("current references a missing, linked, or non-directory generation");
  }
  const generationIdentity = directoryIdentity(generationDir, fs, "catalog generation");
  const files = {};
  const generationNames = fs.readdir(generationDir).sort((left, right) => left.localeCompare(right));
  const expectedNames = [...CATALOG_GENERATION_FILES].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(generationNames) !== JSON.stringify(expectedNames)) {
    throw catalogTopologyError("generation does not contain exactly the six managed artifacts");
  }
  for (const name of CATALOG_GENERATION_FILES) {
    normalizedStableCatalogTarget(fs.readlink(stablePaths[name]), name);
    const artifact = path.join(generationDir, name);
    const artifactStat = lstatIfPresent(artifact, fs);
    if (!artifactStat) throw catalogTopologyError(`generation is incomplete: ${name}`);
    if (artifactStat.isSymbolicLink()) throw catalogTopologyError(`generation artifact is a symbolic link or junction: ${name}`);
    privateCatalogFile(artifactStat, artifact, fs);
    const bytes = Buffer.from(fs.read(artifact));
    files[name] = Object.freeze({
      bytes,
      mode: artifactStat.mode & 0o777,
      digest: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return Object.freeze({
    version: 1,
    stateRoot,
    generationsDir,
    generation,
    identities: Object.freeze({ stateIdentity, generationsIdentity, generationIdentity }),
    files: Object.freeze(files),
  });
}

function captureEntry(entry, fs) {
  const stat = lstatIfPresent(entry.path, fs);
  if (!stat) return { ...entry, existed: false, type: null, bytes: null, tree: null, mode: null };
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
    platform: process.platform,
    exists: existsSync,
    lstat: lstatSync,
    read: readFileSync,
    readlink: readlinkSync,
    readdir: readdirSync,
    mkdir: mkdirSync,
    write: writeFileSync,
    writeFd: writeSync,
    chmod: chmodSync,
    chmodFd: fchmodSync,
    rename: renameSync,
    unlink: unlinkSync,
    symlink: symlinkSync,
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
  const runtimeEntries = entriesFrom(paths);
  const catalogTopology = inspectManagedCatalogTopology(runtimeEntries, fs);
  const entries = {};
  for (const entry of runtimeEntries) {
    if (catalogTopology && MANAGED_CATALOG_IDS.has(entry.id)) {
      entries[entry.id] = Object.freeze({
        ...entry,
        existed: true,
        type: "catalog-topology-link",
        bytes: null,
        tree: null,
        mode: null,
      });
    } else {
      entries[entry.id] = captureEntry(entry, fs);
    }
  }
  return Object.freeze({
    version: 2,
    target: paths.target,
    options: paths.options,
    entries: Object.freeze(entries),
    ...(catalogTopology ? { catalogTopology } : {}),
  });
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
  if (protectedEntry && fsPlatform(fs) === "win32") {
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
  if (fsPlatform(fs) === "win32") return;
  const descriptor = fs.open(path.dirname(file), "r");
  try {
    fs.fsync(descriptor);
  } finally {
    fs.close(descriptor);
  }
}

function fsyncDirectory(directory, fs) {
  if (fsPlatform(fs) === "win32") return;
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

const WINDOWS_POINTER_RETRY_CODES = new Set(["EPERM", "EBUSY"]);
function renameCatalogPointerWithRetry(source, target, fs) {
  let firstError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return fs.rename(source, target);
    } catch (error) {
      if (fsPlatform(fs) !== "win32" || !WINDOWS_POINTER_RETRY_CODES.has(error?.code)) throw error;
      firstError ||= error;
      if (attempt === 1) throw firstError;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function pointerIdentity(entry) {
  return Object.freeze({ dev: BigInt(entry.dev), ino: BigInt(entry.ino) });
}

function samePointerIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function pointerLstatIfPresent(value, fs) {
  try {
    return fs.lstat(value, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function pointerBinding(pointer, fs, label) {
  const entry = pointerLstatIfPresent(pointer, fs);
  if (!entry?.isSymbolicLink()) throw new Error(`${label} is missing or is not a symbolic-link pointer: ${pointer}`);
  return Object.freeze({ identity: pointerIdentity(entry), target: fs.readlink(pointer) });
}

function samePointerBinding(left, right) {
  return samePointerIdentity(left?.identity, right?.identity) && left?.target === right?.target;
}

function assertPointerBinding(pointer, expected, fs, label) {
  const actual = pointerBinding(pointer, fs, label);
  if (!samePointerBinding(actual, expected)) throw new Error(`${label} changed identity or target during catalog pointer replacement.`);
  return actual;
}

function pointerTargets(pointer, generation, fs) {
  const entry = pointerLstatIfPresent(pointer, fs);
  return Boolean(entry?.isSymbolicLink() && fs.readlink(pointer) === generation);
}

function removeVerifiedPointer(pointer, expected, fs, label) {
  assertPointerBinding(pointer, expected, fs, label);
  // Tombstones are intentionally not unlinked on Windows.  Bound their count
  // per pointer so recovery evidence cannot grow without limit; an operator
  // must run a future handle-aware audited maintenance path before more swaps.
  const managedTombstone = /^current\.catalog-current-(?:displaced|restore|rollback)\.\d+\.[0-9a-f-]+(?:\.catalog-pointer-remove\.\d+\.[0-9a-f-]+)+$/i;
  if (fs.readdir(path.dirname(pointer)).filter((name) => managedTombstone.test(name)).length >= 64) {
    throw new Error(`Catalog pointer tombstone limit reached for ${pointer}; audited maintenance is required before another replacement.`);
  }
  const tombstone = siblingPath(pointer, "catalog-pointer-remove");
  renameCatalogPointerWithRetry(pointer, tombstone, fs);
  try {
    assertPointerBinding(tombstone, expected, fs, `${label} tombstone`);
  } catch (error) {
    Object.defineProperty(error, "catalogPointerResidue", { value: tombstone });
    throw error;
  }
  // Node cannot unlink an already-open Windows handle by identity.  A final
  // path unlink would reintroduce a replace-between-check-and-delete race, so
  // retain the verified private tombstone as explicit recovery evidence.  A
  // later audited maintenance pass may consume it only after a fresh binding.
  return tombstone;
}

function pointerTransactionError(primary, state, failures = []) {
  const error = failures.length
    ? new AggregateError([primary, ...failures], "Windows catalog pointer replacement failed and could not be rolled back.", { cause: primary })
    : new Error("Windows catalog pointer replacement failed.", { cause: primary });
  Object.defineProperty(error, "catalogPointerTransaction", { value: Object.freeze(state) });
  return error;
}

function recordPointerFailure(error, residues, seen = new Set()) {
  if (!error || (typeof error !== "object" && typeof error !== "function") || seen.has(error)) return;
  seen.add(error);
  if (typeof error.catalogPointerResidue === "string") residues.add(error.catalogPointerResidue);
  const transaction = error.catalogPointerTransaction;
  if (transaction) {
    for (const residue of transaction.residues || []) if (typeof residue === "string") residues.add(residue);
    if (typeof transaction.displaced === "string") residues.add(transaction.displaced);
  }
  for (const nested of error.errors || []) recordPointerFailure(nested, residues, seen);
  recordPointerFailure(error.cause, residues, seen);
}

function renameCatalogPointer(source, target, fs) {
  if (fsPlatform(fs) !== "win32") {
    renameCatalogPointerWithRetry(source, target, fs);
    return { installed: true, rollbackComplete: false, displaced: null };
  }
  // Windows cannot rename a new link over an existing link/junction.  Move the
  // old pointer aside first, then install the new one into the vacant name.
  // Every move is bounded for transient sharing violations; any post-move
  // failure restores the old pointer before the error escapes.
  const existing = pointerLstatIfPresent(target, fs);
  if (!existing) {
    renameCatalogPointerWithRetry(source, target, fs);
    return { installed: true, rollbackComplete: false, displaced: null };
  }
  if (!existing.isSymbolicLink()) throw new Error(`Refusing to replace a non-link catalog pointer: ${target}`);
  const expected = Object.freeze({ identity: pointerIdentity(existing), target: fs.readlink(target) });
  const sourceBinding = pointerBinding(source, fs, "new catalog pointer");
  const displaced = siblingPath(target, "catalog-current-displaced");
  let displacedOld = false;
  let installed = false;
  try {
    assertPointerBinding(target, expected, fs, "existing catalog pointer");
    renameCatalogPointerWithRetry(target, displaced, fs);
    displacedOld = true;
    assertPointerBinding(displaced, expected, fs, "displaced catalog pointer");
    if (pointerLstatIfPresent(target, fs)) throw new Error("Windows catalog pointer name reappeared before replacement.");
    assertPointerBinding(source, sourceBinding, fs, "new catalog pointer");
    renameCatalogPointerWithRetry(source, target, fs);
    installed = true;
    assertPointerBinding(target, sourceBinding, fs, "installed catalog pointer");
    const residue = removeVerifiedPointer(displaced, expected, fs, "displaced catalog pointer");
    return { installed: true, rollbackComplete: false, displaced: null, residues: [residue] };
  } catch (error) {
    const rollbackFailures = [];
    let rollbackComplete = false;
    if (installed) {
      try {
        if (pointerLstatIfPresent(target, fs)) {
          assertPointerBinding(target, sourceBinding, fs, "installed catalog pointer before rollback");
          renameCatalogPointerWithRetry(target, source, fs);
          assertPointerBinding(source, sourceBinding, fs, "restaged catalog pointer after rollback");
        }
      } catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    if (displacedOld) {
      try {
        if (pointerLstatIfPresent(target, fs)) {
          rollbackFailures.push(new Error(`Windows catalog pointer rollback is incomplete: ${target} was recreated while ${displaced} retains the prior pointer.`));
        } else if (!pointerLstatIfPresent(displaced, fs)) {
          rollbackFailures.push(new Error(`Windows catalog pointer rollback is incomplete: displaced prior pointer is missing at ${displaced}.`));
        } else {
          assertPointerBinding(displaced, expected, fs, "displaced catalog pointer before rollback");
          renameCatalogPointerWithRetry(displaced, target, fs);
          assertPointerBinding(target, expected, fs, "restored catalog pointer");
          rollbackComplete = true;
        }
      } catch (rollbackError) { rollbackFailures.push(rollbackError); }
    }
    throw pointerTransactionError(error, { installed, rollbackComplete, displaced: error?.catalogPointerResidue || displaced, expected, residues: [error?.catalogPointerResidue || displaced] }, rollbackFailures);
  }
}

function aggregateRestoreFailures(primary, failures, message) {
  if (failures.length === 0) return primary;
  return new AggregateError([primary, ...failures], message, { cause: primary });
}

function verifyProtectedPath(target, fs) {
  if (fsPlatform(fs) !== "win32") return true;
  if (!fs.verifyProtected(target)) throw new Error(`Restored protected runtime file is not private: ${target}`);
  return true;
}

function writableStageMode(mode) {
  return mode | 0o600;
}

function protectWindowsOnly(target, protectedEntry, fs) {
  if (protectedEntry && fsPlatform(fs) === "win32") fs.protect(target);
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

function snapshotCatalogTopologyIsValid(topology, snapshot) {
  if (!topology || topology.version !== 1 || typeof topology.stateRoot !== "string" || typeof topology.generationsDir !== "string") {
    throw new Error("Invalid managed catalog topology snapshot.");
  }
  const target = targetFrom(snapshot?.target);
  if (path.normalize(topology.stateRoot) !== target.stateRoot) {
    throw new Error("Managed catalog topology snapshot state root is not bound to its ServiceTarget.");
  }
  const expectedGenerations = path.join(target.stateRoot, "catalog-generations");
  if (path.normalize(topology.generationsDir) !== expectedGenerations) {
    throw new Error("Managed catalog topology snapshot generations directory is not bound to its ServiceTarget.");
  }
  directGenerationName(topology.generation);
  const identities = topology.identities;
  for (const [name, identity] of Object.entries({
    "catalog state root": identities?.stateIdentity,
    "catalog generations root": identities?.generationsIdentity,
    "catalog generation": identities?.generationIdentity,
  })) {
    if (!identity || typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") {
      throw new Error(`Managed catalog topology snapshot has no BigInt identity for ${name}.`);
    }
  }
  if (!topology.files || typeof topology.files !== "object") throw new Error("Managed catalog topology snapshot is missing generation files.");
  for (const name of CATALOG_GENERATION_FILES) {
    const file = topology.files[name];
    const id = MANAGED_CATALOG_ID_BY_FILE[name];
    const entry = snapshot.entries?.[id];
    if (
      !entry
      || entry.id !== id
      || entry.path !== path.join(target.stateRoot, name)
      || entry.type !== "catalog-topology-link"
      || entry.existed !== true
      || !Buffer.isBuffer(file?.bytes)
      || typeof file.digest !== "string"
      || createHash("sha256").update(file.bytes).digest("hex") !== file.digest
      || (target.platform !== "win32" && file.mode !== 0o600)
    ) {
      throw new Error(`Managed catalog topology snapshot has an invalid artifact: ${name}`);
    }
  }
}

function exactCatalogGeneration(topology, generationDir, fs) {
  const generationStat = lstatIfPresent(generationDir, fs);
  if (!generationStat?.isDirectory() || generationStat.isSymbolicLink()) return false;
  const names = fs.readdir(generationDir).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(names) !== JSON.stringify([...CATALOG_GENERATION_FILES].sort((left, right) => left.localeCompare(right)))) return false;
  for (const name of CATALOG_GENERATION_FILES) {
    const artifact = path.join(generationDir, name);
    const stat = lstatIfPresent(artifact, fs);
    try {
      if (!stat || stat.isSymbolicLink()) return false;
      privateCatalogFile(stat, artifact, fs);
      if (Buffer.compare(Buffer.from(fs.read(artifact)), Buffer.from(topology.files[name].bytes)) !== 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function createRestoredCatalogGeneration(topology, fs, assertRoots) {
  assertRoots();
  fs.mkdir(topology.generationsDir, { recursive: true, mode: 0o700 });
  assertRoots();
  const generation = `restore-${Date.now().toString(36)}-${process.pid}-${randomUUID()}`;
  const generationDir = path.join(topology.generationsDir, generation);
  fs.mkdir(generationDir, { mode: 0o700 });
  const generationIdentity = directoryIdentity(generationDir, fs, "restored catalog generation");
  const assertGeneration = () => assertDirectoryIdentity(
    generationDir,
    generationIdentity,
    fs,
    "restored catalog generation",
  );
  try {
    for (const name of CATALOG_GENERATION_FILES) {
      assertRoots();
      assertGeneration();
      writeStagedFile(path.join(generationDir, name), topology.files[name].bytes, 0o600, true, fs);
      assertRoots();
      assertGeneration();
    }
    assertRoots();
    assertGeneration();
    fsyncDirectory(generationDir, fs);
    assertRoots();
    assertGeneration();
    fsyncDirectory(topology.generationsDir, fs);
    assertRoots();
    assertGeneration();
    return { generation, generationDir, generationIdentity };
  } catch (error) {
    const cleanupFailures = [];
    try {
      assertRoots();
      assertGeneration();
      if (lstatIfPresent(generationDir, fs)) removeExact(generationDir, fs);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    throw aggregateRestoreFailures(error, cleanupFailures, "Managed catalog generation restore staging failed.");
  }
}

function isOnlySnapshottedCatalogGenerationMissing(topology, fs) {
  if (lstatIfPresent(topology.generationsDir, fs)?.isSymbolicLink()) return false;
  const stablePaths = catalogStablePaths(topology.stateRoot);
  for (const name of CATALOG_GENERATION_FILES) {
    const stable = lstatIfPresent(stablePaths[name], fs);
    if (!stable?.isSymbolicLink()) return false;
    try {
      normalizedStableCatalogTarget(fs.readlink(stablePaths[name]), name);
    } catch {
      return false;
    }
  }
  const currentDir = path.join(topology.generationsDir, "current");
  const current = lstatIfPresent(currentDir, fs);
  if (!current?.isSymbolicLink() || fs.readlink(currentDir) !== topology.generation) return false;
  return lstatIfPresent(path.join(topology.generationsDir, topology.generation), fs) === undefined;
}

function restoreManagedCatalogTopology(topology, snapshot, fs) {
  snapshotCatalogTopologyIsValid(topology, snapshot);
  // Treat any mixed/missing stable view as tampering. A valid replacement may
  // point current at a different complete generation, which is the one state
  // rollback is intentionally allowed to supersede.
  let current;
  try {
    current = inspectManagedCatalogTopology([
      { id: "state-catalog", path: path.join(topology.stateRoot, "merged-models.json") },
    ], fs);
  } catch (error) {
    if (!isOnlySnapshottedCatalogGenerationMissing(topology, fs)) throw error;
    current = { generation: topology.generation, missingSnapshottedGeneration: true };
  }
  if (!current) throw catalogTopologyError("managed catalog topology disappeared before restore");
  const assertRoots = () => {
    assertDirectoryIdentity(topology.stateRoot, topology.identities.stateIdentity, fs, "catalog state root");
    assertDirectoryIdentity(topology.generationsDir, topology.identities.generationsIdentity, fs, "catalog generations root");
  };
  // The snapshot's roots, not merely the currently inspected topology, bind
  // every subsequent create/write/rename to the original ServiceTarget tree.
  assertRoots();
  const preferred = path.join(topology.generationsDir, topology.generation);
  let createdGeneration;
  const preferredMatchesSnapshot = exactCatalogGeneration(topology, preferred, fs)
    && (() => {
      try {
        const identity = directoryIdentity(preferred, fs, "catalog generation");
        return sameDirectoryIdentity(identity, topology.identities.generationIdentity);
      } catch {
        return false;
      }
    })();
  const source = preferredMatchesSnapshot
    ? {
        generation: topology.generation,
        generationDir: preferred,
        generationIdentity: topology.identities.generationIdentity,
      }
    : (createdGeneration = createRestoredCatalogGeneration(topology, fs, assertRoots));
  const assertSource = () => assertDirectoryIdentity(
    source.generationDir,
    source.generationIdentity,
    fs,
    "catalog restore generation",
  );
  assertRoots();
  assertSource();
  const currentDir = path.join(topology.generationsDir, "current");
  const next = siblingPath(currentDir, "catalog-current-restore");
  const installedPointerResidues = new Set();
  let nextBinding;
  let pointerInstalled = false;
  let pointerRolledBack = false;
  try {
    assertRoots();
    assertSource();
    fs.symlink(source.generation, next, "dir");
    if (fsPlatform(fs) === "win32") nextBinding = pointerBinding(next, fs, "catalog restore pointer");
    assertRoots();
    assertSource();
    assertRoots();
    assertSource();
    const pointer = renameCatalogPointer(next, currentDir, fs);
    for (const residue of pointer.residues || []) installedPointerResidues.add(residue);
    pointerInstalled = pointer.installed;
    assertRoots();
    assertSource();
    fsyncDirectory(topology.generationsDir, fs);
    assertRoots();
    assertSource();
    const restored = inspectManagedCatalogTopology([
      { id: "state-catalog", path: path.join(topology.stateRoot, "merged-models.json") },
    ], fs);
    if (!restored || restored.generation !== source.generation || !exactCatalogGeneration(topology, path.join(topology.generationsDir, source.generation), fs)) {
      throw catalogTopologyError("managed catalog topology did not match its restored snapshot");
    }
    assertRoots();
    assertSource();
    return;
  } catch (error) {
    const cleanupFailures = [];
    const transaction = error?.catalogPointerTransaction;
    let rollbackTransaction;
    let rollbackBinding;
    const recoveryResidues = new Set([...installedPointerResidues]);
    recordPointerFailure(error, recoveryResidues);
    if (transaction) {
      pointerInstalled ||= transaction.installed === true;
      pointerRolledBack ||= transaction.rollbackComplete === true;
    }
    if (pointerInstalled && !pointerRolledBack) {
      const rollback = siblingPath(currentDir, "catalog-current-rollback");
      try {
        fs.symlink(current.generation, rollback, "dir");
        if (fsPlatform(fs) === "win32") rollbackBinding = pointerBinding(rollback, fs, "catalog rollback pointer");
        const rollbackResult = renameCatalogPointer(rollback, currentDir, fs);
        for (const residue of rollbackResult.residues || []) recoveryResidues.add(residue);
        fsyncDirectory(topology.generationsDir, fs);
        pointerRolledBack = rollbackResult.installed && pointerTargets(currentDir, current.generation, fs);
      } catch (rollbackError) {
        rollbackTransaction = rollbackError?.catalogPointerTransaction;
        recordPointerFailure(rollbackError, recoveryResidues);
        if (rollbackTransaction?.installed === true) {
          try { pointerRolledBack ||= pointerTargets(currentDir, current.generation, fs); } catch (bindingError) { cleanupFailures.push(bindingError); }
        }
        cleanupFailures.push(rollbackError);
      } finally {
        try {
          if (pointerLstatIfPresent(rollback, fs)) {
            if (fsPlatform(fs) !== "win32") {
              fs.unlink(rollback);
            } else if (!pointerRolledBack || !pointerTargets(currentDir, current.generation, fs) || !rollbackBinding) {
              throw new Error(`Preserving rollback pointer at ${rollback} because the old catalog pointer is not bound at current.`);
            } else {
              recoveryResidues.add(removeVerifiedPointer(rollback, rollbackBinding, fs, "catalog rollback pointer"));
            }
          }
        } catch (cleanupError) {
          recordPointerFailure(cleanupError, recoveryResidues);
          cleanupFailures.push(cleanupError);
        }
      }
    }
    for (const [index, pointerTransaction] of [transaction, rollbackTransaction].entries()) {
      if (!pointerRolledBack || !pointerTransaction?.displaced) continue;
      try {
        const displaced = pointerLstatIfPresent(pointerTransaction.displaced, fs);
        if (!displaced) continue;
        if (!pointerTransaction.expected || !pointerTargets(currentDir, current.generation, fs) || !samePointerBinding(pointerBinding(pointerTransaction.displaced, fs, "displaced catalog pointer residue"), pointerTransaction.expected)) {
          throw new Error(`Windows catalog pointer rollback left an unbound displaced-pointer residue at transaction ${index}.`);
        }
        recoveryResidues.add(removeVerifiedPointer(pointerTransaction.displaced, pointerTransaction.expected, fs, "displaced catalog pointer residue"));
      } catch (cleanupError) {
        recordPointerFailure(cleanupError, recoveryResidues);
        cleanupFailures.push(cleanupError);
      }
    }
    try {
      if (pointerLstatIfPresent(next, fs)) {
        if (fsPlatform(fs) !== "win32") fs.unlink(next);
        else if (!nextBinding) throw new Error(`Preserving unbound catalog restore pointer at ${next}.`);
        else recoveryResidues.add(removeVerifiedPointer(next, nextBinding, fs, "catalog restore pointer"));
      }
    } catch (cleanupError) {
      recordPointerFailure(cleanupError, recoveryResidues);
      cleanupFailures.push(cleanupError);
    }
    let sourceStillReferenced = false;
    try {
      const residues = [next, ...recoveryResidues];
      sourceStillReferenced = [currentDir, ...residues.filter(Boolean)].some((pointer) => pointerTargets(pointer, source.generation, fs));
    } catch (referenceError) {
      sourceStillReferenced = true;
      cleanupFailures.push(referenceError);
    }
    if (createdGeneration && sourceStillReferenced) {
      cleanupFailures.push(new Error(`Preserving restored catalog generation because a live pointer still references ${source.generation}.`));
    } else if (createdGeneration && (!pointerInstalled || pointerRolledBack)) {
      try {
        assertRoots();
        assertSource();
        if (lstatIfPresent(createdGeneration.generationDir, fs)) removeExact(createdGeneration.generationDir, fs);
      } catch (cleanupError) {
        recordPointerFailure(cleanupError, recoveryResidues);
        cleanupFailures.push(cleanupError);
      }
    }
    throw aggregateRestoreFailures(error, cleanupFailures, "Managed catalog current restore failed.");
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
  // Validate every resolver-bound entry before any restore branch can create,
  // rename, or remove a path. A snapshot is untrusted rollback input.
  for (const entry of Object.values(snapshot.entries)) validateSnapshotEntry(entry, snapshot);
  const managedTopology = snapshot.catalogTopology;
  if (managedTopology) restoreManagedCatalogTopology(managedTopology, snapshot, fs);
  else {
    // A legacy regular snapshot must never overwrite a topology that appeared
    // later; that would silently turn authoritative stable links into files.
    const catalogEntries = Object.values(snapshot.entries).filter((entry) => MANAGED_CATALOG_IDS.has(entry.id));
    if (catalogEntries.length > 0) {
      const currentTopology = inspectManagedCatalogTopology(catalogEntries, fs);
      if (currentTopology) throw catalogTopologyError("managed catalog topology appeared after a legacy snapshot");
    }
  }
  for (const entry of Object.values(snapshot.entries)) {
    if (entry.type === "catalog-topology-link") {
      if (!managedTopology) throw new Error("Managed catalog topology entry has no topology snapshot.");
      continue;
    }
    if (!entry.existed) {
      const current = lstatIfPresent(entry.path, fs);
      if (current?.isSymbolicLink()) {
        throw new Error(`Refusing to remove a symlink or junction restored over an originally missing runtime path: ${entry.path}`);
      }
      if (current) removeExact(entry.path, fs);
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
