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

// A command that mutates and then re-reads: the UI always wants the fresh
// snapshot, so the read is part of the call rather than a second round trip
// the renderer has to remember to make.
export const COMMANDS = {
  control_snapshot: () => ({ args: ["--json"] }),
  account_usage: () => ({ args: ["account", "--json"] }),
  provider_usage: () => ({ args: ["provider-usage", "--json"] }),
  provider_setup: () => ({ args: ["providers", "--json"] }),
  local_models: () => ({ args: ["local-models", "list", "--json"] }),
  local_model_speed: ({ model, tag }) => ({
    args: ["local-models", "benchmark", requireTag(model ?? tag)],
  }),
  update_local_ollama: () => ({ args: ["local-models", "runtime", "update", "--yes"] }),
  vision_bridge_status: () => ({ args: ["vision-bridge", "status"] }),
  vision_bridge_models: () => ({ args: ["vision-bridge", "models"] }),
  vision_bridge_probe: () => ({ args: ["vision-bridge", "probe"] }),
  set_vision_bridge: ({ enabled }) => ({
    args: ["vision-bridge", enabled ? "on" : "off"],
  }),
  set_vision_engine: ({ engine, effort }) => ({
    args: ["vision-bridge", "engine", String(engine || "auto"), ...(effort ? [String(effort)] : [])],
  }),
  set_vision_effort: ({ effort }) => ({ args: ["vision-bridge", "effort", String(effort || "default")] }),
  pull_vision_model: ({ model, tag }) => ({
    args: ["vision-bridge", "pull", requireTag(model ?? tag)],
  }),
  vision_pull_status: () => ({ args: ["vision-bridge", "pull-status"] }),
  benchmark_vision_model: ({ model, tag }) => ({
    args: ["vision-bridge", "benchmark", requireTag(model ?? tag)],
  }),
  use_local_vision_model: ({ model, tag }) => ({
    args: ["vision-bridge", "local", requireTag(model ?? tag)],
  }),
  install_local_model: ({ model, tag, force }) => ({
    args: [
      "local-models",
      "install",
      requireTag(model ?? tag),
      "--yes",
      ...(force ? ["--force"] : []),
    ],
  }),
  uninstall_local_model: ({ model, tag }) => ({
    args: ["local-models", "uninstall", requireTag(model ?? tag), "--yes", "--async"],
  }),
  cancel_local_model: ({ model, tag }) => ({
    args: ["local-models", "cancel", requireTag(model ?? tag)],
  }),
  set_local_model_enabled: ({ model, tag, enabled }) => ({
    args: ["local-models", "set", requireTag(model ?? tag), enabled ? "on" : "off"],
  }),
  set_lmstudio_model_enabled: ({ model, id, enabled }) => ({
    args: ["local-models", "lmstudio-set", requireTag(model ?? id), enabled ? "on" : "off"],
  }),
  install_provider_cli: ({ provider }) => ({ args: ["install-cli", requireProvider(provider)] }),
  connect_oauth: ({ provider }) => ({
    args: ["login", requireProvider(provider)],
    then: ["providers", "--json"],
  }),
  save_api_key: ({ provider, apiKey }) => {
    if (!String(apiKey ?? "").trim()) throw new Error("Enter a credential first.");
    if (String(apiKey).length > 16 * 1024) throw new Error("The credential is too large.");
    return {
      args: ["credential", requireProvider(provider)],
      stdin: String(apiKey),
      timeoutMs: CATALOG_MUTATION_TIMEOUT_MS,
      then: ["providers", "--json"],
    };
  },
  remove_api_key: ({ provider }) => ({
    args: ["credential", requireProvider(provider), "--remove"],
    timeoutMs: CATALOG_MUTATION_TIMEOUT_MS,
    then: ["providers", "--json"],
  }),
  set_provider_enabled: ({ provider, enabled }) => ({
    args: [
      "set-apply",
      requireProvider(provider),
      enabled ? "on" : "off",
      "--targets",
      "codex",
      "--activate",
    ],
    timeoutMs: CATALOG_MUTATION_TIMEOUT_MS,
    then: ["--json"],
  }),
  set_login_free: ({ enabled }) => ({
    args: ["auth-mode", enabled ? "on" : "off"],
    then: ["--json"],
  }),
  set_subagent_mode: ({ mode }) => ({ args: ["subagents", "mode", String(mode)] }),
  set_subagent_model: ({ slug, enabled }) => ({
    args: ["subagents", "set", String(slug), enabled ? "on" : "off"],
  }),
  set_subagent_provider: ({ provider, enabled }) => ({
    args: ["subagents", "provider", requireProvider(provider), enabled ? "on" : "off"],
  }),
  set_subagent_selection: ({ selection }) => ({ args: ["subagents", String(selection)] }),
  set_picker_model: ({ slug, visible }) => ({
    args: ["picker", "set", String(slug), visible ? "show" : "hide"],
  }),
  set_picker_provider: ({ provider, visible }) => ({
    args: ["picker", "provider", requireProvider(provider), visible ? "show" : "hide"],
  }),
  set_picker_models: ({ showAll }) => ({ args: ["picker", "all", showAll ? "show" : "hide"] }),
  set_tool_result_aging: ({ mode, enabled }) => ({
    args: ["tool-result-aging", (enabled ?? (mode === "on")) ? "on" : "off"],
  }),
  set_signed_routing: ({ enabled }) => ({
    args: ["signed-routing", enabled ? "on" : "off"],
    then: ["--json"],
  }),
  presence_status: () => ({ args: ["presence", "status"] }),
  set_presence_mode: ({ mode }) => ({ args: ["presence", "set", String(mode || "always")] }),
  service_start: () => ({ args: ["service", "start"] }),
  service_stop: () => ({ args: ["service", "stop"] }),
  maintenance: () => ({ args: ["maintenance"] }),
  doctor_fix: () => ({ args: ["doctor", "--fix", "--json"] }),
};

function requireProvider(provider) {
  const value = String(provider ?? "");
  // The renderer is local, but an id reaches a command line either way, so it
  // is constrained to the shape a provider id actually has.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) throw new Error(`Unknown provider: ${provider}`);
  return value;
}

function requireTag(tag) {
  const value = String(tag ?? "");
  if (!/^[A-Za-z0-9][\w.:\/-]{0,127}$/.test(value)) throw new Error(`Unknown model tag: ${tag}`);
  return value;
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
          reject(new Error(String(stderr || error.message).trim() || "The router command failed."));
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

const objectSchema = (properties = {}, required = []) => deepFreeze({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const string = (pattern = undefined) => deepFreeze({ type: "string", ...(pattern ? { pattern } : {}) });
const boolean = deepFreeze({ type: "boolean" });
const slug = string("^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$");
const provider = string("^[a-z0-9][a-z0-9-]{0,63}$");
const credentialProvider = { ...provider, enum: ["deepseek", "qwen-plan"] };
const noArgs = objectSchema();

const ARGUMENTS = {
  "lifecycle.status": noArgs, "lifecycle.start": noArgs, "lifecycle.stop": noArgs, "lifecycle.restart": noArgs, "lifecycle.logs": noArgs,
  "doctor.status": noArgs, "doctor.fix": noArgs, "maintenance.update": noArgs, "maintenance.rollback": noArgs,
  "native.status": noArgs, "native.account-usage": noArgs,
  "credential.status": objectSchema({ provider: credentialProvider }, ["provider"]),
  "credential.set": objectSchema({ provider: credentialProvider }, ["provider"]),
  "credential.remove": objectSchema({ provider: credentialProvider }, ["provider"]),
  "provider.enable": objectSchema({ provider, enabled: boolean }, ["provider", "enabled"]),
  "model.visibility": objectSchema({ slug, visible: boolean }, ["slug", "visible"]),
  "model.canary": objectSchema({ slug, enabled: boolean }, ["slug", "enabled"]),
  "protocol-proof.status": objectSchema({ slug }, ["slug"]),
  "protocol-proof.verify": objectSchema({ slug }, ["slug"]),
  "protocol-proof.revoke": objectSchema({ slug }, ["slug"]),
  "picker.status": noArgs, "picker.set": objectSchema({ slug, visible: boolean }, ["slug", "visible"]), "picker.show-all": objectSchema({ visible: boolean }, ["visible"]),
  "catalog.status": noArgs, "catalog.render-snippet": noArgs,
  "subagents.status": noArgs, "subagents.mode": objectSchema({ mode: string("^(all|selected|proven)$") }, ["mode"]),
  "subagents.model": objectSchema({ slug, enabled: boolean }, ["slug", "enabled"]),
  "subagents.selection": objectSchema({ selection: string("^(select-all|unselect-all)$") }, ["selection"]),
  "subagents.verify": objectSchema({ slug }, ["slug"]),
  "failover.status": noArgs, "failover.reset": noArgs,
  "tool-result-aging.status": noArgs, "tool-result-aging.on": noArgs, "tool-result-aging.off": noArgs,
  "tool-result-aging.ttl": objectSchema({ days: { type: ["integer", "null"] } }, ["days"]),
  "tool-result-aging.purge": objectSchema({ expiredOnly: boolean }, ["expiredOnly"]),
  "usage.router": noArgs, "usage.provider": objectSchema({ provider }, ["provider"]), "usage.model": objectSchema({ slug }, ["slug"]),
  "vision.status": noArgs, "vision.on": noArgs, "vision.off": noArgs,
  "vision.engine": objectSchema({ engine: string(), effort: string() }, ["engine"]),
  "vision.effort": objectSchema({ effort: string() }, ["effort"]), "vision.probe": noArgs,
  "vision.pull": objectSchema({ tag: string("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$") }, ["tag"]),
  "vision.purge-cache": noArgs,
  "presence.status": noArgs, "presence.mode": objectSchema({ mode: string("^(always|follow-codex|follow-clients)$") }, ["mode"]),
  "cc-switch.status": noArgs, "cc-switch.snippet": noArgs,
};

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
  "usage.router": () => ["usage", "router"], "usage.provider": ({ provider: id }) => ["provider-usage", id], "usage.model": ({ slug: id }) => ["usage", "model", id],
  "vision.status": () => ["vision-bridge", "status"], "vision.on": () => ["vision-bridge", "on"], "vision.off": () => ["vision-bridge", "off"], "vision.engine": ({ engine, effort }) => ["vision-bridge", "engine", engine, ...(effort ? [effort] : [])], "vision.effort": ({ effort }) => ["vision-bridge", "effort", effort], "vision.probe": () => ["vision-bridge", "probe"], "vision.pull": ({ tag }) => ["vision-bridge", "pull", tag], "vision.purge-cache": () => ["vision-purge-cache"],
  "presence.status": () => ["presence", "status"], "presence.mode": ({ mode }) => ["presence", "set", mode], "cc-switch.status": () => ["catalog", "status"], "cc-switch.snippet": () => ["catalog", "render-snippet"],
};

const secretKey = /^(?:credential|apiKey|api_key|token|secret|password|authorization)$/i;
const CAPABILITY_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/_codex-router\/[^/\s]+(?:\/v1)?/gi;
const MAX_ARGUMENT_DEPTH = 16;
const MAX_ARGUMENT_KEYS = 256;
const MAX_ARGUMENT_WORK = 4096;
const MAX_RESULT_DEPTH = 16;
const MAX_RESULT_KEYS = 256;
const MAX_RESULT_ARRAY = 1024;
const COMMAND_ERROR_CODES = Object.freeze({
  command_not_supported: true,
  invalid_command_arguments: true,
  protected_input_required: true,
  capability_schema_unsupported: true,
});
function errorEnvelope(code) {
  const messages = {
    command_not_supported: "This desktop command is not supported.",
    invalid_command_arguments: "The desktop command arguments are invalid.",
    protected_input_required: "This credential operation requires protected input.",
    capability_schema_unsupported: "This capability schema is not supported for mutations.",
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
    if (!validType || rule.pattern && (typeof item !== "string" || !new RegExp(rule.pattern).test(item)) || rule.enum && !rule.enum.includes(item)) return false;
    if (item && typeof item === "object" && !validate({ type: "object", additionalProperties: true, properties: {} }, item, state, depth + 1)) return false;
  }
  return true;
}

const COMMAND_DEFINITIONS_MAP = new Map(CAPABILITY_COMMANDS.map((metadata) => {
  const args = ARGUMENTS[metadata.name] || noArgs;
  return [metadata.name, deepFreeze({
    ...metadata,
    arguments: args,
    execute: CONTROL_ARGS[metadata.name],
  })];
}));

const COMMAND_DEFINITIONS = (() => {
  const entries = Object.freeze([...COMMAND_DEFINITIONS_MAP.entries()]);
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

function scrubResult(value, sensitiveValues = [], state = { seen: new WeakSet() }, depth = 0) {
  if (depth > MAX_RESULT_DEPTH) return undefined;
  if (typeof value === "string") {
    let clean = value.replace(CAPABILITY_URL, "[REDACTED]");
    for (const sensitive of sensitiveValues) if (sensitive) clean = clean.split(sensitive).join("[REDACTED]");
    return clean;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!value || typeof value !== "object" || util.types.isProxy(value) || state.seen.has(value)) return undefined;
  state.seen.add(value);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length > MAX_RESULT_ARRAY) return undefined;
    return Array.from({ length }, (_, index) => scrubResult(Object.getOwnPropertyDescriptor(value, String(index))?.value, sensitiveValues, state, depth + 1));
  }
  const output = {};
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > MAX_RESULT_KEYS) return undefined;
  for (const key of keys) {
    if (secretKey.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const item = scrubResult(descriptor.value, sensitiveValues, state, depth + 1);
    if (item !== undefined) output[key] = item;
  }
  return deepFreeze(output);
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
      value = definition.resultKind === "text" ? String(value).trim() : value.trim() ? parseJson(value) : null;
    }
    return { ok: true, value: scrubResult(value, protectedValue ? [protectedValue] : []) };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : error?.body?.error?.code;
    if (definition.protectedInput && protectedValue === undefined) return errorEnvelope("protected_input_required");
    if (code && (Object.hasOwn(ERROR_DEFINITIONS, code) || Object.hasOwn(COMMAND_ERROR_CODES, code)) && code !== "invalid_command_arguments" && code !== "command_not_supported") {
      return errorEnvelope(code);
    }
    return errorEnvelope("invalid_command_arguments");
  } finally {
    protectedValue = undefined;
  }
}
