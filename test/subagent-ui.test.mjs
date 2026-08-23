import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("desktop subagent settings show native and unverified enabled models", () => {
  const source = readFileSync(path.join(root, "apps", "desktop", "ui", "app.js"), "utf8");
  assert.match(source, /const subagentModels = enabledModels;/);
  assert.doesNotMatch(source, /!model\.native\s*&&\s*model\.visible/);
  assert.match(source, /selectedSubagents\.has\(model\.slug\)/);
});

test("macOS subagent settings are rendered from the shared capability manifest", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /CapabilitySnapshotV1/);
  assert.match(source, /capability\.nodeCommands\.compactMap\(store\.capabilitySnapshot\.command\)/);
  assert.match(source, /CapabilityCommandRow/);
  assert.doesNotMatch(source, /subagentModels|selectedSubagentSet/);
});
