import util from "node:util";

/**
 * The shared UI contract.  This module deliberately does not import the test
 * oracle: the checked-in fixture is an independent assertion about this
 * table, not a production configuration file.
 */

export const CAPABILITY_SCHEMA_VERSION = 1;

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
const credentialProvider = deepFreeze({ ...provider, enum: ["deepseek", "qwen-plan"] });
const noArgs = objectSchema();

// This is the one immutable schema source consumed by both the desktop
// dispatcher and the browser manifest. Keeping it here avoids a circular
// import while ensuring the UI cannot publish an empty `{ type: object }`
// placeholder where the dispatcher has a stricter contract.
export const CAPABILITY_ARGUMENTS = deepFreeze({
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
  "tool-result-aging.ttl": objectSchema({ days: { type: ["integer", "null"], minimum: 0, maximum: 3650 } }, ["days"]),
  "tool-result-aging.purge": objectSchema({ expiredOnly: boolean }, ["expiredOnly"]),
  "usage.router": noArgs, "usage.provider": objectSchema({ provider }), "usage.model": objectSchema({ slug }, ["slug"]),
  "vision.status": noArgs, "vision.on": noArgs, "vision.off": noArgs,
  "vision.engine": objectSchema({ engine: string(), effort: string() }, ["engine"]),
  "vision.effort": objectSchema({ effort: string() }, ["effort"]), "vision.probe": noArgs,
  "vision.pull": objectSchema({ tag: string("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$") }, ["tag"]),
  "vision.purge-cache": noArgs,
  "presence.status": noArgs, "presence.mode": objectSchema({ mode: string("^(always|follow-codex|follow-clients)$") }, ["mode"]),
  "cc-switch.status": noArgs, "cc-switch.snippet": noArgs,
});

function uiMetadata(name, args, {
  mutating = false,
  confirmation = false,
  quotaWarning = false,
  protectedInput = false,
  resultKind = "json",
} = {}) {
  const properties = args.properties || {};
  const title = name
    .split(".")
    .map((part) => part.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()))
    .join(" · ");
  const namespace = name.split(".", 1)[0];
  return deepFreeze({
    title,
    localizationKey: `capability.${namespace}`,
    control: resultKind === "protected-text" ? "protected-output" : protectedInput ? "protected-input" : mutating ? "mutation" : "read",
    confirmation: confirmation ? "server" : "none",
    quotaWarning: quotaWarning ? "cost-warning" : "none",
    resultKind,
    protectedField: protectedInput ? "apiKey" : null,
    fields: Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, {
      label: key.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      localizationKey: `field.${key}`,
      type: schema.type,
      required: (args.required || []).includes(key),
      enum: schema.enum || null,
    }])),
  });
}

const command = (name, {
  mutating = false,
  confirmation = false,
  quotaWarning = false,
  protectedInput = false,
  resultKind = "json",
} = {}) => Object.freeze({
  name,
  arguments: CAPABILITY_ARGUMENTS[name] || noArgs,
  mutating,
  confirmation,
  quotaWarning,
  protectedInput,
  resultKind,
  ui: uiMetadata(name, CAPABILITY_ARGUMENTS[name] || noArgs, { mutating, confirmation, quotaWarning, protectedInput, resultKind }),
  // A command result may be returned to a UI, but credential input is never
  // retained in a capability snapshot.
  retainsInput: false,
});

const commandRows = [
  command("lifecycle.status"), command("lifecycle.start", { mutating: true }),
  command("lifecycle.stop", { mutating: true, confirmation: true }),
  command("lifecycle.restart", { mutating: true, confirmation: true }), command("lifecycle.logs", { resultKind: "text" }),
  command("doctor.status"), command("doctor.fix", { mutating: true, confirmation: true }),
  command("maintenance.update", { mutating: true, confirmation: true }), command("maintenance.rollback", { mutating: true, confirmation: true }),
  command("native.status"), command("native.account-usage"),
  command("credential.status"), command("credential.set", { mutating: true, protectedInput: true }), command("credential.remove", { mutating: true, confirmation: true }),
  command("provider.enable", { mutating: true }), command("model.visibility", { mutating: true }), command("model.canary", { mutating: true }),
  command("protocol-proof.status"), command("protocol-proof.verify", { mutating: true, confirmation: true, quotaWarning: true }), command("protocol-proof.revoke", { mutating: true, confirmation: true }),
  command("picker.status"), command("picker.set", { mutating: true }), command("picker.show-all", { mutating: true }), command("catalog.status"), command("catalog.render-snippet", { resultKind: "protected-text" }),
  command("subagents.status"), command("subagents.mode", { mutating: true }), command("subagents.model", { mutating: true }), command("subagents.selection", { mutating: true }), command("subagents.verify", { mutating: true, confirmation: true, quotaWarning: true }),
  command("failover.status"), command("failover.reset", { mutating: true, confirmation: true }),
  command("tool-result-aging.status"), command("tool-result-aging.on", { mutating: true }), command("tool-result-aging.off", { mutating: true }), command("tool-result-aging.ttl", { mutating: true }), command("tool-result-aging.purge", { mutating: true, confirmation: true }),
  command("usage.router"), command("usage.provider"), command("usage.model"),
  command("vision.status"), command("vision.on", { mutating: true }), command("vision.off", { mutating: true }), command("vision.engine", { mutating: true }), command("vision.effort", { mutating: true }), command("vision.probe", { mutating: true, quotaWarning: true }), command("vision.pull", { mutating: true, confirmation: true }), command("vision.purge-cache", { mutating: true, confirmation: true }),
  command("presence.status"), command("presence.mode", { mutating: true }),
  command("cc-switch.status"), command("cc-switch.snippet", { resultKind: "protected-text" }),
];

const capabilities = [
  ["lifecycle", ["lifecycle.status", "lifecycle.start", "lifecycle.stop", "lifecycle.restart", "lifecycle.logs"]],
  ["doctor-update", ["doctor.status", "doctor.fix", "maintenance.update", "maintenance.rollback"]],
  ["native-session-usage", ["native.status", "native.account-usage"]],
  ["provider-credentials", ["credential.status", "credential.set", "credential.remove"]],
  ["provider-model-state", ["provider.enable", "model.visibility", "model.canary"]],
  ["protocol-proof", ["protocol-proof.status", "protocol-proof.verify", "protocol-proof.revoke"]],
  ["picker-catalog", ["picker.status", "picker.set", "picker.show-all", "catalog.status", "catalog.render-snippet"]],
  ["subagents", ["subagents.status", "subagents.mode", "subagents.model", "subagents.selection", "subagents.verify"]],
  ["failover", ["failover.status", "failover.reset"]],
  ["tool-result-aging", ["tool-result-aging.status", "tool-result-aging.on", "tool-result-aging.off", "tool-result-aging.ttl", "tool-result-aging.purge"]],
  ["usage", ["usage.router", "usage.provider", "usage.model"]],
  ["vision", ["vision.status", "vision.on", "vision.off", "vision.engine", "vision.effort", "vision.probe", "vision.pull", "vision.purge-cache"]],
  ["presence", ["presence.status", "presence.mode"]],
  ["cc-switch", ["cc-switch.status", "cc-switch.snippet"]],
].map(([id, nodeCommands]) => {
  const rows = nodeCommands.map((name) => commandRows.find((entry) => entry.name === name));
  return Object.freeze({
    id,
    localizationKey: `capability.${id}`,
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    nodeCommands: Object.freeze(nodeCommands),
    swift: "full",
    browser: id === "provider-credentials" ? "protected" : id === "native-session-usage" || id === "picker-catalog" || id === "usage" || id === "presence" || id === "cc-switch" ? "full" : "write-session",
    confirmation: Object.freeze(rows.filter((entry) => entry.confirmation).map((entry) => entry.name)),
    quotaWarning: Object.freeze(rows.filter((entry) => entry.quotaWarning).map((entry) => entry.name)),
    protectedInput: Object.freeze(rows.filter((entry) => entry.protectedInput).map((entry) => entry.name)),
    resultKind: Object.freeze(Object.fromEntries(rows.filter((entry) => entry.resultKind !== "json").map((entry) => [entry.name, entry.resultKind]))),
  });
});

export const CAPABILITY_COMMANDS = deepFreeze(commandRows);
export const CAPABILITY_CAPABILITIES = deepFreeze(capabilities);

const commandByName = new Map(commandRows.map((entry) => [entry.name, entry]));

export function isMutationCommand(name) {
  return Boolean(commandByName.get(name)?.mutating);
}

const SECRET_KEY = /credential|caller.?key|access.?token|api.?key|token|secret|password|authorization|caller.?url|auth/i;
const CAPABILITY_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/_codex-router\/[^/\s]+(?:\/v1)?/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SNAPSHOT_MAX_DEPTH = 16;
const SNAPSHOT_MAX_KEYS = 256;
const SNAPSHOT_MAX_ARRAY = 1024;
const SNAPSHOT_MAX_WORK = 8192;
const SNAPSHOT_MAX_STRING = 64 * 1024;

function redactString(value) {
  if (value.length > SNAPSHOT_MAX_STRING) return undefined;
  return value.replace(CAPABILITY_URL, "[REDACTED]").replace(BEARER, "Bearer [REDACTED]");
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
}

function safeSnapshot(value, state = { seen: new WeakSet(), work: SNAPSHOT_MAX_WORK, keys: 0 }, depth = 0) {
  if (state.work-- <= 0 || state.keys > SNAPSHOT_MAX_KEYS || depth > SNAPSHOT_MAX_DEPTH) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (!value || typeof value !== "object" || util.types.isProxy(value) || state.seen.has(value)) return undefined;
  state.seen.add(value);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > SNAPSHOT_MAX_ARRAY) return undefined;
    const result = [];
    for (let index = 0; index < length; index += 1) {
      if (state.keys++ > SNAPSHOT_MAX_KEYS) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
      const item = safeSnapshot(descriptor.value, state, depth + 1);
      if (item !== undefined) result.push(item);
    }
    return result;
  }
  const result = Object.create(null);
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > SNAPSHOT_MAX_KEYS) return undefined;
  for (const key of keys) {
    if (state.keys++ > SNAPSHOT_MAX_KEYS) return undefined;
    if (SECRET_KEY.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    const item = safeSnapshot(descriptor.value, state, depth + 1);
    if (item !== undefined) Object.defineProperty(result, key, { value: item, enumerable: true, writable: false, configurable: false });
  }
  return result;
}

export function buildCapabilityManifest(snapshot = {}) {
  const hostileSource = !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || util.types.isProxy(snapshot);
  const source = hostileSource ? {} : snapshot;
  const versionDescriptor = Object.getOwnPropertyDescriptor(source, "capabilitySchemaVersion");
  const version = hostileSource
    ? undefined
    : versionDescriptor
      ? Object.hasOwn(versionDescriptor, "value") ? versionDescriptor.value : undefined
      : CAPABILITY_SCHEMA_VERSION;
  if (version !== CAPABILITY_SCHEMA_VERSION) {
    const reported = Number.isSafeInteger(version) && version >= 0 ? version : CAPABILITY_SCHEMA_VERSION;
    return deepFreeze({
      capabilitySchemaVersion: reported,
      compatibility: Object.freeze({ readOnly: true, reason: "unknown_major_version" }),
      mutationsEnabled: false,
      commands: [],
      capabilities: [],
      snapshot: safeSnapshot(source) || {},
    });
  }
  const clean = safeSnapshot(source) || {};
  return deepFreeze({
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    compatibility: Object.freeze({ readOnly: false, reason: null }),
    mutationsEnabled: true,
    commands: commandRows.map((entry) => ({ ...entry, arguments: cloneJson(entry.arguments), ui: cloneJson(entry.ui) })),
    capabilities: capabilities.map((entry) => ({ ...entry, nodeCommands: [...entry.nodeCommands] })),
    snapshot: clean,
  });
}
