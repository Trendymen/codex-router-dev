import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCallerUrl } from "./caller-auth.mjs";
import { redactSensitive } from "./sensitive-redactor.mjs";
import { readInstallManifest } from "./install-manifest.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { detectLegacyInstallations } from "./legacy-migration.mjs";
import { PROVIDERS, providerNeedsNoKey } from "./model-registry.mjs";
import { refuseUnsupportedPlatform } from "./platform-gate.mjs";
import {
  CALLER_SECRET_PATH,
  CONFIG_PATH,
  INTERNAL_SECRET_PATH,
  SOURCE_ROOT,
} from "./paths.mjs";
import { currentServiceTarget } from "./paths.mjs";
import {
  credentialPaths,
  credentialStatus,
} from "./provider-credentials.mjs";
import { providerSelectionStatus } from "./provider-selection.mjs";

function runJson(script, args = []) {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...args],
    { cwd: SOURCE_ROOT, env: process.env, encoding: "utf8" },
  );
  if (result.status !== 0) return { type: "child_command_failed", status: result.status ?? 1 };
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { type: "child_command_invalid_json" };
  }
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function fileMetadata(target) {
  if (!existsSync(target)) return { path: target, exists: false };
  const metadata = statSync(target);
  return {
    path: target,
    exists: true,
    size: metadata.size,
    mode: (metadata.mode & 0o777).toString(8),
    modifiedAt: metadata.mtime.toISOString(),
  };
}

function redactLogs(contents) {
  // Log lines can contain arbitrary prompt and provider-response text without
  // a key name. Preserve only the fact that a tail existed rather than making
  // a best-effort decision about whether it is safe to disclose.
  if (!contents) return "";
  return redactSensitive(contents, { sensitive: true });
}

function logTail(logPath) {
  if (!existsSync(logPath)) return null;
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/);
  return redactLogs(lines.slice(-200).join("\n"));
}

function knownLocalSecrets() {
  const values = new Set();
  const files = [CALLER_SECRET_PATH, INTERNAL_SECRET_PATH];
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    // A keyless provider holds no secret, so there is nothing to collect and
    // nothing to redact for it.
    if (providerNeedsNoKey(provider)) continue;
    files.push(...credentialPaths(provider));
    for (const name of provider.credential.environment) {
      const value = process.env[name]?.trim();
      if (value) values.add(value);
    }
  }
  for (const target of files) {
    if (!existsSync(target)) continue;
    const value = readFileSync(target, "utf8").trim();
    if (value) values.add(value);
  }
  return [...values].filter((value) => value.length >= 8);
}

function redactBundle(bundle) {
  let redacted = JSON.stringify(redactSensitive(bundle, { profile: "support-bundle" }), null, 2);
  redacted = redactCallerUrl(redacted);
  for (const secret of knownLocalSecrets()) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function outputOption() {
  const index = process.argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
  return value;
}

export function createSupportBundle(options = {}) {
  const serviceTarget = options.serviceTarget || currentServiceTarget();
  const supportRoot = options.supportRoot || serviceTarget.supportRoot;
  const logPath = options.logPath || serviceTarget.logPath;
  let configuredProviderCount = 0;
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    const status = credentialStatus(provider);
    if (status.configured) configuredProviderCount += 1;
  }
  let selection;
  try {
    selection = providerSelectionStatus();
  } catch (error) {
    selection = { type: "selection_status_unavailable" };
  }
  const packageJson = JSON.parse(readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"));
  const bundle = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    privacy: options.includeLogs
      ? "Includes only a redacted log-tail marker; log content is excluded."
      : "Credential values, prompts, response bodies, and log contents are excluded.",
    runtime: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      packageVersion: packageJson.version,
      gitCommit: commandVersion("git", ["-C", SOURCE_ROOT, "rev-parse", "HEAD"]),
    },
    doctor: runJson("doctor.mjs", ["--json"]),
    config: runJson("config-manager.mjs", ["status"]),
    service: runJson("service.mjs", ["status"]),
    selection,
    configuredProviderCount,
    installed: Boolean(readInstallManifest()),
    files: {
      configExists: fileMetadata(CONFIG_PATH).exists,
      logExists: fileMetadata(logPath).exists,
    },
    ...(options.includeLogs ? { redactedLogTail: logTail(logPath) } : {}),
  };

  mkdirSync(supportRoot, { recursive: true, mode: 0o700 });
  chmodSync(supportRoot, 0o700);
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const target = path.resolve(
    options.output || path.join(supportRoot, `codex-router-support-${timestamp}.json`),
  );
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const serialized = `${redactBundle(bundle)}\n`;
  writeFileSync(target, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(target);
  return { path: target, includedLogs: Boolean(options.includeLogs) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes("--help") && refuseUnsupportedPlatform("support-bundle")) process.exit(2);
    const known = new Set(["--help", "--include-logs", "--output"]);
    for (let index = 2; index < process.argv.length; index += 1) {
      const argument = process.argv[index];
      if (!known.has(argument)) throw new Error("Unknown option.");
      if (argument === "--output") index += 1;
    }
    if (process.argv.includes("--help")) {
      process.stdout.write(`Usage: support-bundle [--include-logs] [--output PATH]

Creates a mode-600 JSON diagnostic bundle without credential values.
Logs are excluded by default because they may contain prompts or responses.
`);
    } else {
      const result = createSupportBundle({
        includeLogs: process.argv.includes("--include-logs"),
        output: outputOption(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    console.error("Support bundle failed.");
    process.exitCode = 1;
  }
}
