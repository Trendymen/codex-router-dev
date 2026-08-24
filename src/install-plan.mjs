import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnsupportedPlatform } from "./platform-gate.mjs";
import { trayBundleDir } from "./tray-install.mjs";
import { currentServiceTarget } from "./paths.mjs";

export const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP_NAME = ".codex-router-install.json";

function readFile(target) {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFilesIn(dir, extensions) {
  try {
    return readdirSync(dir)
      .sort()
      .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

const TRAY_PLATFORMS = Object.freeze({
  darwin: {
    sources: (root) => {
      const base = path.join(root, "apps", "macos", "ModelRouterTray");
      return [
        path.join(base, "Package.swift"),
        path.join(base, "Resources", "Info.plist"),
        ...sourceFilesIn(path.join(base, "Sources"), [".swift"]),
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
  return sha256(
    definition
      .sources(root)
      .map((file) => `${path.relative(root, file)}\0${readFile(file) ?? ""}`)
      .join("\0"),
  );
}

function resolvedTrayTarget({ root, platform, home, serviceTarget }) {
  if (serviceTarget) return serviceTarget;
  if (platform === "darwin" && root === SOURCE_ROOT && home === os.homedir()) return currentServiceTarget();
  return undefined;
}

export const STEPS = Object.freeze({
  "node-deps": {
    stamp: (root) => path.join(root, "node_modules", STAMP_NAME),
    fingerprint: (root) => sha256([`node:${process.versions.node.split(".")[0]}`, readFile(path.join(root, "package-lock.json")) ?? ""].join("\0")),
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
  const stamp = readFile(definition.stamp(root, home, target));
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
  const stamp = readFile(definition.stamp(root));
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
