import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fixture from "./fixtures/required-capabilities.json" with { type: "json" };
import {
  browserArgumentsForCommand,
  browserCommandIds,
  canonicalArgumentsHash,
  createBrowserOperationState,
  renderCapabilitySurface,
  serializeBrowserState,
  visibleSections,
} from "../apps/desktop/ui/model.mjs";
import { buildCapabilityManifest } from "../src/capability-manifest.mjs";
import { canonicalArgumentsHash as nodeCanonicalArgumentsHash } from "../src/panel-sessions.mjs";
import { desktopCommandDefinitions, runDesktopCommand, trustedProtectedContext } from "../src/desktop-commands.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiFiles = ["index.html", "app.js", "model.mjs", "styles.css"].map((name) =>
  readFileSync(path.join(root, "apps", "desktop", "ui", name), "utf8"),
);

function fixtureManifest(overrides = {}) {
  const commandMetadata = new Map(
    fixture.nodeCommands.map((name) => [name, {
      name,
      arguments: desktopCommandDefinitions().get(name)?.arguments || { type: "object", additionalProperties: false, properties: {} },
      ui: desktopCommandDefinitions().get(name)?.ui || {},
      confirmation: fixture.commandMetadata.confirmation.includes(name),
      quotaWarning: fixture.commandMetadata.quotaWarning.includes(name),
      protectedInput: fixture.commandMetadata.protectedInput.includes(name),
      resultKind: fixture.commandMetadata.resultKind[name] || "json",
      mutating: !name.endsWith(".status") && !name.endsWith(".logs") && !name.endsWith(".account-usage") && !name.endsWith(".router") && !name.endsWith(".provider") && !name.endsWith(".model") && !name.endsWith(".snippet"),
    }]),
  );
  return {
    capabilitySchemaVersion: fixture.capabilitySchemaVersion,
    commands: [...commandMetadata.values()],
    capabilities: fixture.capabilities.map((item) => ({
      ...item,
      schemaVersion: fixture.capabilitySchemaVersion,
      protectedInput: item.nodeCommands.filter((name) => fixture.commandMetadata.protectedInput.includes(name)),
      resultKind: Object.fromEntries(item.nodeCommands.filter((name) => fixture.commandMetadata.resultKind[name]).map((name) => [name, fixture.commandMetadata.resultKind[name]])),
    })),
    ...overrides,
  };
}

test("browser manifest covers exactly every browser capability command", () => {
  const manifest = fixtureManifest();
  assert.deepEqual(browserCommandIds(manifest).sort(), fixture.nodeCommands.sort());
  const markup = renderCapabilitySurface(manifest);
  const ids = [...markup.matchAll(/data-command="([a-z0-9._-]+)"/g)].map(([, id]) => id);
  assert.deepEqual([...new Set(ids)].sort(), fixture.nodeCommands.sort());
  for (const forbidden of fixture.forbiddenCommands) assert.doesNotMatch(markup, new RegExp(forbidden.replaceAll(".", "\\.")));
});

test("published browser command schemas and UI metadata match immutable desktop definitions", () => {
  const manifest = buildCapabilityManifest();
  const definitions = desktopCommandDefinitions();
  for (const command of manifest.commands) {
    const definition = definitions.get(command.name);
    assert.ok(definition, command.name);
    assert.deepEqual(command.arguments, definition.arguments, command.name);
    assert.deepEqual(command.ui, definition.ui, command.name);
  }
});

test("schema-driven browser controls expose typed fields without command-name branching", () => {
  const manifest = buildCapabilityManifest();
  const markup = renderCapabilitySurface(manifest);
  assert.match(markup, /data-command="picker\.show-all"[\s\S]*data-argument="visible"[\s\S]*data-argument-type="boolean"/);
  assert.match(markup, /data-command="tool-result-aging\.ttl"[\s\S]*data-argument="days"[\s\S]*data-argument-type="integer\|null"/);
  assert.match(markup, /data-command="provider\.enable"[\s\S]*data-argument="provider"[\s\S]*data-argument-type="string"/);
  const model = readFileSync(path.join(root, "apps", "desktop", "ui", "model.mjs"), "utf8");
  assert.doesNotMatch(model, /name === "(?:vision\.engine|presence\.mode|tool-result-aging\.ttl)"/);
});

test("nullable integer controls keep the number field open and expose null as a separate off choice", () => {
  const manifest = buildCapabilityManifest();
  const markup = renderCapabilitySurface(manifest);
  assert.match(markup, /data-command="tool-result-aging\.ttl"[\s\S]*data-argument="days"[\s\S]*type="number"[\s\S]*min="0"[\s\S]*max="3650"/);
  assert.match(markup, /data-argument-null="days"[^>]*type="checkbox"/);
  assert.doesNotMatch(markup, /<select[^>]*data-argument="days"/);
  const source = readFileSync(path.join(root, "apps", "desktop", "ui", "app.js"), "utf8");
  assert.match(source, /field\.dataset\.argumentNull/);
  assert.match(source, /Number\(field\.value\)/);
});

test("tool-result-aging TTL accepts safe integer/default and null/off, rejects fraction and bounds", async () => {
  const definition = desktopCommandDefinitions().get("tool-result-aging.ttl");
  const run = (days) => runDesktopCommand("tool-result-aging.ttl", { days }, { execute: async (_command, args) => args });
  assert.deepEqual({ ...(await run(7)).value }, { days: 7 });
  assert.deepEqual({ ...(await run(null)).value }, { days: null });
  assert.equal((await run(1.5)).error.code, "invalid_command_arguments");
  assert.equal((await run(-1)).error.code, "invalid_command_arguments");
  assert.equal((await run(3651)).error.code, "invalid_command_arguments");
  assert.equal(definition.arguments.properties.days.minimum, 0);
  assert.equal(definition.arguments.properties.days.maximum, 3650);
});

test("every browser command generates schema-valid arguments for the canonical dispatcher", async () => {
  const manifest = buildCapabilityManifest();
  for (const command of browserCommandIds(manifest)) {
    const definition = desktopCommandDefinitions().get(command);
    const args = browserArgumentsForCommand(definition);
    const context = definition.protectedInput
      ? { protectedInput: async () => "test-protected-value" }
      : {};
    const result = await runDesktopCommand(command, args, definition.resultKind === "protected-text"
      ? trustedProtectedContext({ ...context, execute: async () => "protected result" })
      : { ...context, execute: async () => ({ ok: true }) });
    assert.equal(result.ok, true, `${command}: ${result.error?.code || "invalid"}`);
  }
});

test("browser JCS argument hashes match the Node session contract", async () => {
  const args = { z: "last", a: { n: 2, list: [true, null, "x"] } };
  assert.equal(await canonicalArgumentsHash(args), nodeCanonicalArgumentsHash(args));
  assert.equal(await canonicalArgumentsHash({ a: 1, b: 2 }), await canonicalArgumentsHash({ b: 2, a: 1 }));
});

test("browser operation state reuses one UUID and applies replayed results once", () => {
  const ids = ["11111111-1111-4111-8111-111111111111"];
  const state = createBrowserOperationState({ uuid: () => ids[0] });
  const operation = state.begin("presence.mode", { mode: "always" });
  assert.equal(operation.requestId, ids[0]);
  assert.equal(state.retry(operation.operationId).requestId, ids[0]);
  let effects = 0;
  assert.equal(state.apply(operation.operationId, { mode: "always" }, () => { effects += 1; }), true);
  assert.equal(state.apply(operation.operationId, { mode: "always" }, () => { effects += 1; }), false);
  assert.equal(effects, 1);
  assert.deepEqual(state.get(operation.operationId).result, { mode: "always" });
  const timedOut = state.begin("usage.router", {});
  assert.equal(state.timeout(timedOut.operationId), true);
  assert.equal(state.get(timedOut.operationId).status, "timed-out");
  assert.equal(state.retry(timedOut.operationId).requestId, timedOut.requestId);
});

test("unknown capability major renders read-only incompatibility with no actions", () => {
  const sections = visibleSections(fixtureManifest({ capabilitySchemaVersion: 99 }));
  assert.equal(sections.length, 1);
  assert.equal(sections[0].readOnly, true);
  assert.match(sections[0].title, /unsupported|incompatible|read-only/i);
  const markup = renderCapabilitySurface(fixtureManifest({ capabilitySchemaVersion: 99 }));
  assert.doesNotMatch(markup, /data-command=/);
  assert.doesNotMatch(markup, /button|input|select/i);
});

test("destructive, quota, and protected commands carry their manifest metadata", () => {
  const markup = renderCapabilitySurface(fixtureManifest());
  for (const command of fixture.commandMetadata.confirmation) {
    assert.match(markup, new RegExp(`data-command="${command.replaceAll(".", "\\.")}"[^>]*data-confirmation="server"`));
  }
  for (const command of fixture.commandMetadata.quotaWarning) {
    assert.match(markup, new RegExp(`data-command="${command.replaceAll(".", "\\.")}"[^>]*data-quota-warning="true"`));
  }
  for (const command of fixture.commandMetadata.protectedInput) {
    assert.match(markup, new RegExp(`data-command="${command.replaceAll(".", "\\.")}"[^>]*data-protected-input="true"`));
    assert.match(markup, /type="password"[^>]*autocomplete="off"/);
  }
  assert.match(markup, /protected-text/);
});

test("browser serialization strips secrets and session proofs recursively", () => {
  const state = {
    csrfToken: "csrf-decoy",
    apiKey: "key-decoy",
    nested: {
      authorization: "Bearer decoy",
      password: "password-decoy",
      visible: "keep",
    },
    array: [{ callerSecret: "secret-decoy", value: 3 }],
  };
  const serialized = serializeBrowserState(state);
  assert.deepEqual(serialized, { nested: { visible: "keep" }, array: [{ value: 3 }] });
  assert.doesNotMatch(JSON.stringify(serialized), /decoy/);
});

test("browser UI has no external resources or browser secret persistence APIs", () => {
  const source = uiFiles.join("\n");
  assert.doesNotMatch(source, /https?:\/\//i);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|indexedDB|history\.(?:pushState|replaceState))/i);
  assert.match(source, /autocomplete=["']off["']/i);
  assert.doesNotMatch(source, /window\.name|document\.referrer/i);
});

test("browser panel source keeps the session proof in memory and sends UUID mutations", () => {
  const source = readFileSync(path.join(root, "src", "desktop-panel.mjs"), "utf8");
  assert.match(source, /panel_session/);
  assert.match(source, /x-request-id/);
  assert.match(source, /x-confirmation-token/);
  assert.match(source, /argumentsHash/);
  assert.match(source, /attempt\+\+/);
  assert.match(source, /credentials: \"same-origin\"/);
  assert.match(source, /buildCapabilityManifest/);
});

test("browser static module graph has a panel asset route for every local import", () => {
  const entry = path.join(root, "apps", "desktop", "ui", "index.html");
  const visited = new Set();
  const files = new Map();
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    files.set(file, source);
    if (path.extname(file) === ".css") return;
    const specifiers = [
      ...source.matchAll(/from\s+["'](\.[^"']+)["']/g),
      ...source.matchAll(/(?:src|href)=["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (!specifier || /^[a-z]+:/i.test(specifier) || specifier.startsWith("#") || specifier === "favicon.ico") continue;
      const next = path.resolve(path.dirname(file), specifier);
      if (!next.startsWith(path.join(root, "apps", "desktop", "ui"))) continue;
      visit(next);
    }
  }
  visit(entry);
  for (const file of files.keys()) {
    if (path.extname(file) !== ".mjs" && path.extname(file) !== ".js") continue;
    const relative = path.relative(path.join(root, "apps", "desktop", "ui"), file).replaceAll("\\", "/");
    assert.match(readFileSync(path.join(root, "src", "desktop-panel.mjs"), "utf8"), new RegExp(`/panel/${relative.replaceAll(".", "\\.")}`), relative);
  }
});

test("browser protected results expose an ephemeral accessible copy action", () => {
  const markup = renderCapabilitySurface(buildCapabilityManifest());
  assert.match(markup, /data-protected-output="true"[^>]*style|data-protected-output="true"/);
  assert.match(markup, /data-copy-result="protected"/);
  assert.match(markup, /aria-label="Copy protected result"/);
  const source = uiFiles.join("\n");
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /:focus-visible/);
  assert.match(readFileSync(path.join(root, "apps", "desktop", "ui", "app.js"), "utf8"), /navigator\.clipboard|execCommand/);
});

test("browser source has no forbidden capability IDs or legacy action aliases", () => {
  const source = uiFiles.join("\n");
  for (const forbidden of fixture.forbiddenCommands) {
    assert.doesNotMatch(source, new RegExp(`(?:data-command|call|invoke|command)[^\\n]{0,80}${forbidden.replaceAll(".", "\\.")}`), forbidden);
  }
});
