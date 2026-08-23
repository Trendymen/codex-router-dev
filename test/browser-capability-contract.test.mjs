import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fixture from "./fixtures/required-capabilities.json" with { type: "json" };
import {
  browserCommandIds,
  renderCapabilitySurface,
  serializeBrowserState,
  visibleSections,
} from "../apps/desktop/ui/model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiFiles = ["index.html", "app.js", "model.mjs", "styles.css"].map((name) =>
  readFileSync(path.join(root, "apps", "desktop", "ui", name), "utf8"),
);

function fixtureManifest(overrides = {}) {
  const commandMetadata = new Map(
    fixture.nodeCommands.map((name) => [name, {
      name,
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
  assert.match(source, /credentials: \"same-origin\"/);
  assert.match(source, /buildCapabilityManifest/);
});

test("browser source has no forbidden capability IDs or legacy action aliases", () => {
  const source = uiFiles.join("\n");
  for (const forbidden of fixture.forbiddenCommands) {
    assert.doesNotMatch(source, new RegExp(`(?:data-command|call|invoke|command)[^\\n]{0,80}${forbidden.replaceAll(".", "\\.")}`), forbidden);
  }
});
