/**
 * The shared UI contract.  This module deliberately does not import the test
 * oracle: the checked-in fixture is an independent assertion about this
 * table, not a production configuration file.
 */

export const CAPABILITY_SCHEMA_VERSION = 1;

const command = (name, {
  mutating = false,
  confirmation = false,
  quotaWarning = false,
  protectedInput = false,
} = {}) => Object.freeze({
  name,
  arguments: Object.freeze({ type: "object" }),
  mutating,
  confirmation,
  quotaWarning,
  protectedInput,
  // A command result may be returned to a UI, but credential input is never
  // retained in a capability snapshot.
  retainsInput: false,
});

const commandRows = [
  command("lifecycle.status"), command("lifecycle.start", { mutating: true }),
  command("lifecycle.stop", { mutating: true, confirmation: true }),
  command("lifecycle.restart", { mutating: true, confirmation: true }), command("lifecycle.logs"),
  command("doctor.status"), command("doctor.fix", { mutating: true, confirmation: true }),
  command("maintenance.update", { mutating: true, confirmation: true }), command("maintenance.rollback", { mutating: true, confirmation: true }),
  command("native.status"), command("native.account-usage"),
  command("credential.status"), command("credential.set", { mutating: true, protectedInput: true }), command("credential.remove", { mutating: true, confirmation: true }),
  command("provider.enable", { mutating: true }), command("model.visibility", { mutating: true }), command("model.canary", { mutating: true }),
  command("protocol-proof.status"), command("protocol-proof.verify", { mutating: true, confirmation: true, quotaWarning: true }), command("protocol-proof.revoke", { mutating: true, confirmation: true }),
  command("picker.status"), command("picker.set", { mutating: true }), command("picker.show-all", { mutating: true }), command("catalog.status"), command("catalog.render-snippet"),
  command("subagents.status"), command("subagents.mode", { mutating: true }), command("subagents.model", { mutating: true }), command("subagents.selection", { mutating: true }), command("subagents.verify", { mutating: true, confirmation: true, quotaWarning: true }),
  command("failover.status"), command("failover.reset", { mutating: true, confirmation: true }),
  command("tool-result-aging.status"), command("tool-result-aging.on", { mutating: true }), command("tool-result-aging.off", { mutating: true }), command("tool-result-aging.ttl", { mutating: true }), command("tool-result-aging.purge", { mutating: true, confirmation: true }),
  command("usage.router"), command("usage.provider"), command("usage.model"),
  command("vision.status"), command("vision.on", { mutating: true }), command("vision.off", { mutating: true }), command("vision.engine", { mutating: true }), command("vision.effort", { mutating: true }), command("vision.probe", { mutating: true, quotaWarning: true }), command("vision.pull", { mutating: true, confirmation: true }), command("vision.purge-cache", { mutating: true, confirmation: true }),
  command("presence.status"), command("presence.mode", { mutating: true }),
  command("cc-switch.status"), command("cc-switch.snippet"),
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
].map(([id, nodeCommands]) => Object.freeze({
  id,
  nodeCommands: Object.freeze(nodeCommands),
  swift: "full",
  browser: id === "native-session-usage" || id === "picker-catalog" || id === "usage" || id === "presence" || id === "cc-switch" ? "full" : "write-session",
}));

export const CAPABILITY_COMMANDS = Object.freeze(commandRows);
export const CAPABILITY_CAPABILITIES = Object.freeze(capabilities);

const commandByName = new Map(commandRows.map((entry) => [entry.name, entry]));
const MAJOR = (version) => Number.isSafeInteger(version) && version >= 0 ? version : CAPABILITY_SCHEMA_VERSION;

export function isMutationCommand(name) {
  return Boolean(commandByName.get(name)?.mutating);
}

function safeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/credential|api.?key|token|secret|password|authorization/i.test(key)) continue;
    if (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
    else if (Array.isArray(item)) result[key] = item.slice(0, 1024).map((entry) => {
      if (entry && typeof entry === "object") return safeSnapshot(entry);
      return typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)) ? entry : undefined;
    }).filter((entry) => entry !== undefined);
    else if (item && typeof item === "object") result[key] = safeSnapshot(item) || {};
  }
  return result;
}

export function buildCapabilityManifest(snapshot = {}) {
  const major = MAJOR(snapshot.capabilitySchemaVersion);
  if (major > CAPABILITY_SCHEMA_VERSION) {
    return Object.freeze({
      capabilitySchemaVersion: major,
      compatibility: Object.freeze({ readOnly: true, reason: "unknown_major_version" }),
      mutationsEnabled: false,
      commands: Object.freeze([]),
      capabilities: Object.freeze([]),
      snapshot: Object.freeze(safeSnapshot(snapshot) || {}),
    });
  }
  const clean = safeSnapshot(snapshot) || {};
  return Object.freeze({
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    compatibility: Object.freeze({ readOnly: false, reason: null }),
    mutationsEnabled: true,
    commands: Object.freeze(commandRows.map((entry) => ({ ...entry }))),
    capabilities: Object.freeze(capabilities.map((entry) => ({ ...entry, nodeCommands: [...entry.nodeCommands] }))),
    snapshot: Object.freeze(clean),
  });
}
