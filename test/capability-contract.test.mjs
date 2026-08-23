import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fixture from "./fixtures/required-capabilities.json" with { type: "json" };
import {
  CAPABILITY_SCHEMA_VERSION,
  buildCapabilityManifest,
  isMutationCommand,
} from "../src/capability-manifest.mjs";
import {
  desktopCommandDefinitions,
  runControl,
  runDesktopCommand,
  trustedProtectedContext,
} from "../src/desktop-commands.mjs";
import { PROVIDERS } from "../src/model-registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REAL_CHILD_EXPECTATIONS = Object.freeze({
  "lifecycle.status": "json", "lifecycle.start": "json", "lifecycle.stop": "json", "lifecycle.restart": "json", "lifecycle.logs": "text",
  "doctor.status": "json", "doctor.fix": "json", "maintenance.update": "json", "maintenance.rollback": "json",
  "native.status": "json", "native.account-usage": "json",
  "credential.status": "json", "credential.set": "json", "credential.remove": "json",
  "provider.enable": "json", "model.visibility": "json", "model.canary": "json",
  "protocol-proof.status": "json", "protocol-proof.verify": "error:protocol_probe_not_implemented", "protocol-proof.revoke": "json",
  "picker.status": "json", "picker.set": "json", "picker.show-all": "json",
  "catalog.status": "json", "catalog.render-snippet": "protected-text",
  "subagents.status": "json", "subagents.mode": "json", "subagents.model": "json", "subagents.selection": "json", "subagents.verify": "json",
  "failover.status": "json", "failover.reset": "json",
  "tool-result-aging.status": "json", "tool-result-aging.on": "json", "tool-result-aging.off": "json", "tool-result-aging.ttl": "json", "tool-result-aging.purge": "json",
  "usage.router": "json", "usage.provider": "json", "usage.model": "json",
  "vision.status": "json", "vision.on": "json", "vision.off": "json", "vision.engine": "json", "vision.effort": "json", "vision.probe": "error:local_probe_disabled", "vision.pull": "json", "vision.purge-cache": "json",
  "presence.status": "json", "presence.mode": "json",
  "cc-switch.status": "json", "cc-switch.snippet": "protected-text",
});

const PROVIDER_CREDENTIAL_ENV = Object.freeze([...new Set([
  ...[...PROVIDERS.values()].flatMap((provider) => provider.credential?.environment || []),
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
])].sort());

function repositorySnapshot() {
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  return {
    head: git("rev-parse", "HEAD"),
    status: git("status", "--porcelain=v1", "--untracked-files=all"),
    tree: git("diff", "--binary", "--no-ext-diff", "HEAD", "--", "."),
  };
}

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
  const manifestRows = buildCapabilityManifest().capabilities.map(({ id, schemaVersion, nodeCommands, swift, browser, confirmation, quotaWarning, protectedInput, resultKind }) => ({ id, schemaVersion, nodeCommands, swift, browser, confirmation, quotaWarning, protectedInput, resultKind }));
  const fixtureRows = fixture.capabilities.map((row) => ({
    id: row.id,
    schemaVersion: metadata.schemaVersion,
    nodeCommands: row.nodeCommands,
    swift: row.swift,
    browser: row.browser,
    confirmation: row.confirmation,
    quotaWarning: row.quotaWarning,
    protectedInput: row.id === "provider-credentials" ? ["credential.set"] : [],
    resultKind: Object.fromEntries(row.nodeCommands.filter((name) => Object.hasOwn(metadata.resultKind, name)).map((name) => [name, metadata.resultKind[name]])),
  }));
  assert.deepEqual(manifestRows, fixtureRows);
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
  for (const input of [
    { capabilitySchemaVersion: 0 },
    { capabilitySchemaVersion: "1" },
    Object.defineProperty({}, "capabilitySchemaVersion", { get() { throw new Error("must not execute"); }, enumerable: true }),
    new Proxy({ capabilitySchemaVersion: 1 }, {}),
  ]) {
    const incompatible = buildCapabilityManifest(input);
    assert.equal(incompatible.compatibility.readOnly, true);
    assert.equal(incompatible.mutationsEnabled, false);
  }
});

test("command execution returns the stable envelope and validates arguments in Node", async () => {
  const calls = [];
  const result = await runDesktopCommand("model.visibility", { slug: "deepseek/v4", visible: false }, {
    execute: async (name, args) => {
      calls.push([name, args]);
      return { changed: true, secret: "must not be snapshotted" };
    },
  });
  assert.deepEqual({ ...result.value }, { changed: true });
  assert.deepEqual(calls, [["model.visibility", { slug: "deepseek/v4", visible: false }]]);

  const invalid = await runDesktopCommand("model.visibility", { slug: "bad slug", visible: false }, {
    execute: async () => ({ changed: true }),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid_command_arguments");
});

test("provider.enable publishes and enforces the closed supported-provider enum", async () => {
  const definition = desktopCommandDefinitions().get("provider.enable");
  assert.deepEqual(definition.arguments.properties.provider.enum, ["deepseek", "qwen-plan"]);

  for (const provider of ["kimi-api", "local", "lmstudio", "not-a-provider", "deepseek.constructor"]) {
    let invoked = false;
    const result = await runDesktopCommand("provider.enable", { provider, enabled: true }, {
      execute: async () => {
        invoked = true;
        return { changed: true };
      },
    });
    assert.equal(result.ok, false, provider);
    assert.equal(result.error.code, "invalid_command_arguments", provider);
    assert.equal(invoked, false, `${provider} must be rejected before execution`);
  }

  const accessorArgs = {};
  Object.defineProperty(accessorArgs, "provider", {
    enumerable: true,
    get() {
      throw new Error("provider accessor must not run");
    },
  });
  Object.defineProperty(accessorArgs, "enabled", { value: true, enumerable: true });
  const accessorResult = await runDesktopCommand("provider.enable", accessorArgs, {
    execute: async () => ({ changed: true }),
  });
  assert.equal(accessorResult.ok, false);
  assert.equal(accessorResult.error.code, "invalid_command_arguments");

  const proxyResult = await runDesktopCommand("provider.enable", new Proxy({ provider: "deepseek", enabled: true }, {}), {
    execute: async () => ({ changed: true }),
  });
  assert.equal(proxyResult.ok, false);
  assert.equal(proxyResult.error.code, "invalid_command_arguments");

  for (const provider of ["deepseek", "qwen-plan"]) {
    const calls = [];
    const result = await runDesktopCommand("provider.enable", { provider, enabled: true }, {
      execute: async (name, args) => {
        calls.push([name, args]);
        return { changed: true };
      },
    });
    assert.equal(result.ok, true, provider);
    assert.deepEqual(calls, [["provider.enable", { provider, enabled: true }]], provider);
  }
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
  assert.deepEqual({ ...saved.value }, { provider: "deepseek", configured: true });
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
  assert.deepEqual({ ...read.value }, { state: "running", health: "available", version: "unknown" });
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
      ...(definition.resultKind === "protected-text" ? trustedProtectedContext() : {}),
      runControl: async (_root, argv) => {
        invoked.push([name, argv]);
        return definition.resultKind === "text" || definition.resultKind === "protected-text"
          ? "model_provider = \"custom\"\nbase_url = \"http://127.0.0.1:4200/_codex-router/caller/v1\"\n"
          : "{}\n";
      },
    });
    assert.equal(result.ok, true, name);
    assert.ok(Array.isArray(invoked.at(-1)[1]), name);
  }
  assert.equal(invoked.length, fixture.nodeCommands.length);
});

test("every canonical mapping spawns the actual control child inside a fail-closed oracle", async () => {
  assert.deepEqual(Object.keys(REAL_CHILD_EXPECTATIONS).sort(), [...fixture.nodeCommands].sort());
  const beforeRepository = repositorySnapshot();
  const state = mkdtempSync(path.join(os.tmpdir(), "canonical-control-bridge-"));
  const codexHome = path.join(state, "codex-home");
  const userHome = path.join(state, "user-home");
  const tracePath = path.join(state, "safe-child-trace.jsonl");
  const purgePath = path.join(state, "vision-cache-purge.json");
  const callerSecret = "c".repeat(48);
  const protectedSecret = "isolated-provider-secret-41ef2ab7";
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  mkdirSync(path.join(state, "appdata"), { recursive: true });
  mkdirSync(path.join(state, "localappdata"), { recursive: true });
  mkdirSync(path.join(state, "launch-agents"), { recursive: true });
  writeFileSync(path.join(state, "caller-secret"), `${callerSecret}\n`);
  writeFileSync(path.join(state, "internal-secret"), `${"i".repeat(48)}\n`);
  writeFileSync(path.join(state, "routed-models.json"), `${JSON.stringify({ models: [] })}\n`);
  writeFileSync(
    path.join(state, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(state, "enabled-providers.json"), "utf8")),
    { version: 1, providers: [] },
    "the canonical child fixture must use the versioned provider-selection document",
  );
  writeFileSync(path.join(codexHome, "config.toml"), "");
  writeFileSync(purgePath, `${JSON.stringify({ version: 1, generation: 1 })}\n`);
  writeFileSync(tracePath, "");
  const preload = path.join(repoRoot, "test", "fixtures", "control-safe-stubs.cjs");
  const environment = {
    PATH: process.env.PATH || process.env.Path || "",
    PATHEXT: process.env.PATHEXT || "",
    SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "",
    WINDIR: process.env.WINDIR || process.env.SystemRoot || process.env.SYSTEMROOT || "",
    ComSpec: process.env.ComSpec || process.env.COMSPEC || "",
    TEMP: state,
    TMP: state,
    HOME: userHome,
    USERPROFILE: userHome,
    APPDATA: path.join(state, "appdata"),
    LOCALAPPDATA: path.join(state, "localappdata"),
    CODEX_HOME: codexHome,
    CODEX_BINARY: path.join(state, "fake-codex.exe"),
    DSH_HOME: path.join(state, "dsh-home"),
    GEMINI_CLI_HOME: path.join(state, "gemini-home"),
    CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_SOURCE_ROOT: repoRoot,
    CODEX_ROUTER_SOURCE_ROOT: repoRoot,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(state, "launch-agents"),
    MODEL_ROUTER_DSH_SETTINGS: path.join(state, "dsh-home", "settings.yaml"),
    MODEL_ROUTER_DSH_CREDENTIALS: path.join(state, "dsh-home", ".credentials.yaml"),
    MODEL_ROUTER_GEMINI_ENV: path.join(state, "gemini-home", ".gemini", ".env"),
    MODEL_ROUTER_VISION_CACHE_PURGE: purgePath,
    MODEL_ROUTER_VISION_DOWNLOAD_STATE: path.join(state, "vision-download.json"),
    MODEL_ROUTER_VISION_DOWNLOAD_CLAIM: path.join(state, "vision-download.claim"),
    CODEX_ROUTER_ALLOW_LIVE_PROTOCOL_PROBE: "0",
    CODEX_ROUTER_ALLOW_LOCAL_PROBE: "0",
    CONTROL_SAFE_TRACE: tracePath,
    NODE_TEST_CONTEXT: "child-v8",
    NODE_OPTIONS: `--require=${preload}`,
  };
  for (const name of PROVIDER_CREDENTIAL_ENV) environment[name] = "";
  for (const name of PROVIDER_CREDENTIAL_ENV) {
    assert.equal(environment[name], "", `provider credential environment was not blanked: ${name}`);
  }

  const argsByCommand = Object.fromEntries(fixture.nodeCommands.map((name) => [name, {}]));
  Object.assign(argsByCommand, {
    "credential.status": { provider: "deepseek" }, "credential.set": { provider: "deepseek" }, "credential.remove": { provider: "deepseek" },
    "provider.enable": { provider: "deepseek", enabled: true }, "model.visibility": { slug: "deepseek/deepseek-v4-pro", visible: true }, "model.canary": { slug: "qwen-plan/qwen3.7-max", enabled: false },
    "protocol-proof.status": { slug: "qwen-plan/qwen3.7-max" }, "protocol-proof.verify": { slug: "qwen-plan/qwen3.7-max" }, "protocol-proof.revoke": { slug: "qwen-plan/qwen3.7-max" },
    "picker.set": { slug: "deepseek/deepseek-v4-pro", visible: true }, "picker.show-all": { visible: true },
    "subagents.mode": { mode: "proven" }, "subagents.model": { slug: "deepseek/deepseek-v4-pro", enabled: true }, "subagents.selection": { selection: "select-all" }, "subagents.verify": { slug: "grok-api/grok-4.5" },
    "tool-result-aging.ttl": { days: 7 }, "tool-result-aging.purge": { expiredOnly: true }, "usage.provider": { provider: "deepseek" }, "usage.model": { slug: "deepseek/deepseek-v4-pro" },
    "vision.engine": { engine: "auto" }, "vision.effort": { effort: "default" }, "vision.pull": { tag: "qwen2.5vl:3b" }, "presence.mode": { mode: "always" },
  });

  try {
    for (const name of fixture.nodeCommands) {
      if (name === "picker.show-all") {
        const nativeCatalog = { models: [{
          slug: "gpt-fixture-native",
          base_instructions: "fixture native instructions",
          model_messages: { instructions_template: "fixture native instructions" },
          supports_parallel_tool_calls: false,
        }] };
        const emptyModels = { version: 1, models: [] };
        for (const [file, contents] of Object.entries({
          "merged-models.json": nativeCatalog,
          "routed-models.json": nativeCatalog,
          "node-routes.json": { version: 1, routes: [] },
          "control-models.json": emptyModels,
          "swift-models.json": emptyModels,
          "browser-models.json": emptyModels,
        })) {
          writeFileSync(path.join(state, file), `${JSON.stringify(contents)}\n`);
        }
      }
      const definition = desktopCommandDefinitions().get(name);
      let childFailure;
      const context = {
        root: repoRoot,
        protectedInput: name === "credential.set" ? protectedSecret : undefined,
        runControl: (root, argv, options) => runControl(root, argv, {
          ...options,
          runtime: {
            command: process.execPath,
            env: { ...environment, CONTROL_SAFE_CANONICAL_COMMAND: name },
          },
          timeoutMs: 20_000,
        }).catch((error) => {
          childFailure = String(error?.message || error)
            .split(protectedSecret).join("[REDACTED]")
            .split(callerSecret).join("[REDACTED]");
          throw error;
        }),
      };
      const trusted = definition.resultKind === "protected-text" ? trustedProtectedContext(context) : context;
      const result = await runDesktopCommand(name, argsByCommand[name], trusted);
      const expected = REAL_CHILD_EXPECTATIONS[name];
      if (expected.startsWith("error:")) {
        assert.equal(result?.ok, false, `${name}: expected ${expected}, got ${JSON.stringify(result)}`);
        assert.equal(result.error?.code, expected.slice("error:".length), `${name}: received an undeclared error code; child=${childFailure || "none"}`);
        continue;
      }
      assert.equal(result?.ok, true, `${name}: expected ${expected} success, got ${JSON.stringify(result)}; child=${childFailure || "none"}`);
      if (expected === "json") {
        assert.ok(result.value && typeof result.value === "object" && !Array.isArray(result.value), `${name}: expected a JSON object`);
      } else {
        assert.equal(typeof result.value, "string", `${name}: expected text`);
        assert.ok(result.value.length > 0, `${name}: expected non-empty text`);
      }
      if (expected === "protected-text") {
        assert.match(result.value, new RegExp(callerSecret), `${name}: protected snippet lost its caller capability`);
        assert.deepEqual(result.meta, { protected: true, resultKind: "protected-text", cacheControl: "no-store" });
      }
    }

    const traceRaw = readFileSync(tracePath, "utf8");
    const trace = traceRaw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(trace.some((event) => event.type === "preload"), "real control children did not load the safety preload");
    assert.equal(trace.filter((event) => event.type === "network").length, 0, traceRaw);
    assert.equal(
      trace.filter((event) => event.owner === "usage.provider" && event.type === "network").length,
      0,
      `usage.provider made a network request:\n${traceRaw}`,
    );
    assert.ok(trace.filter((event) => event.type === "child").every((event) => event.stubbed === true), "an inner child was not stubbed");
    assert.ok(
      trace.some((event) => event.owner === "maintenance.rollback" && event.category === "git" && event.stubbed === true),
      "rollback did not reach the deterministic git stub",
    );
    assert.doesNotMatch(traceRaw, new RegExp(protectedSecret));
    assert.doesNotMatch(traceRaw, new RegExp(callerSecret));
    const routerLog = path.join(state, "router.log");
    if (existsSync(routerLog)) {
      const log = readFileSync(routerLog, "utf8");
      assert.doesNotMatch(log, new RegExp(protectedSecret));
      assert.doesNotMatch(log, new RegExp(callerSecret));
    }
  } finally {
    const afterRepository = repositorySnapshot();
    rmSync(state, { recursive: true, force: true });
    assert.deepEqual(afterRepository, beforeRepository, "the real repository changed while the child oracle ran");
  }
});

test("hostile executor errors use own-data extraction and never trigger getters", async () => {
  const hostile = Object.create(null);
  Object.defineProperty(hostile, "code", { get() { throw new Error("error-secret"); }, enumerable: true });
  const result = await runDesktopCommand("lifecycle.status", {}, {
    execute: async () => { throw hostile; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_command_arguments");
  assert.doesNotMatch(JSON.stringify(result), /error-secret/);
});

test("result sanitizer protects bearer/caller values in arrays and neutralizes prototype keys", async () => {
  const value = "caller-secret-value";
  const result = await runDesktopCommand("credential.set", { provider: "deepseek" }, {
    protectedInput: value,
    execute: async () => ({
      authorization: `Bearer ${value}`,
      values: [value, `http://127.0.0.1:4200/_codex-router/${value}/v1`],
      __proto__: { polluted: true },
      constructor: value,
      prototype: value,
    }),
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /caller-secret-value|polluted/);
  assert.equal(Object.getPrototypeOf(result.value), null);
});

test("snippet output requires an authorized channel and preserves the usable caller capability only there", async () => {
  const execute = async () => "base_url = \"http://127.0.0.1:4200/_codex-router/caller-secret/v1\"\n";
  const refused = await runDesktopCommand("cc-switch.snippet", {}, { execute });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "protected_output_required");
  const forged = await runDesktopCommand("cc-switch.snippet", {}, { execute, protectedChannel: Symbol("forged") });
  assert.equal(forged.ok, false);
  assert.equal(forged.error.code, "protected_output_required");
  const allowed = await runDesktopCommand("cc-switch.snippet", {}, trustedProtectedContext({ execute }));
  assert.equal(allowed.ok, true);
  assert.match(allowed.value, /_codex-router\/caller-secret\/v1/);
  assert.deepEqual(allowed.meta, { protected: true, resultKind: "protected-text", cacheControl: "no-store" });

  const oversized = await runDesktopCommand("cc-switch.snippet", {}, trustedProtectedContext({
    execute: async () => "x".repeat(64 * 1024 + 1),
  }));
  assert.equal(oversized.ok, false);
  assert.equal(oversized.error.code, "invalid_command_arguments");
});
