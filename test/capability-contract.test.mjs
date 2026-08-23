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
  for (const removed of fixture.forbiddenCommands) {
    assert.equal(commands.has(removed), false, removed);
  }
  const metadata = fixture.commandMetadata;
  assert.deepEqual([...commands.values()].filter(({ protectedInput }) => protectedInput).map(({ name }) => name), metadata.protectedInput);
  assert.deepEqual([...commands.values()].filter(({ confirmation }) => confirmation).map(({ name }) => name), metadata.confirmation);
  assert.deepEqual([...commands.values()].filter(({ quotaWarning }) => quotaWarning).map(({ name }) => name), metadata.quotaWarning);
  assert.deepEqual(Object.fromEntries([...commands.values()].filter(({ resultKind }) => resultKind !== "json").map(({ name, resultKind }) => [name, resultKind])), metadata.resultKind);
  assert.ok(fixture.capabilities.find(({ id }) => id === "provider-credentials").browser === "protected");
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

test("canonical dispatcher does not fall back to legacy command aliases", async () => {
  for (const removed of [...fixture.forbiddenCommands, "set_signed_routing", "set_login_free", "presence_status", "save_api_key"]) {
    const result = await runDesktopCommand(removed, {}, { execute: async () => ({ changed: true }) });
    assert.equal(result.ok, false, removed);
    assert.equal(result.error.code, "command_not_supported", removed);
  }
});

test("every schema version except exactly one is read-only for mutations", async () => {
  for (const version of [0, -1, "1", null, true, 2, "future"]) {
    const result = await runDesktopCommand("model.visibility", { slug: "deepseek/v4", visible: false }, {
      manifest: { capabilitySchemaVersion: version },
      execute: async () => ({ changed: true }),
    });
    assert.equal(result.ok, false, String(version));
    assert.equal(result.error.code, "capability_schema_unsupported", String(version));
  }
  const read = await runDesktopCommand("lifecycle.status", {}, {
    manifest: { capabilitySchemaVersion: 99 },
    execute: async () => ({ state: "running" }),
  });
  assert.deepEqual(read, { ok: true, value: { state: "running" } });
});

test("command definitions and schemas are deeply immutable", () => {
  const definitions = desktopCommandDefinitions();
  for (const definition of definitions.values()) {
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.arguments));
    assert.ok(Object.isFrozen(definition.arguments.properties));
  }
  assert.throws(() => definitions.entries().next().value[1].arguments.required.push("x"), TypeError);
  assert.throws(() => definitions.set("x", {}), TypeError);
  assert.equal([...definitions.keys()].length, fixture.nodeCommands.length);
});

test("argument validation fails closed for proxies, accessors, cycles, and oversized objects", async () => {
  const cases = [
    new Proxy({}, {}),
    Object.defineProperty({}, "slug", { get() { throw new Error("secret getter"); }, enumerable: true }),
  ];
  const cycle = { slug: "deepseek/v4", visible: false };
  cycle.self = cycle;
  cases.push(cycle);
  for (const args of cases) {
    const result = await runDesktopCommand("model.visibility", args, { execute: async () => ({ changed: true }) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_command_arguments");
  }
  const oversized = { slug: "deepseek/v4", visible: false };
  for (let index = 0; index < 300; index += 1) oversized[`x${index}`] = index;
  const result = await runDesktopCommand("model.visibility", oversized, { execute: async () => ({ changed: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_command_arguments");
});

test("protected input failures and exact secret echoes never cross the result boundary", async () => {
  const callbackFailure = await runDesktopCommand("credential.set", { provider: "deepseek" }, {
    protectedInput: async () => { throw new Error("decoy-secret-callback"); },
    execute: async () => ({ ok: true }),
  });
  assert.equal(callbackFailure.ok, false);
  assert.equal(callbackFailure.error.code, "protected_input_required");
  assert.doesNotMatch(JSON.stringify(callbackFailure), /decoy-secret-callback/);

  const value = "one-time-capability-secret";
  const result = await runDesktopCommand("credential.set", { provider: "deepseek" }, {
    protectedInput: value,
    execute: async () => ({ echoed: value, nested: { value }, url: `http://127.0.0.1:4200/_codex-router/${value}/v1` }),
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /one-time-capability-secret/);
});

test("manifest snapshots are bounded, getter-safe, cycle-safe, and deeply frozen", () => {
  const source = { providers: [{ id: "deepseek", credential: "decoy" }], callerUrl: "http://127.0.0.1:4200/_codex-router/secret/v1" };
  source.self = source;
  Object.defineProperty(source, "throws", { enumerable: true, get() { throw new Error("getter-secret"); } });
  const manifest = buildCapabilityManifest(source);
  assert.doesNotMatch(JSON.stringify(manifest), /decoy|secret|getter-secret/);
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.snapshot));
  assert.ok(Object.isFrozen(manifest.commands[0]));
  assert.ok(Object.isFrozen(manifest.capabilities[0]));
  assert.ok(Object.isFrozen(manifest.capabilities[0].nodeCommands));
});

test("every canonical command has a real control-bridge invocation and result kind", async () => {
  const argsByCommand = {};
  for (const command of fixture.nodeCommands) argsByCommand[command] = {};
  Object.assign(argsByCommand, {
    "credential.status": { provider: "deepseek" }, "credential.set": { provider: "deepseek" }, "credential.remove": { provider: "deepseek" },
    "provider.enable": { provider: "deepseek", enabled: true }, "model.visibility": { slug: "deepseek/v4", visible: true }, "model.canary": { slug: "qwen-plan/qwen3.7-max", enabled: false },
    "protocol-proof.status": { slug: "deepseek/v4" }, "protocol-proof.verify": { slug: "deepseek/v4" }, "protocol-proof.revoke": { slug: "deepseek/v4" },
    "picker.set": { slug: "deepseek/v4", visible: true }, "picker.show-all": { visible: true },
    "subagents.mode": { mode: "all" }, "subagents.model": { slug: "deepseek/v4", enabled: true }, "subagents.selection": { selection: "select-all" }, "subagents.verify": { slug: "deepseek/v4" },
    "tool-result-aging.ttl": { days: 7 }, "tool-result-aging.purge": { expiredOnly: true }, "usage.provider": { provider: "deepseek" }, "usage.model": { slug: "deepseek/v4" },
    "vision.engine": { engine: "auto" }, "vision.effort": { effort: "default" }, "vision.pull": { tag: "qwen2.5vl:3b" }, "presence.mode": { mode: "always" },
  });
  const invoked = [];
  for (const name of fixture.nodeCommands) {
    const definition = desktopCommandDefinitions().get(name);
    const result = await runDesktopCommand(name, argsByCommand[name], {
      protectedInput: name === "credential.set" ? "protected" : undefined,
      runControl: async (_root, argv) => {
        invoked.push([name, argv]);
        return definition.resultKind === "text" ? "text-result\n" : "{}\n";
      },
    });
    assert.equal(result.ok, true, name);
    assert.ok(Array.isArray(invoked.at(-1)[1]), name);
  }
  assert.equal(invoked.length, fixture.nodeCommands.length);
});
