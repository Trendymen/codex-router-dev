import assert from "node:assert/strict";
import test from "node:test";

import fixture from "./fixtures/required-capabilities.json" with { type: "json" };
import {
  CAPABILITY_SCHEMA_VERSION,
  buildCapabilityManifest,
  isMutationCommand,
} from "../src/capability-manifest.mjs";
import {
  desktopCommandDefinitions,
  runDesktopCommand,
} from "../src/desktop-commands.mjs";

test("Node command table exactly covers the independent oracle", () => {
  const commands = desktopCommandDefinitions();
  assert.deepEqual([...commands.keys()].sort(), [...fixture.nodeCommands].sort());
  for (const removed of fixture.forbiddenCommands) assert.equal(commands.has(removed), false, removed);
});

test("capability manifest publishes the independent command metadata", () => {
  const manifest = buildCapabilityManifest({
    providers: [{ id: "deepseek", enabled: true }],
    models: [{ slug: "deepseek/deepseek-v4-pro", listed: true }],
  });
  assert.equal(manifest.capabilitySchemaVersion, CAPABILITY_SCHEMA_VERSION);
  assert.equal(manifest.compatibility.readOnly, false);
  assert.equal(manifest.commands.length, fixture.nodeCommands.length);
  assert.deepEqual(manifest.commands.map(({ name }) => name).sort(), [...fixture.nodeCommands].sort());
  assert.ok(manifest.capabilities.some(({ id }) => id === "vision"));
  assert.equal(manifest.commands.some((command) => command.name === "credential.set" && command.retainsInput), false);
});

test("unknown major capability snapshots are explicitly read-only", () => {
  const manifest = buildCapabilityManifest({ capabilitySchemaVersion: 99 });
  assert.equal(manifest.compatibility.readOnly, true);
  assert.equal(manifest.compatibility.reason, "unknown_major_version");
  assert.equal(manifest.mutationsEnabled, false);
  assert.equal(manifest.commands.length, 0);
  assert.equal(isMutationCommand("lifecycle.status"), false);
});

test("command execution returns the stable envelope and validates arguments in Node", async () => {
  const calls = [];
  const result = await runDesktopCommand("model.visibility", { slug: "deepseek/v4", visible: false }, {
    execute: async (name, args) => {
      calls.push([name, args]);
      return { changed: true, secret: "must not be snapshotted" };
    },
  });
  assert.deepEqual(result, { ok: true, value: { changed: true } });
  assert.deepEqual(calls, [["model.visibility", { slug: "deepseek/v4", visible: false }]]);

  const invalid = await runDesktopCommand("model.visibility", { slug: "bad slug", visible: false }, {
    execute: async () => ({ changed: true }),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_command_arguments");
});

test("credentials require protected input and are never accepted in command arguments", async () => {
  const exposed = await runDesktopCommand("credential.set", { provider: "deepseek", credential: "decoy-secret" }, {
    execute: async () => ({ ok: true }),
  });
  assert.equal(exposed.ok, false);
  assert.equal(exposed.error.code, "protected_input_required");

  const seen = [];
  const saved = await runDesktopCommand("credential.set", { provider: "deepseek" }, {
    protectedInput: async () => "one-time-secret",
    execute: async (name, args, protectedInput) => {
      seen.push([name, args, protectedInput]);
      return { provider: args.provider, configured: true };
    },
  });
  assert.deepEqual(saved, { ok: true, value: { provider: "deepseek", configured: true } });
  assert.deepEqual(seen, [["credential.set", { provider: "deepseek" }, "one-time-secret"]]);
});

test("unknown commands and mutations under an unknown major fail closed", async () => {
  const unknown = await runDesktopCommand("not-a-command", {}, {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "command_not_supported");
  const blocked = await runDesktopCommand("model.visibility", { slug: "deepseek/v4", visible: false }, {
    manifest: { capabilitySchemaVersion: 99 },
    execute: async () => ({ changed: true }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "capability_schema_unsupported");
});
