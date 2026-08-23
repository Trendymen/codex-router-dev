// One command table for every surface that drives apps/desktop/ui: the Tauri
// tray, the Electron shell, and the router's own browser panel. Each call is a
// single shell-out to the control CLI, so a shell is only a window and an IPC
// hop -- not a second implementation of what the companion does. Duplicating
// this table is how the surfaces would drift apart, so they all import it.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
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

// Runs a command from the table end to end. Every surface calls this rather
// than sequencing runControl itself, so "mutate, then re-read so the caller
// paints fresh state" cannot be implemented three slightly different ways.
async function runLegacyDesktopCommand(command, args = {}, { root = sourceRoot() } = {}) {
  const build = COMMANDS[command];
  if (!build) throw new Error(`Unknown command: ${command}`);
  const plan = build(args ?? {});
  const output = await runControl(root, plan.args, {
    stdin: plan.stdin,
    timeoutMs: plan.timeoutMs,
  });
  if (plan.then) return parseJson(await runControl(root, plan.then));
  return output.trim() ? parseJson(output) : null;
}

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const string = (pattern = undefined) => ({ type: "string", ...(pattern ? { pattern } : {}) });
const boolean = { type: "boolean" };
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
  "lifecycle.status": () => ["service", "status"], "lifecycle.start": () => ["service", "start"], "lifecycle.stop": () => ["service", "stop"], "lifecycle.restart": () => ["service", "restart"], "lifecycle.logs": () => ["logs"],
  "doctor.status": () => ["doctor", "--json"], "doctor.fix": () => ["doctor", "--fix", "--json"], "maintenance.update": () => ["maintenance"], "maintenance.rollback": () => ["rollback"],
  "native.status": () => ["native-status", "--json"], "native.account-usage": () => ["account", "--json"],
  "credential.status": ({ provider: id }) => ["providers", "--json", id], "credential.set": ({ provider: id }) => ["credential", id], "credential.remove": ({ provider: id }) => ["credential", id, "--remove"],
  "provider.enable": ({ provider: id, enabled }) => ["set-apply", id, enabled ? "on" : "off", "--targets", "codex", "--activate"],
  "model.visibility": ({ slug: id, visible }) => ["picker", "set", id, visible ? "show" : "hide"], "model.canary": ({ slug: id, enabled }) => ["model-canary", id, enabled ? "on" : "off"],
  "protocol-proof.status": ({ slug: id }) => ["protocol-proof", "status", id], "protocol-proof.verify": ({ slug: id }) => ["protocol-proof", "verify", id, "--yes"], "protocol-proof.revoke": ({ slug: id }) => ["protocol-proof", "revoke", id],
  "picker.status": () => ["picker", "status"], "picker.set": ({ slug: id, visible }) => ["picker", "set", id, visible ? "show" : "hide"], "picker.show-all": ({ visible }) => ["picker", "all", visible ? "show" : "hide"],
  "catalog.status": () => ["catalog", "status"], "catalog.render-snippet": () => ["catalog", "render-snippet"],
  "subagents.status": () => ["subagents", "status"], "subagents.mode": ({ mode }) => ["subagents", "mode", mode], "subagents.model": ({ slug: id, enabled }) => ["subagents", "set", id, enabled ? "on" : "off"], "subagents.selection": ({ selection }) => ["subagents", selection], "subagents.verify": ({ slug: id }) => ["subagents", "verify", id, "--yes"],
  "failover.status": () => ["failover", "status"], "failover.reset": () => ["failover", "reset", "--yes"],
  "tool-result-aging.status": () => ["tool-result-aging", "status"], "tool-result-aging.on": () => ["tool-result-aging", "on"], "tool-result-aging.off": () => ["tool-result-aging", "off"], "tool-result-aging.ttl": ({ days }) => ["tool-result-aging", "ttl", days == null ? "off" : String(days)], "tool-result-aging.purge": ({ expiredOnly }) => ["tool-result-aging", "purge", ...(expiredOnly ? ["--expired"] : []), "--yes"],
  "usage.router": () => ["usage", "router"], "usage.provider": ({ provider: id }) => ["provider-usage", "--json", id], "usage.model": ({ slug: id }) => ["usage", "model", id],
  "vision.status": () => ["vision-bridge", "status"], "vision.on": () => ["vision-bridge", "on"], "vision.off": () => ["vision-bridge", "off"], "vision.engine": ({ engine, effort }) => ["vision-bridge", "engine", engine, ...(effort ? [effort] : [])], "vision.effort": ({ effort }) => ["vision-bridge", "effort", effort], "vision.probe": () => ["vision-bridge", "probe"], "vision.pull": ({ tag }) => ["vision-bridge", "pull", tag], "vision.purge-cache": () => ["vision-bridge", "purge-cache", "--yes"],
  "presence.status": () => ["presence", "status"], "presence.mode": ({ mode }) => ["presence", "set", mode], "cc-switch.status": () => ["cc-switch", "status"], "cc-switch.snippet": () => ["catalog", "render-snippet"],
};

const secretKey = /^(?:credential|apiKey|api_key|token|secret|password|authorization)$/i;
function errorEnvelope(code) {
  const messages = {
    command_not_supported: "This desktop command is not supported.",
    invalid_command_arguments: "The desktop command arguments are invalid.",
    protected_input_required: "This credential operation requires protected input.",
    capability_schema_unsupported: "This capability schema is not supported for mutations.",
  };
  const safeCode = messages[code] || ERROR_DEFINITIONS[code] ? code : "invalid_command_arguments";
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

function validate(schema, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || schema.type !== "object") return false;
  const keys = Object.keys(value);
  if (schema.additionalProperties === false && keys.some((key) => !Object.hasOwn(schema.properties, key))) return false;
  if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) return false;
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const validType = types.some((type) => type === "null" ? item === null : type === "integer" ? Number.isSafeInteger(item) : typeof item === type);
    if (!validType || rule.pattern && (typeof item !== "string" || !new RegExp(rule.pattern).test(item)) || rule.enum && !rule.enum.includes(item)) return false;
  }
  return true;
}

const COMMAND_DEFINITIONS_MAP = new Map(CAPABILITY_COMMANDS.map((metadata) => {
  const args = ARGUMENTS[metadata.name] || noArgs;
  return [metadata.name, Object.freeze({
    ...metadata,
    arguments: Object.freeze(args),
    execute: CONTROL_ARGS[metadata.name],
  })];
}));

const COMMAND_DEFINITIONS = new Proxy(COMMAND_DEFINITIONS_MAP, {
  get(target, property) {
    if (property === "set" || property === "delete" || property === "clear") {
      return () => { throw new TypeError("desktop command definitions are read-only"); };
    }
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export function desktopCommandDefinitions() {
  return COMMAND_DEFINITIONS;
}

function majorVersion(manifest) {
  return Number.isSafeInteger(manifest?.capabilitySchemaVersion) ? manifest.capabilitySchemaVersion : CAPABILITY_SCHEMA_VERSION;
}

function scrubResult(value) {
  if (Array.isArray(value)) return value.map(scrubResult);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretKey.test(key)) continue;
    output[key] = scrubResult(item);
  }
  return output;
}

/** Run one canonical Node command. The protected input callback is ephemeral. */
export async function runDesktopCommand(command, args = {}, context = {}) {
  if (!COMMAND_DEFINITIONS.has(command)) {
    if (Object.hasOwn(COMMANDS, command)) return runLegacyDesktopCommand(command, args, context);
    return errorEnvelope("command_not_supported");
  }
  const definition = COMMAND_DEFINITIONS.get(command);
  if (majorVersion(context.manifest) > CAPABILITY_SCHEMA_VERSION && isMutationCommand(command)) return errorEnvelope("capability_schema_unsupported");
  if (definition.protectedInput && Object.keys(args || {}).some((key) => secretKey.test(key))) return errorEnvelope("protected_input_required");
  if (!validate(definition.arguments, args)) return errorEnvelope("invalid_command_arguments");
  let protectedValue;
  if (definition.protectedInput) {
    if (typeof context.protectedInput === "function") protectedValue = await context.protectedInput();
    else protectedValue = context.protectedInput;
    if (typeof protectedValue !== "string" || !protectedValue) return errorEnvelope("protected_input_required");
  }
  try {
    let value;
    if (typeof context.execute === "function") value = await context.execute(command, { ...args }, protectedValue);
    else {
      const plan = definition.execute?.(args);
      if (!plan) return errorEnvelope("command_not_supported");
      value = await runControl(context.root || sourceRoot(), plan, {
        stdin: protectedValue,
        timeoutMs: definition.protectedInput ? CATALOG_MUTATION_TIMEOUT_MS : CONTROL_TIMEOUT_MS,
      });
      value = value.trim() ? parseJson(value) : null;
    }
    return { ok: true, value: scrubResult(value) };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : error?.body?.error?.code;
    if (code && code !== "invalid_command_arguments" && code !== "command_not_supported") {
      return errorEnvelope(code);
    }
    return errorEnvelope("invalid_command_arguments");
  } finally {
    protectedValue = undefined;
  }
}
