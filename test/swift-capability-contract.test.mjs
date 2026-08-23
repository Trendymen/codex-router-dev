import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fixture from "./fixtures/required-capabilities.json" with { type: "json" };
import { buildCapabilityManifest } from "../src/capability-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swiftSource = [
  "apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift",
  "apps/macos/ModelRouterTray/Sources/Localization.swift",
].map((relative) => readFileSync(path.join(root, relative), "utf8")).join("\n");

function canonicalSwiftCommands(source) {
  const block = source.match(/canonicalCommandIDs:\s*\[String\]\s*=\s*\[(?<body>[\s\S]*?)\n\s*\]/);
  assert.ok(block, "Swift must publish one canonical command-id list");
  return [...block.groups.body.matchAll(/"([a-z0-9][a-z0-9._-]*)"/g)].map(([, id]) => id);
}

test("Swift source advertises exactly the independent capability command oracle", () => {
  assert.deepEqual(canonicalSwiftCommands(swiftSource).sort(), [...fixture.nodeCommands].sort());
  for (const forbidden of fixture.forbiddenCommands) {
    assert.doesNotMatch(swiftSource, new RegExp(forbidden.replaceAll(".", "\\.")), forbidden);
  }
});

test("Swift consumes the versioned snapshot and fails closed on unknown majors", () => {
  assert.match(swiftSource, /struct\s+CapabilitySnapshotV1\b/);
  assert.match(swiftSource, /capabilitySchemaVersion/);
  assert.match(swiftSource, /unknown_major_version/);
  assert.match(swiftSource, /mutationsEnabled/);
  assert.match(swiftSource, /readOnly/);
  assert.match(swiftSource, /only health and version|health.*version/is);
});

test("Swift command rows carry quota warnings, confirmations, and protected-input metadata", () => {
  assert.match(swiftSource, /quotaWarning/);
  assert.match(swiftSource, /confirmation/);
  assert.match(swiftSource, /Quota warning|quota warning/i);
  assert.match(swiftSource, /Confirm|confirmation/i);
  assert.match(swiftSource, /protectedInput/);
  assert.match(swiftSource, /SecureField/);
});

test("Swift decodes the stable Node error envelope and never persists credentials", () => {
  assert.match(swiftSource, /DesktopCommandEnvelope/);
  assert.match(swiftSource, /DesktopCommandError/);
  assert.match(swiftSource, /error\.code/);
  assert.match(swiftSource, /credential\.set/);
  assert.match(swiftSource, /protectedInput/);
  assert.doesNotMatch(swiftSource, /UserDefaults[^\n]*(?:credential|apiKey|secret|token)/i);
  assert.doesNotMatch(swiftSource, /arguments[^\n]*apiKey/i);
});

test("all Router mutations use the canonical Node bridge while Dynamic Island stays local", () => {
  assert.match(swiftSource, /DesktopCommandBridge/);
  assert.match(swiftSource, /executeCanonicalCommand/);
  assert.doesNotMatch(swiftSource, /runControl\s*\(/);
  assert.match(swiftSource, /islandModeKey/);
  assert.match(swiftSource, /resolveIslandMode/);
  assert.doesNotMatch(swiftSource, /dynamic[- ]?island[^\n]*(?:command|bridge)/i);
});

test("the Node bridge keeps protected input ephemeral and returns the canonical envelope", () => {
  const bridge = readFileSync(path.join(root, "src", "desktop-command-bridge.mjs"), "utf8");
  assert.match(bridge, /runDesktopCommand/);
  assert.match(bridge, /trustedProtectedContext/);
  assert.match(bridge, /protectedInput/);
  assert.match(bridge, /JSON\.stringify/);
  assert.doesNotMatch(bridge, /writeFile|appendFile|UserDefaults|localStorage/);
});

test("the published Node manifest keeps every capability available to Swift", () => {
  const manifest = buildCapabilityManifest();
  assert.equal(manifest.capabilitySchemaVersion, fixture.capabilitySchemaVersion);
  assert.ok(manifest.capabilities.every((capability) => capability.swift === "full"));
  assert.deepEqual(manifest.commands.map(({ name }) => name).sort(), [...fixture.nodeCommands].sort());
});
