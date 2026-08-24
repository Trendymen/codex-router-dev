import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnsupportedPlatform } from "./platform-gate.mjs";
import { trayBundleDir } from "./tray-install.mjs";
import { currentServiceTarget } from "./paths.mjs";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP_NAME = ".codex-router-install.json";

export const NODE_MINIMUM = Object.freeze({ major: 22, minor: 19, patch: 0 });

function numericNodeVersion(version) {
  const match = String(version || "").trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2] || 0),
    patch: Number(match[3] || 0),
  };
}

/**
 * Compare Node versions by numeric components.  A lexical comparison would
 * incorrectly treat 22.9 as newer than 22.19, which is the minimum required
 * by the shipped Router and Swift command bridge.
 */
export function nodeMeetsMinimum(version = process.versions.node, minimum = NODE_MINIMUM) {
  const actual = numericNodeVersion(version);
  if (!actual) return false;
  if (actual.major !== minimum.major) return actual.major > minimum.major;
  if (actual.minor !== minimum.minor) return actual.minor > minimum.minor;
  return actual.patch >= minimum.patch;
}

function readTextFile(target) {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function readSwiftSource(target) {
  try {
    return readFileSync(target);
  } catch (error) {
    throw new Error(`Cannot read Swift package input ${target}.`, { cause: error });
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function byteOrder(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sourceFilesIn(dir) {
  const result = [];
  function visit(current) {
    let entries;
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Swift source path is a symlink: ${current}`);
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => byteOrder(left.name, right.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Swift source path is a symlink: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) result.push(full);
      else throw new Error(`Swift source path is not a regular file: ${full}`);
    }
  }
  try {
    visit(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return result;
}

const TRAY_PLATFORMS = Object.freeze({
  darwin: {
    sources: (root) => {
      const base = path.join(root, "apps", "macos", "ModelRouterTray");
      if (existsSync(base) && lstatSync(base).isSymbolicLink()) {
        throw new Error(`Swift source path is a symlink: ${base}`);
      }
      const packageFile = path.join(base, "Package.swift");
      if (!existsSync(packageFile)) throw new Error(`Swift package input is missing: ${packageFile}`);
      if (existsSync(packageFile) && lstatSync(packageFile).isSymbolicLink()) {
        throw new Error(`Swift source path is a symlink: ${packageFile}`);
      }
      return [
        packageFile,
        ...sourceFilesIn(path.join(base, "Sources")),
        ...sourceFilesIn(path.join(base, "Resources")),
      ];
    },
    artifact: (root, home, target) =>
      target?.appBinary || path.join(trayBundleDir("darwin", home), "Contents", "MacOS", "ModelRouterTray"),
    stamp: (root, home, target) =>
      path.join(target?.stateRoot || path.join(home, ".codex", "codex-router"), "tray-build.json"),
    legacy: (root) => path.join(root, "dist", "Model Router.app", "Contents", "MacOS", "ModelRouterTray"),
  },
});

export function traySourceFingerprint(root = SOURCE_ROOT, platform = process.platform) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) return "";
  const files = definition.sources(root).sort((left, right) => byteOrder(
    path.relative(root, left).replaceAll("\\", "/"),
    path.relative(root, right).replaceAll("\\", "/"),
  ));
  const hash = createHash("sha256");
  for (const file of files) {
    const relativeBytes = Buffer.from(path.relative(root, file).replaceAll("\\", "/"), "utf8");
    const contents = readSwiftSource(file);
    if (relativeBytes.byteLength > 0xffffffff || contents.byteLength > 0xffffffff) {
      throw new Error(`Swift package input is too large: ${file}`);
    }
    const lengths = Buffer.alloc(8);
    lengths.writeUInt32BE(relativeBytes.byteLength, 0);
    lengths.writeUInt32BE(contents.byteLength, 4);
    hash.update(lengths).update(relativeBytes).update(contents);
  }
  return hash.digest("hex");
}

function resolvedTrayTarget({ root, platform, home, serviceTarget }) {
  if (serviceTarget) return serviceTarget;
  if (platform === "darwin" && root === SOURCE_ROOT && home === os.homedir()) return currentServiceTarget();
  return undefined;
}

export const STEPS = Object.freeze({
  "node-deps": {
    stamp: (root) => path.join(root, "node_modules", STAMP_NAME),
    fingerprint: (root) => sha256([`node:${process.versions.node.split(".")[0]}`, readTextFile(path.join(root, "package-lock.json")) ?? ""].join("\0")),
    installed: (root) => existsSync(path.join(root, "node_modules", ".package-lock.json")),
    skipMessage: "Node dependencies already match package-lock.json; skipping npm ci.",
  },
});

export function trayRebuildPlan({
  root = SOURCE_ROOT,
  platform = process.platform,
  home = os.homedir(),
  serviceTarget,
} = {}) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) return "unsupported";
  const target = resolvedTrayTarget({ root, platform, home, serviceTarget });
  if (!existsSync(definition.artifact(root, home, target))) {
    return definition.legacy?.(root) && existsSync(definition.legacy(root)) ? "rebuild" : "absent";
  }
  const stamp = readTextFile(definition.stamp(root, home, target));
  if (!stamp) return "rebuild";
  try {
    return JSON.parse(stamp)?.fingerprint === traySourceFingerprint(root, platform) ? "skip" : "rebuild";
  } catch {
    return "rebuild";
  }
}

export function recordTrayBuild({
  root = SOURCE_ROOT,
  platform = process.platform,
  home = os.homedir(),
  serviceTarget,
} = {}) {
  const definition = TRAY_PLATFORMS[platform];
  if (!definition) throw new Error(`The Swift tray is only built on macOS, not ${platform}.`);
  const target = definition.stamp(root, home, resolvedTrayTarget({ root, platform, home, serviceTarget }));
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify({ version: 1, step: "tray", fingerprint: traySourceFingerprint(root, platform) }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return target;
}

export function stepStatus(step, { root = SOURCE_ROOT, platform = process.platform } = {}) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  if (!definition.installed(root, platform)) return "run";
  const stamp = readTextFile(definition.stamp(root));
  if (!stamp) return "run";
  try {
    return JSON.parse(stamp)?.fingerprint === definition.fingerprint(root) ? "skip" : "run";
  } catch {
    return "run";
  }
}

export function recordStep(step, { root = SOURCE_ROOT } = {}) {
  const definition = STEPS[step];
  if (!definition) throw new Error(`Unknown install step: ${step}`);
  const target = definition.stamp(root);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify({ version: 1, step, fingerprint: definition.fingerprint(root) }, null, 2)}\n`, { encoding: "utf8" });
  return target;
}

function main(argv) {
  const [command, step] = argv;
  if (command === "status") {
    let status = "run";
    try { status = stepStatus(step); } catch { status = "run"; }
    process.stdout.write(`${status}\n`);
    return 0;
  }
  if (command === "record") {
    recordStep(step);
    return 0;
  }
  if (command === "tray-plan") {
    let plan = "absent";
    try { plan = trayRebuildPlan(); } catch { plan = "absent"; }
    process.stdout.write(`${plan}\n`);
    return 0;
  }
  if (command === "record-tray") {
    recordTrayBuild();
    return 0;
  }
  console.error("Usage: install-plan.mjs status|record <node-deps> | tray-plan | record-tray");
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command] = process.argv.slice(2);
    if (["record-tray"].includes(command) && refuseUnsupportedPlatform(`install-plan:${command}`)) process.exit(2);
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
