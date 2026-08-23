// One command table for every surface that drives apps/desktop/ui: the Tauri
// tray, the Electron shell, and the router's own browser panel. Each call is a
// single shell-out to the control CLI, so a shell is only a window and an IPC
// hop -- not a second implementation of what the companion does. Duplicating
// this table is how the surfaces would drift apart, so they all import it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_ARGUMENTS,
  CAPABILITY_COMMANDS,
  CAPABILITY_SCHEMA_VERSION,
  isMutationCommand,
} from "./capability-manifest.mjs";
import { ERROR_DEFINITIONS } from "./public-error.mjs";

const CONTROL_TIMEOUT_MS = 120_000;
const CATALOG_MUTATION_TIMEOUT_MS = 330_000;

const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function sourceRoot(env = process.env, here = SELF_ROOT) {
  if (env.MODEL_ROUTER_SOURCE_ROOT) return env.MODEL_ROUTER_SOURCE_ROOT;
  for (const guess of [here, path.resolve(here, "..", "..")]) {
    if (existsSync(path.join(guess, "src", "control.mjs"))) return guess;
  }
  return undefined;
}

// process.execPath is the Electron binary inside the main process, not Node,
// so using it launches a second Electron to run a Node script -- which fails
// with a sandbox error rather than anything that names the real cause. Prefer
// the system Node the router is tested against; fall back to Electron's own
// bundled Node, which is what ELECTRON_RUN_AS_NODE selects.
export function nodeRuntime({ env = process.env, execPath = process.execPath } = {}) {
  const onPath = which("node", env);
  if (onPath) return { command: onPath, env };
  if (process.versions.electron) {
    return { command: execPath, env: { ...env, ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { command: execPath, env };
}

function which(name, env) {
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const directory of String(env.PATH || "").split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function runControl(
  root,
  args,
  { stdin, runtime = nodeRuntime(), timeoutMs = CONTROL_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    if (!root) {
      reject(new Error("Model Router was not found. Set MODEL_ROUTER_SOURCE_ROOT."));
      return;
    }
    const child = execFile(
      runtime.command,
      [path.join(root, "src", "control.mjs"), ...args],
      {
        cwd: root,
        env: runtime.env,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message).trim() || "The router command failed.";
          const failure = new Error(message);
          const code = Object.keys(ERROR_DEFINITIONS).find((candidate) =>
            new RegExp(`(?:^|[^A-Za-z0-9_.-])${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_.-])`).test(message)
          );
          if (code) failure.code = code;
          reject(failure);
          return;
        }
        resolve(stdout);
      },
    );
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    }
  });
}

export function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("Model Router returned an unreadable response.");
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const CONTROL_ARGS = {
  "lifecycle.status": () => ["--json"], "lifecycle.start": () => ["service", "start"], "lifecycle.stop": () => ["service", "stop"], "lifecycle.restart": () => ["service", "restart"], "lifecycle.logs": () => ["logs"],
  "doctor.status": () => ["doctor", "--json"], "doctor.fix": () => ["doctor", "--fix", "--json"], "maintenance.update": () => ["maintenance"], "maintenance.rollback": () => ["rollback"],
  "native.status": () => ["native-status", "--json"], "native.account-usage": () => ["account", "--json"],
  "credential.status": ({ provider: id }) => ["credential-status", id], "credential.set": ({ provider: id }) => ["credential", id], "credential.remove": ({ provider: id }) => ["credential", id, "--remove"],
  "provider.enable": ({ provider: id, enabled }) => ["set-apply", id, enabled ? "on" : "off", "--targets", "codex", "--activate"],
  "model.visibility": ({ slug: id, visible }) => ["picker", "set", id, visible ? "show" : "hide"], "model.canary": ({ slug: id, enabled }) => ["model-canary", id, enabled ? "on" : "off"],
  "protocol-proof.status": ({ slug: id }) => ["protocol-proof", "status", id], "protocol-proof.verify": ({ slug: id }) => ["protocol-proof", "verify", id, "--yes"], "protocol-proof.revoke": ({ slug: id }) => ["protocol-proof", "revoke", id],
  "picker.status": () => ["picker", "status"], "picker.set": ({ slug: id, visible }) => ["picker", "set", id, visible ? "show" : "hide"], "picker.show-all": ({ visible }) => ["picker", "all", visible ? "show" : "hide"],
  "catalog.status": () => ["catalog", "status"], "catalog.render-snippet": () => ["catalog", "render-snippet"],
  "subagents.status": () => ["subagents", "status"], "subagents.mode": ({ mode }) => ["subagents", "mode", mode], "subagents.model": ({ slug: id, enabled }) => ["subagents", "set", id, enabled ? "on" : "off"], "subagents.selection": ({ selection }) => ["subagents", selection], "subagents.verify": ({ slug: id }) => ["subagents", "verify", id],
  "failover.status": () => ["failover", "status"], "failover.reset": () => ["failover", "reset"],
  "tool-result-aging.status": () => ["tool-result-aging", "status"], "tool-result-aging.on": () => ["tool-result-aging", "on"], "tool-result-aging.off": () => ["tool-result-aging", "off"], "tool-result-aging.ttl": ({ days }) => ["tool-result-aging", "ttl", days == null ? "off" : String(days)], "tool-result-aging.purge": ({ expiredOnly }) => ["tool-result-aging", "purge", ...(expiredOnly ? ["--expired"] : []), "--yes"],
  "usage.router": () => ["usage", "router"], "usage.provider": ({ provider: id }) => ["provider-usage", ...(id ? [id] : [])], "usage.model": ({ slug: id }) => ["usage", "model", id],
  "vision.status": () => ["vision-bridge", "status"], "vision.on": () => ["vision-bridge", "on"], "vision.off": () => ["vision-bridge", "off"], "vision.engine": ({ engine, effort }) => ["vision-bridge", "engine", engine, ...(effort ? [effort] : [])], "vision.effort": ({ effort }) => ["vision-bridge", "effort", effort], "vision.probe": () => ["vision-bridge", "probe"], "vision.pull": ({ tag }) => ["vision-bridge", "pull", tag], "vision.purge-cache": () => ["vision-purge-cache"],
  "presence.status": () => ["presence", "status"], "presence.mode": ({ mode }) => ["presence", "set", mode], "cc-switch.status": () => ["catalog", "status"], "cc-switch.snippet": () => ["catalog", "render-snippet"],
};

const secretKey = /(?:credential|caller.?key|access.?token|api.?key|token|secret|password|authorization|auth)$/i;
const DANGEROUS_KEY = /^(?:__proto__|constructor|prototype)$/;
const CAPABILITY_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/_codex-router\/[^/\s]+(?:\/v1)?/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const MAX_ARGUMENT_DEPTH = 16;
const MAX_ARGUMENT_KEYS = 256;
const MAX_ARGUMENT_WORK = 4096;
const MAX_RESULT_DEPTH = 16;
const MAX_RESULT_KEYS = 256;
const MAX_RESULT_ARRAY = 1024;
const MAX_RESULT_NODES = 4096;
const MAX_RESULT_STRING = 64 * 1024;
const DEFAULT_RESULT_LIMITS = Object.freeze({
  maxDepth: MAX_RESULT_DEPTH,
  maxKeys: MAX_RESULT_KEYS,
  maxArray: MAX_RESULT_ARRAY,
  maxNodes: MAX_RESULT_NODES,
  maxString: MAX_RESULT_STRING,
});
// lifecycle.status is the one UI result that intentionally carries several
// bounded documents at once. Each document gets its own larger budget so a
// verbose target probe cannot consume the keys needed for presence and the
// complete capability manifest. The projection remains closed and every
// scalar/object still passes through the same secret scrubber.
const LIFECYCLE_RESULT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxKeys: 32 * 1024,
  maxArray: 4096,
  maxNodes: 128 * 1024,
  maxString: 128 * 1024,
});
const COMMAND_ERROR_CODES = Object.freeze({
  command_not_supported: true,
  invalid_command_arguments: true,
  protected_input_required: true,
  capability_schema_unsupported: true,
  protected_output_required: true,
});
const PROTECTED_CHANNEL = Symbol("trusted-desktop-protected-channel");
export function trustedProtectedContext(context = {}) {
  return Object.freeze({ ...context, protectedChannel: PROTECTED_CHANNEL });
}
function errorEnvelope(code) {
  const messages = {
    command_not_supported: "This desktop command is not supported.",
    invalid_command_arguments: "The desktop command arguments are invalid.",
    protected_input_required: "This credential operation requires protected input.",
    capability_schema_unsupported: "This capability schema is not supported for mutations.",
    protected_output_required: "This command requires an authorized protected output channel.",
  };
  const safeCode = Object.hasOwn(messages, code) || Object.hasOwn(ERROR_DEFINITIONS, code) ? code : "invalid_command_arguments";
  return {
    ok: false,
    error: {
      type: "router_error",
      code: safeCode,
      message: messages[safeCode] || ERROR_DEFINITIONS[safeCode]?.message,
      param: null,
    },
  };
}

function validate(schema, value, state = { seen: new WeakSet(), work: MAX_ARGUMENT_WORK }, depth = 0) {
  if (state.work-- <= 0 || depth > MAX_ARGUMENT_DEPTH || !value || typeof value !== "object" || Array.isArray(value) || util.types.isProxy(value) || schema.type !== "object") return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  if (state.seen.has(value)) return false;
  state.seen.add(value);
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > MAX_ARGUMENT_KEYS || schema.additionalProperties === false && keys.some((key) => !Object.hasOwn(schema.properties, key))) return false;
  if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
    const rule = schema.properties?.[key];
    if (!rule) continue;
    const item = descriptor.value;
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const validType = types.some((type) => type === "null" ? item === null : type === "integer" ? Number.isSafeInteger(item) : typeof item === type);
    if (!validType || rule.pattern && (typeof item !== "string" || !new RegExp(rule.pattern).test(item)) || rule.enum && !rule.enum.includes(item) || rule.minimum !== undefined && item !== null && (typeof item !== "number" || item < rule.minimum) || rule.maximum !== undefined && item !== null && (typeof item !== "number" || item > rule.maximum)) return false;
    if (item && typeof item === "object" && !validate({ type: "object", additionalProperties: true, properties: {} }, item, state, depth + 1)) return false;
  }
  return true;
}

const COMMAND_DEFINITIONS_MAP = new Map(CAPABILITY_COMMANDS.map((metadata) => {
  const args = CAPABILITY_ARGUMENTS[metadata.name] || { type: "object", additionalProperties: false, properties: {}, required: [] };
  return [metadata.name, deepFreeze({
    ...metadata,
    arguments: args,
    execute: CONTROL_ARGS[metadata.name],
  })];
}));

const COMMAND_DEFINITIONS = (() => {
  const entries = Object.freeze([...COMMAND_DEFINITIONS_MAP.entries()].map(([name, value]) => Object.freeze([name, value])));
  const values = Object.freeze(entries.map(([, value]) => value));
  const byName = new Map(entries);
  return Object.freeze({
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    set() { throw new TypeError("desktop command definitions are read-only"); },
    delete() { throw new TypeError("desktop command definitions are read-only"); },
    clear() { throw new TypeError("desktop command definitions are read-only"); },
    keys: function* keys() { for (const [name] of entries) yield name; },
    values: function* valuesIterator() { yield* values; },
    entries: function* entriesIterator() { yield* entries; },
    forEach(callback, thisArg) { for (const [name, value] of entries) callback.call(thisArg, value, name, COMMAND_DEFINITIONS); },
    get size() { return entries.length; },
    [Symbol.iterator]: function* iterator() { yield* entries; },
  });
})();

export function desktopCommandDefinitions() {
  return COMMAND_DEFINITIONS;
}

function majorVersion(manifest, supplied = false) {
  if (!supplied) return CAPABILITY_SCHEMA_VERSION;
  if (!manifest || typeof manifest !== "object" || util.types.isProxy(manifest)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(manifest, "capabilitySchemaVersion");
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function scrubResult(value, sensitiveValues = [], state = { seen: new WeakSet(), nodes: 0, keys: 0 }, depth = 0, limits = DEFAULT_RESULT_LIMITS) {
  if (depth > limits.maxDepth || state.nodes++ >= limits.maxNodes) return undefined;
  if (typeof value === "string") {
    if (value.length > limits.maxString) return undefined;
    let clean = value.replace(CAPABILITY_URL, "[REDACTED]").replace(BEARER, "Bearer [REDACTED]");
    for (const sensitive of sensitiveValues) if (sensitive) clean = clean.split(sensitive).join("[REDACTED]");
    return clean;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!value || typeof value !== "object" || util.types.isProxy(value) || state.seen.has(value)) return undefined;
  state.seen.add(value);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length > limits.maxArray) return undefined;
    return Array.from({ length }, (_, index) => scrubResult(Object.getOwnPropertyDescriptor(value, String(index))?.value, sensitiveValues, state, depth + 1, limits));
  }
  const output = Object.create(null);
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > limits.maxKeys || state.keys + keys.length > limits.maxKeys) return undefined;
  state.keys += keys.length;
  for (const key of keys) {
    if (secretKey.test(key) || DANGEROUS_KEY.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const item = scrubResult(descriptor.value, sensitiveValues, state, depth + 1, limits);
    if (item !== undefined) Object.defineProperty(output, key, { value: item, enumerable: true, writable: false, configurable: false });
  }
  return deepFreeze(output);
}

function scrubLifecycleStatus(value, sensitiveValues = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || util.types.isProxy(value)) return scrubResult(value, sensitiveValues);
  const output = Object.create(null);
  for (const key of ["targets", "service", "presence", "harness", "capabilities", "health", "version", "state", "activity"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const item = scrubResult(descriptor.value, sensitiveValues, undefined, 0, LIFECYCLE_RESULT_LIMITS);
    if (item !== undefined) Object.defineProperty(output, key, { value: item, enumerable: true, writable: false, configurable: false });
  }
  if (!Object.hasOwn(output, "health")) {
    Object.defineProperty(output, "health", { value: "available", enumerable: true, writable: false, configurable: false });
  }
  if (!Object.hasOwn(output, "version")) {
    const capabilities = Object.getOwnPropertyDescriptor(value, "capabilities")?.value;
    const schema = capabilities && typeof capabilities === "object"
      ? Object.getOwnPropertyDescriptor(capabilities, "capabilitySchemaVersion")?.value
      : undefined;
    const version = Number.isSafeInteger(schema) ? `capability-schema-${schema}` : "unknown";
    Object.defineProperty(output, "version", { value: version, enumerable: true, writable: false, configurable: false });
  }
  return deepFreeze(output);
}

function scrubProtectedText(value) {
  if (typeof value !== "string" || value.length > MAX_RESULT_STRING) return undefined;
  return value;
}

function safeErrorCode(error) {
  if (!error || typeof error !== "object" || util.types.isProxy(error)) return undefined;
  const codeDescriptor = Object.getOwnPropertyDescriptor(error, "code");
  if (codeDescriptor && Object.hasOwn(codeDescriptor, "value") && typeof codeDescriptor.value === "string") return codeDescriptor.value;
  const bodyDescriptor = Object.getOwnPropertyDescriptor(error, "body");
  if (!bodyDescriptor || !Object.hasOwn(bodyDescriptor, "value")) return undefined;
  const body = bodyDescriptor.value;
  if (!body || typeof body !== "object" || util.types.isProxy(body)) return undefined;
  const errorDescriptor = Object.getOwnPropertyDescriptor(body, "error");
  if (!errorDescriptor || !Object.hasOwn(errorDescriptor, "value")) return undefined;
  const nested = errorDescriptor.value;
  if (!nested || typeof nested !== "object" || util.types.isProxy(nested)) return undefined;
  const nestedCode = Object.getOwnPropertyDescriptor(nested, "code");
  return nestedCode && Object.hasOwn(nestedCode, "value") && typeof nestedCode.value === "string" ? nestedCode.value : undefined;
}

/** Run one canonical Node command. The protected input callback is ephemeral. */
export async function runDesktopCommand(command, args = {}, context = {}) {
  if (!COMMAND_DEFINITIONS.has(command)) {
    return errorEnvelope("command_not_supported");
  }
  const definition = COMMAND_DEFINITIONS.get(command);
  const contextIsPlain = context && typeof context === "object" && !util.types.isProxy(context);
  const contextManifest = contextIsPlain
    ? Object.getOwnPropertyDescriptor(context, "manifest")
    : undefined;
  const suppliedManifest = Boolean(contextManifest);
  const manifest = contextManifest && Object.hasOwn(contextManifest, "value") ? contextManifest.value : undefined;
  const version = majorVersion(manifest, suppliedManifest);
  if (version !== CAPABILITY_SCHEMA_VERSION && isMutationCommand(command)) return errorEnvelope("capability_schema_unsupported");
  const safeContext = contextIsPlain ? context : {};
  let protectedValue;
  try {
    if (definition.protectedInput && Object.getOwnPropertyNames(args || {}).some((key) => secretKey.test(key))) return errorEnvelope("protected_input_required");
    if (!validate(definition.arguments, args)) return errorEnvelope("invalid_command_arguments");
    if (definition.protectedInput) {
      const inputDescriptor = Object.getOwnPropertyDescriptor(safeContext, "protectedInput");
      const input = inputDescriptor && Object.hasOwn(inputDescriptor, "value") ? inputDescriptor.value : undefined;
      protectedValue = typeof input === "function" ? await input() : input;
      if (typeof protectedValue !== "string" || !protectedValue) return errorEnvelope("protected_input_required");
    }
    const protectedChannelDescriptor = Object.getOwnPropertyDescriptor(safeContext, "protectedChannel");
    const protectedChannel = protectedChannelDescriptor && Object.hasOwn(protectedChannelDescriptor, "value") && protectedChannelDescriptor.value === PROTECTED_CHANNEL;
    if (definition.resultKind === "protected-text" && !protectedChannel) return errorEnvelope("protected_output_required");
    let value;
    const executeDescriptor = Object.getOwnPropertyDescriptor(safeContext, "execute");
    const execute = executeDescriptor && Object.hasOwn(executeDescriptor, "value") ? executeDescriptor.value : undefined;
    if (typeof execute === "function") value = await execute(command, { ...args }, protectedValue);
    else {
      const plan = definition.execute?.(args);
      if (!plan) return errorEnvelope("command_not_supported");
      const runnerDescriptor = Object.getOwnPropertyDescriptor(safeContext, "runControl");
      const controlRunner = runnerDescriptor && Object.hasOwn(runnerDescriptor, "value") && typeof runnerDescriptor.value === "function"
        ? runnerDescriptor.value
        : (root, argv, options) => runControl(root, argv, options);
      const rootDescriptor = Object.getOwnPropertyDescriptor(safeContext, "root");
      const root = rootDescriptor && Object.hasOwn(rootDescriptor, "value") ? rootDescriptor.value : sourceRoot();
      value = await controlRunner(root, plan, {
        stdin: protectedValue,
        timeoutMs: definition.protectedInput ? CATALOG_MUTATION_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
      });
      value = definition.resultKind === "text" || definition.resultKind === "protected-text" ? String(value).trim() : value.trim() ? parseJson(value) : null;
    }
    if (definition.resultKind === "protected-text") {
      const protectedText = scrubProtectedText(value);
      if (protectedText === undefined) return errorEnvelope("invalid_command_arguments");
      return {
        ok: true,
        value: protectedText,
        meta: { protected: true, resultKind: "protected-text", cacheControl: "no-store" },
      };
    }
    const sensitiveValues = protectedValue ? [protectedValue] : [];
    const sanitized = definition.name === "lifecycle.status"
      ? scrubLifecycleStatus(value, sensitiveValues)
      : scrubResult(value, sensitiveValues);
    return { ok: true, value: sanitized };
  } catch (error) {
    const code = safeErrorCode(error);
    if (definition.protectedInput && protectedValue === undefined) return errorEnvelope("protected_input_required");
    if (code && (Object.hasOwn(ERROR_DEFINITIONS, code) || Object.hasOwn(COMMAND_ERROR_CODES, code)) && code !== "invalid_command_arguments" && code !== "command_not_supported") {
      return errorEnvelope(code);
    }
    return errorEnvelope("invalid_command_arguments");
  } finally {
    protectedValue = undefined;
  }
}
