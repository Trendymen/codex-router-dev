import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isValidatedServiceTarget,
  PRODUCTION_SERVICE_TARGET,
  resolveServiceTarget,
  validatePathWithin,
  validatedIsolationRoot,
} from "./service-target.mjs";

export const TRAY_FIXTURE_CONTEXT_VERSION = 1;
const FIXTURE_MODES = new Set(["acceptance", "test"]);
const TOOL_NAMES = Object.freeze(["uname", "swift", "codesign", "plistBuddy"]);
const TARGET_PATH_NAMES = Object.freeze([
  "sourceRoot",
  "appPath",
  "appBinary",
  "launchAgentsDir",
  "routerPlistPath",
  "trayPlistPath",
  "stateRoot",
  "supportRoot",
  "logPath",
]);
const TARGET_SCALAR_NAMES = Object.freeze([
  "mode",
  "platform",
  "launchDomain",
  "routerLabel",
  "trayLabel",
  "host",
]);
const TARGET_PORT_NAMES = Object.freeze(["oauth", "router", "api", "grokOauth", "devinCli"]);

function absolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
}

function insideOrEqual(root, value, name) {
  const normalizedRoot = absolute(root, "isolationRoot");
  const normalizedValue = absolute(value, name);
  const relative = path.relative(normalizedRoot, normalizedValue);
  if (relative === "" || relative === ".") return normalizedValue;
  validatePathWithin(normalizedRoot, normalizedValue, name);
  return normalizedValue;
}

function requiredToolPaths(isolationRoot, tools) {
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) {
    throw new Error("Tray fixture context requires explicit mock tool paths.");
  }
  const result = {};
  for (const name of TOOL_NAMES) {
    result[name] = validatePathWithin(isolationRoot, absolute(tools[name], `tools.${name}`), `tools.${name}`);
  }
  return Object.freeze(result);
}

function targetSnapshot(target) {
  const snapshot = {};
  for (const name of TARGET_SCALAR_NAMES) snapshot[name] = target[name];
  for (const name of TARGET_PATH_NAMES) snapshot[name] = target[name];
  snapshot.ports = Object.fromEntries(TARGET_PORT_NAMES.map((name) => [name, target.ports[name]]));
  return snapshot;
}

function targetForContext(raw, isolationRoot) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Tray fixture context target must be an object.");
  }
  const target = resolveServiceTarget(
    { ...raw, isolationRoot },
    { ...PRODUCTION_SERVICE_TARGET, production: PRODUCTION_SERVICE_TARGET },
  );
  if (!FIXTURE_MODES.has(target.mode)) {
    throw new Error("Tray fixture context requires acceptance or test mode.");
  }
  if (target.sourceRoot !== insideOrEqual(isolationRoot, target.sourceRoot, "target.sourceRoot")) {
    throw new Error("target.sourceRoot must remain inside the isolationRoot.");
  }
  for (const name of ["appPath", "appBinary"]) {
    validatePathWithin(isolationRoot, target[name], `target.${name}`);
  }
  validatePathWithin(target.appPath, target.appBinary, "target.appBinary");
  return target;
}

function contextObject(target, { tools, buildOnly = true, dryRun = false, configuration = "release" } = {}) {
  if (!isValidatedServiceTarget(target)) {
    throw new Error("Tray fixture context requires a target returned by resolveServiceTarget.");
  }
  if (!FIXTURE_MODES.has(target.mode)) {
    throw new Error("Tray fixture context requires acceptance or test mode.");
  }
  if (buildOnly !== true) {
    throw new Error("Tray fixture context must be build-only.");
  }
  const isolationRoot = validatedIsolationRoot(target);
  if (!isolationRoot) throw new Error("Tray fixture context requires a validated isolationRoot.");
  if (!["debug", "release"].includes(configuration)) {
    throw new Error("Tray fixture configuration must be debug or release.");
  }
  const normalizedRoot = absolute(isolationRoot, "isolationRoot");
  const snapshot = targetSnapshot(target);
  snapshot.sourceRoot = insideOrEqual(normalizedRoot, snapshot.sourceRoot, "target.sourceRoot");
  for (const name of ["appPath", "appBinary"]) {
    snapshot[name] = validatePathWithin(normalizedRoot, snapshot[name], `target.${name}`);
  }
  validatePathWithin(snapshot.appPath, snapshot.appBinary, "target.appBinary");
  return Object.freeze({
    schemaVersion: TRAY_FIXTURE_CONTEXT_VERSION,
    mode: target.mode,
    isolationRoot: normalizedRoot,
    target: Object.freeze(snapshot),
    tools: requiredToolPaths(normalizedRoot, tools),
    buildOnly: true,
    dryRun: Boolean(dryRun),
    configuration,
  });
}

export function createTrayFixtureContext(target, options) {
  return contextObject(target, options);
}

export function writeTrayFixtureContext(file, target, options) {
  const context = options?.schemaVersion ? options : contextObject(target, options);
  const destination = absolute(file, "fixture context");
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  return context;
}

function parseContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tray fixture context must be a JSON object.");
  }
  if (value.schemaVersion !== TRAY_FIXTURE_CONTEXT_VERSION) {
    throw new Error("Unsupported Tray fixture context version.");
  }
  const isolationRoot = absolute(value.isolationRoot, "isolationRoot");
  const target = targetForContext(value.target, isolationRoot);
  const tools = requiredToolPaths(isolationRoot, value.tools);
  const configuration = value.configuration || "release";
  if (!["debug", "release"].includes(configuration)) {
    throw new Error("Tray fixture configuration must be debug or release.");
  }
  if (value.buildOnly !== true || typeof value.dryRun !== "boolean") {
    throw new Error("Tray fixture context must be build-only and use a boolean dry-run flag.");
  }
  return Object.freeze({
    schemaVersion: TRAY_FIXTURE_CONTEXT_VERSION,
    mode: target.mode,
    isolationRoot,
    target: Object.freeze(targetSnapshot(target)),
    tools,
    buildOnly: true,
    dryRun: value.dryRun,
    configuration,
  });
}

export function readTrayFixtureContext(file) {
  const source = absolute(file, "fixture context");
  return parseContext(JSON.parse(readFileSync(source, "utf8")));
}

export function validateTrayFixtureOutput(context, output) {
  const normalizedOutput = absolute(output, "tray output");
  validatePathWithin(context.isolationRoot, normalizedOutput, "tray output");
  return normalizedOutput;
}

export function productionTrayTarget() {
  return resolveServiceTarget({ mode: "production" }, PRODUCTION_SERVICE_TARGET);
}

function fieldValue(context, field) {
  const values = {
    mode: context.mode,
    isolationRoot: context.isolationRoot,
    sourceRoot: context.target.sourceRoot,
    appPath: context.target.appPath,
    appBinary: context.target.appBinary,
    trayLabel: context.target.trayLabel,
    routerLabel: context.target.routerLabel,
    launchDomain: context.target.launchDomain,
    buildOnly: context.buildOnly ? "1" : "0",
    dryRun: context.dryRun ? "1" : "0",
    configuration: context.configuration,
  };
  if (field.startsWith("tools.")) values[field] = context.tools[field.slice("tools.".length)];
  if (!(field in values)) throw new Error(`Unknown Tray fixture field: ${field}.`);
  return String(values[field]);
}

async function cli() {
  const args = process.argv.slice(2);
  if (args[0] === "--production-field" && args.length === 2) {
    const target = productionTrayTarget();
    const field = args[1];
    if (!(field in target)) throw new Error(`Unknown production Tray field: ${field}.`);
    process.stdout.write(String(target[field]));
    return;
  }
  if (args[0] === "--fixture-field" && args.length === 3) {
    process.stdout.write(fieldValue(readTrayFixtureContext(args[1]), args[2]));
    return;
  }
  if (args[0] === "--fixture-validate-output" && args.length === 3) {
    const context = readTrayFixtureContext(args[1]);
    process.stdout.write(validateTrayFixtureOutput(context, args[2]));
    return;
  }
  if (args[0] === "--production-validate-output" && args.length === 3) {
    const parent = absolute(args[1], "production app parent");
    process.stdout.write(validatePathWithin(parent, absolute(args[2], "tray output"), "tray output"));
    return;
  }
  throw new Error("Usage: tray-build-plan --production-field FIELD | --fixture-field FILE FIELD | --fixture-validate-output FILE PATH | --production-validate-output PARENT PATH");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
