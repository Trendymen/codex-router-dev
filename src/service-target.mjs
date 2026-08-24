import { existsSync, lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_LABEL = "io.github.codex-router";
const PRODUCTION_TRAY_LABEL = `${PRODUCTION_LABEL}.tray`;
const PRODUCTION_PORTS = Object.freeze({
  oauth: 4201,
  router: 4202,
  api: 4203,
  grokOauth: 4208,
  devinCli: 4210,
});
const DNS_LABEL = "[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const LABEL_PATTERN = new RegExp(`^(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`);
const MODES = new Set(["production", "acceptance", "test"]);
const PORT_NAMES = Object.keys(PRODUCTION_PORTS);
const validatedTargets = new WeakSet();
const validatedIsolationRoots = new WeakMap();

export function isValidatedServiceTarget(value) {
  return Boolean(value && typeof value === "object" && validatedTargets.has(value));
}

export function validatedIsolationRoot(value) {
  return validatedIsolationRoots.get(value);
}

function absolute(value, name) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
}

function existingPathHasLink(target, stopAt) {
  let current = path.resolve(target);
  const boundary = stopAt ? path.resolve(stopAt) : undefined;
  while (true) {
    if (existsSync(current)) {
      try {
        if (lstatSync(current).isSymbolicLink()) return true;
      } catch (error) {
        throw new Error(`Cannot inspect isolated target path ${current}: ${error.message}`, { cause: error });
      }
    }
    if (boundary && current === boundary) return false;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function inside(root, value, name) {
  const relative = path.relative(root, value);
  if (relative === "" || relative === "." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} must be inside the isolated root.`);
  }
  // A shared system ancestor may itself be an alias (macOS /var ->
  // /private/var). Refuse links at the isolated root and below, but do not
  // reject a target merely because root and value traverse the same canonical
  // system alias.
  if (existingPathHasLink(value, root)) {
    throw new Error(`${name} cannot cross a symlink or junction.`);
  }
  return value;
}

/**
 * Validate a caller-provided bundle/output path below a resolved target
 * parent. The check is deliberately stricter than path.normalize: traversal
 * spelling and every existing symlink/junction are refused before a caller
 * can create, replace, remove, or sign anything below the target.
 */
export function validatePathWithin(parent, candidate, name = "path") {
  if (typeof parent !== "string" || !path.isAbsolute(parent)) {
    throw new Error("parent must be an absolute path.");
  }
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(candidate)) {
    throw new Error(`${name} contains a dot segment.`);
  }
  const root = path.normalize(parent);
  const value = path.normalize(candidate);
  const relative = path.relative(root, value);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} must be below parent.`);
  }
  const nearestExisting = (valueToInspect) => {
    let current = valueToInspect;
    while (!existsSync(current)) {
      const parentPath = path.dirname(current);
      if (parentPath === current) return current;
      current = parentPath;
    }
    return current;
  };
  const inspectAncestors = (valueToInspect, stopAt) => {
    let current = valueToInspect;
    while (true) {
      if (existsSync(current)) {
        try {
          if (lstatSync(current).isSymbolicLink()) {
            throw new Error(`${name} crosses a symlink or junction.`);
          }
          realpathSync(current);
        } catch (error) {
          if (error?.message?.includes("crosses a symlink")) throw error;
          throw new Error(`Cannot inspect ${name}: ${error.message}`, { cause: error });
        }
      }
      if (current === stopAt) return;
      const parentPath = path.dirname(current);
      if (parentPath === current) return;
      current = parentPath;
    }
  };
  const canonical = (valueToInspect) => {
    const existing = nearestExisting(valueToInspect);
    const existingReal = realpathSync(existing);
    const suffix = path.relative(existing, valueToInspect);
    return path.resolve(existingReal, suffix);
  };
  inspectAncestors(value, root);
  const canonicalRoot = canonical(root);
  const canonicalValue = canonical(value);
  const canonicalRelative = path.relative(canonicalRoot, canonicalValue);
  if (!canonicalRelative || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error(`${name} resolves outside parent.`);
  }
  return value;
}

function collisionPath(value, platform) {
  const normalized = path.normalize(String(value)).replaceAll("/", path.sep);
  return ["win32", "darwin"].includes(platform) ? normalized.toLowerCase() : normalized;
}

function pathOverlaps(left, right, platform) {
  const a = collisionPath(left, platform);
  const b = collisionPath(right, platform);
  if (a === b) return true;
  const separator = path.sep;
  return b.startsWith(`${a}${separator}`) || a.startsWith(`${b}${separator}`);
}

const ALLOWED_CONTAINMENT = new Set([
  "launchAgentsDir>routerPlistPath",
  "launchAgentsDir>trayPlistPath",
  "appPath>appBinary",
  "stateRoot>supportRoot",
  "stateRoot>logPath",
]);

function allowedContainment(parentName, parentPath, childName, childPath, platform) {
  const relation = `${parentName}>${childName}`;
  if (!ALLOWED_CONTAINMENT.has(relation)) return false;
  const normalizedParent = collisionPath(parentPath, platform);
  const normalizedChild = collisionPath(childPath, platform);
  return normalizedChild.startsWith(`${normalizedParent}${path.sep}`);
}

function assertPathSetDoesNotOverlap(entries, platform, label) {
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftName, leftPath] = entries[left];
      const [rightName, rightPath] = entries[right];
      if (!pathOverlaps(leftPath, rightPath, platform)) continue;
      if (allowedContainment(leftName, leftPath, rightName, rightPath, platform)) continue;
      if (allowedContainment(rightName, rightPath, leftName, leftPath, platform)) continue;
      throw new Error(`${label} paths ${leftName} and ${rightName} collide or overlap.`);
    }
  }
}

function label(value, name) {
  if (typeof value !== "string" || value.length > 253 || !LABEL_PATTERN.test(value)) {
    throw new Error(`${name} must be a strict reverse-DNS service label.`);
  }
  return value;
}

function port(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a loopback TCP port between 1 and 65535.`);
  }
  return value;
}

function ports(value) {
  const candidate = { ...PRODUCTION_PORTS, ...(value || {}) };
  const result = {};
  const seen = new Set();
  for (const name of PORT_NAMES) {
    const number = port(candidate[name], `ports.${name}`);
    if (seen.has(number)) throw new Error(`ports.${name} duplicates another loopback port.`);
    seen.add(number);
    result[name] = number;
  }
  if (candidate.host !== undefined && candidate.host !== "127.0.0.1") {
    throw new Error("ServiceTarget accepts loopback host 127.0.0.1 only.");
  }
  return Object.freeze(result);
}

function productionDefaults() {
  const home = path.join(os.homedir(), ".codex");
  // This is the collision baseline, not the current test/acceptance
  // environment. Runtime overrides belong to paths.mjs' injected defaults;
  // allowing them here would make an isolated target collide with itself.
  const stateRoot = path.join(home, "codex-router");
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const appPath = path.join(os.homedir(), "Applications", "Model Router.app");
  return {
    mode: "production",
    sourceRoot: SOURCE_ROOT,
    launchDomain: `gui/${typeof process.getuid === "function" ? process.getuid() : 501}`,
    routerLabel: PRODUCTION_LABEL,
    trayLabel: PRODUCTION_TRAY_LABEL,
    launchAgentsDir: path.normalize(launchAgentsDir),
    routerPlistPath: path.join(launchAgentsDir, `${PRODUCTION_LABEL}.plist`),
    trayPlistPath: path.join(launchAgentsDir, `${PRODUCTION_TRAY_LABEL}.plist`),
    appPath,
    appBinary: path.join(appPath, "Contents", "MacOS", "ModelRouterTray"),
    stateRoot: path.normalize(stateRoot),
    supportRoot: path.join(stateRoot, "support"),
    logPath: path.join(stateRoot, "router.log"),
    ports: PRODUCTION_PORTS,
    host: "127.0.0.1",
  };
}

export const PRODUCTION_SERVICE_TARGET = Object.freeze({
  ...productionDefaults(),
  ports: PRODUCTION_PORTS,
});

function assertMode(overrides, mode) {
  if (!MODES.has(mode)) throw new Error(`Unsupported ServiceTarget mode: ${mode}.`);
  const overrideKeys = Object.keys(overrides).filter((key) => key !== "mode");
  if (mode === "production" && overrideKeys.length) {
    throw new Error("ServiceTarget overrides require explicit acceptance or test mode.");
  }
}

export function resolveServiceTarget(overrides = {}, defaults = PRODUCTION_SERVICE_TARGET) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("ServiceTarget overrides must be an object.");
  }
  const mode = overrides.mode || "production";
  assertMode(overrides, mode);
  const injectedProduction = defaults.production;
  const defaultFields = { ...defaults };
  delete defaultFields.production;
  const base = { ...PRODUCTION_SERVICE_TARGET, ...defaultFields };
  const production = { ...PRODUCTION_SERVICE_TARGET, ...(injectedProduction || (defaults === PRODUCTION_SERVICE_TARGET ? {} : defaultFields)) };
  const platform = overrides.platform || base.platform || process.platform;
  if (!["darwin", "win32", "linux"].includes(platform)) {
    throw new Error(`Unsupported ServiceTarget platform: ${platform}.`);
  }
  const root = overrides.isolationRoot === undefined
    ? undefined
    : absolute(overrides.isolationRoot, "isolationRoot");
  if (mode !== "production" && !root) {
    throw new Error("Acceptance and test ServiceTargets require an absolute isolationRoot.");
  }
  if (root && existingPathHasLink(root, root)) throw new Error("isolationRoot cannot be a symlink or junction.");

  const isolatedDefaults = root
    ? (() => {
        const isolatedStateRoot = overrides.stateRoot
          ? path.normalize(overrides.stateRoot)
          : path.join(root, "state");
        const isolatedAppPath = overrides.appPath
          ? path.normalize(overrides.appPath)
          : path.join(root, "Applications", "Model Router.app");
        return {
        launchAgentsDir: path.join(root, "LaunchAgents"),
        routerPlistPath: path.join(root, "LaunchAgents", `${overrides.routerLabel || base.routerLabel}.plist`),
        trayPlistPath: path.join(root, "LaunchAgents", `${overrides.trayLabel || base.trayLabel}.plist`),
        appPath: isolatedAppPath,
        appBinary: path.join(isolatedAppPath, "Contents", "MacOS", "ModelRouterTray"),
        stateRoot: isolatedStateRoot,
        supportRoot: path.join(isolatedStateRoot, "support"),
        logPath: path.join(isolatedStateRoot, "router.log"),
        };
      })()
    : {};
  const pathDefaults = { ...base, ...isolatedDefaults };

  const target = {
    mode,
    platform,
    sourceRoot: absolute(overrides.sourceRoot || pathDefaults.sourceRoot, "sourceRoot"),
    launchDomain: overrides.launchDomain || pathDefaults.launchDomain,
    routerLabel: label(overrides.routerLabel || pathDefaults.routerLabel, "routerLabel"),
    trayLabel: label(overrides.trayLabel || pathDefaults.trayLabel, "trayLabel"),
    launchAgentsDir: absolute(overrides.launchAgentsDir || pathDefaults.launchAgentsDir, "launchAgentsDir"),
    routerPlistPath: absolute(overrides.routerPlistPath || pathDefaults.routerPlistPath, "routerPlistPath"),
    trayPlistPath: absolute(overrides.trayPlistPath || pathDefaults.trayPlistPath, "trayPlistPath"),
    appPath: absolute(overrides.appPath || pathDefaults.appPath, "appPath"),
    appBinary: absolute(overrides.appBinary || pathDefaults.appBinary, "appBinary"),
    stateRoot: absolute(overrides.stateRoot || pathDefaults.stateRoot, "stateRoot"),
    supportRoot: absolute(overrides.supportRoot || pathDefaults.supportRoot, "supportRoot"),
    logPath: absolute(overrides.logPath || pathDefaults.logPath, "logPath"),
    ports: ports(overrides.ports || base.ports),
    host: overrides.host || pathDefaults.host || "127.0.0.1",
  };
  if (target.host !== "127.0.0.1") throw new Error("ServiceTarget accepts loopback host 127.0.0.1 only.");
  if (!/^gui\/[0-9]+$/.test(target.launchDomain)) {
    throw new Error("launchDomain must be a user launchd gui/<uid> domain.");
  }
  if (target.routerLabel === target.trayLabel) throw new Error("Router and Tray labels must be unique.");
  if (!target.trayLabel.toLowerCase().startsWith(`${target.routerLabel.toLowerCase()}.`)) {
    throw new Error("Tray label must be a sibling namespace below the Router label.");
  }
  if (target.routerPlistPath === target.trayPlistPath) {
    throw new Error("Router and Tray plist paths must be unique.");
  }
  target.routerService = `${target.launchDomain}/${target.routerLabel}`;
  target.trayService = `${target.launchDomain}/${target.trayLabel}`;

  if (root) {
    if (overrides.sourceRoot) inside(root, target.sourceRoot, "sourceRoot");
    for (const [name, value] of Object.entries({
      launchAgentsDir: target.launchAgentsDir,
      routerPlistPath: target.routerPlistPath,
      trayPlistPath: target.trayPlistPath,
      appPath: target.appPath,
      appBinary: target.appBinary,
      stateRoot: target.stateRoot,
      supportRoot: target.supportRoot,
      logPath: target.logPath,
    })) inside(root, value, name);
    const targetPaths = [
      ["launchAgentsDir", target.launchAgentsDir],
      ["routerPlistPath", target.routerPlistPath],
      ["trayPlistPath", target.trayPlistPath],
      ["appPath", target.appPath],
      ["appBinary", target.appBinary],
      ["stateRoot", target.stateRoot],
      ["supportRoot", target.supportRoot],
      ["logPath", target.logPath],
    ];
    const productionPaths = targetPaths.map(([name]) => [name, production[name]]);
    assertPathSetDoesNotOverlap(targetPaths, platform, "Target");
    for (const [targetName, targetPath] of targetPaths) {
      for (const [productionName, productionPath] of productionPaths) {
        if (pathOverlaps(targetPath, productionPath, platform)) {
          throw new Error(`Target path ${targetName} collides or overlaps production path ${productionName}.`);
        }
      }
    }
    const productionLabels = new Set([
      production.routerLabel.toLowerCase(),
      production.trayLabel.toLowerCase(),
    ]);
    if (productionLabels.has(target.routerLabel.toLowerCase()) || productionLabels.has(target.trayLabel.toLowerCase())) {
      throw new Error("Service labels collide with the production ServiceTarget.");
    }
    const productionPorts = new Set(PORT_NAMES.map((name) => production.ports[name]));
    for (const name of PORT_NAMES) {
      if (productionPorts.has(target.ports[name])) {
        throw new Error(`ports.${name} collides with a production loopback port.`);
      }
    }
  }
  const frozen = Object.freeze(target);
  validatedTargets.add(frozen);
  if (root) validatedIsolationRoots.set(frozen, root);
  return frozen;
}
