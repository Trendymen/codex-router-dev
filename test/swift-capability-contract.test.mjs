import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import fixture from "./fixtures/required-capabilities.json" with { type: "json" };
import { buildCapabilityManifest } from "../src/capability-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function normalizeSwiftSource(source) {
  return source.replace(/\r\n?/g, "\n");
}

function readSwiftSource(filePath) {
  return normalizeSwiftSource(readFileSync(filePath, "utf8"));
}

const swiftSource = readSwiftSource(path.join(root, "apps/macos/ModelRouterTray/Sources/ModelRouterTrayApp.swift"));
const quotaResetTests = readSwiftSource(path.join(root, "apps/macos/ModelRouterTray/Tests/QuotaResetLabelTests.swift"));
const bridgeSource = readFileSync(path.join(root, "src", "desktop-command-bridge.mjs"), "utf8");
const controlSource = readFileSync(path.join(root, "src", "control.mjs"), "utf8");
const localizationSources = [
  "Localization.swift",
  "RouterArabicText.swift",
  "RouterHindiText.swift",
  "RouterJapaneseText.swift",
  "RouterKoreanText.swift",
].map((name) => readSwiftSource(path.join(root, "apps/macos/ModelRouterTray/Sources", name)));

test("Swift source contract normalizes all supported line endings before matching", () => {
  assert.equal(normalizeSwiftSource("first\r\nsecond\rthird\nfourth"), "first\nsecond\nthird\nfourth");
});

function runBridge(command, payload, extraEnv = {}) {
  const bridge = path.join(root, "src", "desktop-command-bridge.mjs");
  const env = { ...process.env, PATH: path.join(root, "does-not-exist"), MODEL_ROUTER_SOURCE_ROOT: path.join(root, "decoy") , ...extraEnv };
  const result = spawnSync(process.execPath, [bridge, command], {
    cwd: root,
    env,
    input: payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  let envelope;
  try { envelope = JSON.parse(result.stdout); } catch { envelope = undefined; }
  return { ...result, envelope };
}

test("Swift renders the real swift capability set through manifest expressions", () => {
  const manifest = buildCapabilityManifest();
  const swiftCommands = manifest.capabilities.filter(({ swift }) => swift === "full").flatMap(({ nodeCommands }) => nodeCommands);
  assert.deepEqual([...new Set(swiftCommands)].sort(), [...fixture.nodeCommands].sort());
  assert.match(swiftSource, /ForEach\(capability\.nodeCommands\.compactMap\(store\.capabilitySnapshot\.command\)/);
  assert.match(swiftSource, /CapabilityCommandRow\(store: store, command: command\)/);
  assert.match(swiftSource, /executeCanonicalCommand\(command\.name/);
  assert.match(swiftSource, /routerLocalized\(command\.ui\.localizationKey\)/);
  assert.match(swiftSource, /command\.ui\.fields/);
  assert.match(swiftSource, /routerLocalized\(presentation\.localizationKey\)/);
  for (const forbidden of fixture.forbiddenCommands) {
    assert.doesNotMatch(swiftSource, new RegExp(forbidden.replaceAll(".", "\\.")), forbidden);
  }
});

test("the real Node manifest encodes Swift-decodable boolean metadata", () => {
  const encoded = JSON.stringify(buildCapabilityManifest({ capabilitySchemaVersion: 1 }));
  const manifest = JSON.parse(encoded);
  assert.equal(manifest.capabilitySchemaVersion, 1);
  assert.ok(manifest.commands.length > 0);
  for (const capability of manifest.capabilities) assert.match(capability.localizationKey, /^capability\.[a-z0-9-]+$/);
  for (const command of manifest.commands) {
    assert.equal(typeof command.confirmation, "boolean", command.name);
    assert.equal(typeof command.quotaWarning, "boolean", command.name);
    assert.equal(typeof command.protectedInput, "boolean", command.name);
    assert.equal(typeof command.ui.title, "string", command.name);
    assert.match(command.ui.localizationKey, /^command\.[a-z0-9._-]+$/, command.name);
    for (const field of Object.values(command.ui.fields)) {
      assert.equal(typeof field.label, "string", command.name);
      assert.match(field.localizationKey, /^field\.[A-Za-z0-9-]+$/, command.name);
    }
  }
  assert.deepEqual(
    manifest.commands.map(({ name, ui }) => ui.localizationKey).sort(),
    fixture.nodeCommands.map((name) => `command.${name}`).sort(),
  );
  assert.match(swiftSource, /decodeIfPresent\(Bool\.self, forKey: \.confirmation\)/);
  assert.match(swiftSource, /decodeIfPresent\(Bool\.self, forKey: \.quotaWarning\)/);
  assert.match(swiftSource, /struct\s+CapabilityUI\b/);
});

test("unknown and invalid capability majors retain only a minimal health/version envelope", () => {
  assert.match(swiftSource, /struct\s+HealthVersionEnvelope\b/);
  assert.match(swiftSource, /try\? values\.decode\(Int\.self, forKey: \.capabilitySchemaVersion\)/);
  assert.match(swiftSource, /clearCapabilityState\(\)/);
  assert.match(swiftSource, /capabilitySnapshot = CapabilitySnapshotV1\.empty/);
  assert.match(swiftSource, /healthVersion\.health/);
  assert.match(swiftSource, /healthVersion\.version/);
  assert.match(swiftSource, /Only health and version information/is);
  const unknown = buildCapabilityManifest({ capabilitySchemaVersion: 99 });
  assert.equal(unknown.mutationsEnabled, false);
  assert.deepEqual(unknown.commands, []);
  assert.match(swiftSource, /commandResult = nil/);
  assert.match(swiftSource, /capabilitySnapshot = CapabilitySnapshotV1\(\n\s+capabilitySchemaVersion: reported/);
});

test("CapabilitySnapshotV1 declares the complete keyed decoding contract", () => {
  const start = swiftSource.indexOf("struct CapabilitySnapshotV1");
  const end = swiftSource.indexOf("// This envelope intentionally", start);
  assert.ok(start >= 0 && end > start, "CapabilitySnapshotV1 source is present");
  const source = swiftSource.slice(start, end);
  const codingKeys = source.match(/private enum CodingKeys: String, CodingKey \{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.deepEqual(
    [...codingKeys.matchAll(/\bcase\s+([A-Za-z_]\w*)/g)].map(([, key]) => key),
    ["capabilitySchemaVersion", "compatibility", "mutationsEnabled", "commands", "capabilities"],
  );
});

test("the Swift command bridge zeroizes initialized input bytes before releasing them", () => {
  const start = swiftSource.indexOf("private static func zeroize");
  const end = swiftSource.indexOf("private static func isEnvelope", start);
  assert.ok(start >= 0 && end > start, "zeroize helper is present");
  const source = swiftSource.slice(start, end);
  assert.match(source, /guard let baseAddress = buffer\.baseAddress else \{ return \}/);
  assert.match(source, /Darwin\.memset\(baseAddress, 0, buffer\.count\)/);
  assert.doesNotMatch(source, /buffer\.initialize\(/);
});

test("quota reset captions accept an injected clock and preserve the current format", () => {
  const start = swiftSource.indexOf("func usageResetCaption");
  const end = swiftSource.indexOf("func compactTokenCount", start);
  assert.ok(start >= 0 && end > start, "usageResetCaption source is present");
  const source = swiftSource.slice(start, end);
  assert.match(
    source,
    /func usageResetCaption\(\s*_ date: Date,\s*now: Date = Date\(\),\s*localize: \(String\) -> String = routerLocalized\s*\)/,
  );
  assert.match(source, /date\.timeIntervalSince\(now\)/);
  assert.match(source, /date\.formatted\(date: \.abbreviated, time: \.shortened\)/);
  assert.match(
    quotaResetTests,
    /usageResetCaption\(\s*now\.addingTimeInterval\(-5\),\s*now: now,\s*localize:/,
  );
  assert.match(quotaResetTests, /usageResetCaption\(\s*reset,\s*now: now,\s*localize:/);
  assert.doesNotMatch(quotaResetTests, /resetCountdownLabel|resetClockLabel/);
  assert.doesNotMatch(quotaResetTests, /RouterLanguage\.(?:selection|setSelection)/);
});

test("all Router mutations use the canonical Node bridge and observed schema version", () => {
  assert.match(swiftSource, /DesktopCommandBridge/);
  assert.match(swiftSource, /capabilitySchemaVersion: capabilitySnapshot\.capabilitySchemaVersion/);
  assert.match(bridgeSource, /manifest: \{ capabilitySchemaVersion: suppliedVersion \}/);
  assert.doesNotMatch(swiftSource, /runControl\s*\(/);
  assert.match(swiftSource, /islandModeKey/);
  assert.match(swiftSource, /resolveIslandMode/);
  assert.doesNotMatch(swiftSource, /dynamic[- ]?island[^\n]*(?:command|bridge)/i);
});

test("absolute Node execution rejects PATH/source-root redirects and validates ownership", () => {
  assert.match(swiftSource, /CODEX_ROUTER_NODE_BIN/);
  assert.match(swiftSource, /ownerAccountID/);
  assert.match(swiftSource, /isExecutableFile/);
  assert.match(swiftSource, /process\.executableURL = node/);
  assert.doesNotMatch(swiftSource, /\/usr\/bin\/env/);
  assert.doesNotMatch(swiftSource, /MODEL_ROUTER_SOURCE_ROOT/);
  assert.match(bridgeSource, /BRIDGE_ROOT/);
  assert.doesNotMatch(bridgeSource, /sourceRoot\(\)/);
});

test("Node process I/O drains both streams, bounds output, times out, and preserves envelopes", () => {
  assert.match(swiftSource, /boundedRead/);
  assert.match(swiftSource, /standardError = stderr/);
  assert.match(swiftSource, /outputLimit/);
  assert.match(swiftSource, /commandTimeout/);
  assert.match(swiftSource, /terminationHandler/);
  assert.match(swiftSource, /terminationGrace/);
  assert.match(swiftSource, /SIGKILL/);
  assert.match(swiftSource, /withTaskCancellationHandler/);
  assert.match(swiftSource, /ProcessCompletion/);
  assert.match(swiftSource, /completion\.isCompleted/);
  assert.match(swiftSource, /completion\.fail\(\.cancelled\)/);
  assert.match(swiftSource, /case BridgeFailure\.cancelled = error/);
  assert.match(swiftSource, /try\? await Task\.sleep\(for: \.seconds\(Self\.terminationGraceSeconds\)\)/);
  assert.doesNotMatch(swiftSource, /Thread\.sleep\(/);
  assert.doesNotMatch(swiftSource, /withThrowingTaskGroup/);
  assert.doesNotMatch(swiftSource, /statusTask/);
  assert.match(swiftSource, /process\.processIdentifier/);
  assert.doesNotMatch(swiftSource, /waitUntilExit\(\)/);
  assert.match(swiftSource, /process\.terminate\(\)/);
  assert.match(swiftSource, /stdoutReader/);
  assert.match(swiftSource, /stderrReader/);
  const malformed = runBridge("lifecycle.status", "{");
  assert.equal(malformed.envelope?.ok, false);
  assert.equal(malformed.envelope?.error?.code, "invalid_command_arguments");
  assert.notEqual(malformed.status, 0);
  const nullRequest = runBridge("lifecycle.status", "null");
  assert.equal(nullRequest.envelope?.ok, true);
});

test("lifecycle status uses the Node-owned service state and nested live activity snapshot", () => {
  assert.match(controlSource, /serviceStatus/);
  assert.match(controlSource, /loaded/);
  assert.match(controlSource, /const unavailable = \{ state: "starting", activeCount: 0, active: \[\] \}/);
  assert.doesNotMatch(controlSource, /catch \{\s*return \{ state: "idle", activeCount: 0, active: \[\] \}/);
  assert.doesNotMatch(controlSource, /const service = \{ running: Boolean\(targets\.codex\?\.active\) \}/);
  assert.match(swiftSource, /object\["activity"\]/);
  assert.doesNotMatch(swiftSource, /if case let \.some\(\.string\(state\)\) = object\["state"\]/);
  const status = runBridge("lifecycle.status", { args: {}, capabilitySchemaVersion: 1 });
  assert.equal(status.envelope?.ok, true, status.stderr);
  assert.equal(typeof status.envelope.value.activity?.activeCount, "number");
  assert.ok(Array.isArray(status.envelope.value.activity?.active));
});

test("bridge passes schema versions, ignores hostile environment redirects, and never echoes protected input", () => {
  const unsupported = runBridge("presence.mode", {
    args: { mode: "always" },
    capabilitySchemaVersion: 99,
  });
  assert.equal(unsupported.envelope?.ok, false);
  assert.equal(unsupported.envelope?.error?.code, "capability_schema_unsupported");

  const secret = "swift-secret-decoy-4e4a";
  const protectedInput = runBridge("credential.set", {
    args: { provider: "deepseek", apiKey: secret },
    capabilitySchemaVersion: 1,
    protectedInput: secret,
  });
  assert.equal(protectedInput.envelope?.ok, false);
  assert.equal(protectedInput.envelope?.error?.code, "protected_input_required");
  assert.doesNotMatch(protectedInput.stdout, new RegExp(secret));
  assert.doesNotMatch(protectedInput.stderr, new RegExp(secret));

  const oversized = runBridge("lifecycle.status", "x".repeat(256 * 1024 + 1));
  assert.equal(oversized.envelope?.ok, false);
  assert.equal(oversized.envelope?.error?.code, "invalid_command_arguments");
});

test("real lifecycle.status keeps bounded targets, presence, health/version, and the complete capability manifest", () => {
  const status = runBridge("lifecycle.status", { args: {}, capabilitySchemaVersion: 1 });
  assert.equal(status.envelope?.ok, true, status.stderr);
  const value = status.envelope.value;
  assert.ok(value && typeof value === "object");
  assert.ok(value.targets && typeof value.targets === "object");
  assert.ok(value.service && typeof value.service === "object");
  assert.equal(typeof value.service.running, "boolean");
  assert.ok(value.presence && typeof value.presence === "object");
  assert.ok(value.activity && typeof value.activity === "object");
  assert.equal(typeof value.activity.activeCount, "number");
  assert.ok(value.capabilities && typeof value.capabilities === "object");
  assert.equal(value.capabilities.capabilitySchemaVersion, 1);
  assert.equal(value.capabilities.commands.length, fixture.nodeCommands.length);
  assert.deepEqual(value.capabilities.commands.map(({ name }) => name).sort(), [...fixture.nodeCommands].sort());
  assert.ok(value.capabilities.commands.every(({ confirmation, quotaWarning, ui }) => typeof confirmation === "boolean" && typeof quotaWarning === "boolean" && typeof ui?.title === "string"));
  assert.equal(typeof value.health, "string");
  assert.equal(typeof value.version, "string");
  assert.doesNotMatch(JSON.stringify(value), /(?:DIRECT_SECRET|test-(?:internal|router)-|Bearer\s+[A-Za-z0-9._~+/=-]+)/i);
});

test("result kind/status/error and ephemeral protected output are rendered accessibly", () => {
  assert.match(swiftSource, /@Published private\(set\) var commandResult/);
  assert.match(swiftSource, /result\.resultKind/);
  assert.match(swiftSource, /result\.error/);
  assert.match(swiftSource, /textSelection\(\.enabled\)/);
  assert.match(swiftSource, /Copy protected result/);
  assert.match(swiftSource, /clearCommandResult\(\)/);
  assert.match(swiftSource, /onDisappear \{ store\.clearCommandResult\(\) \}/);
  assert.doesNotMatch(swiftSource, /UserDefaults[^\n]*(?:credential|apiKey|secret|token)/i);
  assert.doesNotMatch(swiftSource, /arguments[^\n]*apiKey/i);
});

test("status/activity/usage polling is cancellable and host observation rechecks absence", () => {
  assert.match(swiftSource, /statusPollingTask/);
  assert.match(swiftSource, /activityPollingTask/);
  assert.match(swiftSource, /Task\.isCancelled/);
  assert.match(swiftSource, /NSWorkspace\.shared\.notificationCenter/);
  assert.match(swiftSource, /hostProcessNames/);
  assert.match(swiftSource, /executeCanonicalCommand\("presence\.status"/);
  assert.match(swiftSource, /hostAppAbsenceGrace = Duration\.seconds\(30\)/);
  assert.match(swiftSource, /hostAppRecheckInterval = Duration\.seconds\(5\)/);
  assert.match(swiftSource, /activeRequestCount == 0 && activityState == \.idle/);
  assert.match(swiftSource, /runServiceCommand\("stop"\)/);
  assert.match(swiftSource, /presenceMode = TrayPresenceMode\.fromNode/);
  assert.match(swiftSource, /routerPinsServiceOn = presence\.harnessPublished/);
  assert.match(swiftSource, /activeRequests = activity\.active/);
  assert.match(swiftSource, /activeRequestCount = activity\.activeCount/);
  assert.doesNotMatch(swiftSource, /presenceModeKey/);
  assert.match(swiftSource, /serviceIntent == \.stoppedByTray/);
  assert.match(swiftSource, /enqueueServiceAction\(\.start\)/);
  assert.match(swiftSource, /performServiceAction\(_ action: ServiceAction\)/);
  assert.match(swiftSource, /executeCanonicalCommand\(action\.commandName, recordResult: true\)/);
  assert.doesNotMatch(swiftSource, /recordServiceOutcome/);
  assert.match(swiftSource, /var shouldRestoreServiceOnTermination: Bool/);
  assert.match(swiftSource, /serviceRunning = direct/);
  assert.match(swiftSource, /if effectivePresenceMode == \.followCodex, processRunning, serviceRestoreOwnership, serviceIntent != \.running/);
  assert.match(swiftSource, /await self\.refreshHostAppRunning\(\)/);
  assert.match(swiftSource, /guard !Task\.isCancelled, effectivePresenceMode == \.followCodex, !hostAppRunning/);
  assert.match(swiftSource, /prepareForTermination\(\)/);
  assert.match(swiftSource, /stoppedByTray/);
  assert.doesNotMatch(swiftSource, /serviceIntent = serviceRunning \? \.running : \.stopped/);
  assert.doesNotMatch(swiftSource, /private func clearCapabilityState\(\)[\s\S]*?serviceIntent = \.unknown/);
});

test("service reconciliation serializes host reappearance and uses AppKit termination handshake", () => {
  assert.match(swiftSource, /startingByTray/);
  assert.match(swiftSource, /stoppingByTray/);
  assert.match(swiftSource, /serviceOperationTask/);
  assert.match(swiftSource, /serviceRequestedAction/);
  assert.match(swiftSource, /serviceIntent = action\.isStarting \? \.startingByTray : \.stoppingByTray/);
  assert.ok(swiftSource.indexOf("serviceIntent = action.isStarting") < swiftSource.indexOf("serviceOperationTask = operation"));
  assert.match(swiftSource, /applicationShouldTerminate\(_ sender: NSApplication\) -> NSApplication\.TerminateReply/);
  assert.match(swiftSource, /\.terminateLater/);
  assert.match(swiftSource, /NSApp\.reply\(toApplicationShouldTerminate:/);
  assert.doesNotMatch(swiftSource, /func applicationWillTerminate\([^)]*\)[\s\S]*?Task \{/);
  assert.match(swiftSource, /terminationRestoreTimeout = Duration\.seconds\(10\)/);

  // Keep a small independent transition oracle here so the source assertions
  // are paired with the behavior the tray state machine promises. Repeated
  // host-present events while a start is in flight must be idempotent, and a
  // failed restore keeps ownership so the next termination can retry.
  const transition = (state, event) => {
    if (event === "host-present" && state === "stoppedByTray") return "startingByTray";
    if (event === "host-present" && state === "startingByTray") return "startingByTray";
    if (event === "start-succeeded") return "running";
    if (event === "start-failed" && state === "startingByTray") return "stoppedByTray";
    if (event === "host-absent" && state === "running") return "stoppingByTray";
    if (event === "stop-succeeded") return "stoppedByTray";
    if (event === "stop-failed" && state === "stoppingByTray") return "unknown";
    return state;
  };
  assert.equal(transition(transition("stoppedByTray", "host-present"), "host-present"), "startingByTray");
  assert.equal(transition(transition("stoppedByTray", "host-present"), "start-succeeded"), "running");
  assert.equal(transition(transition("stoppedByTray", "host-present"), "start-failed"), "stoppedByTray");
  assert.equal(transition(transition("running", "host-absent"), "stop-succeeded"), "stoppedByTray");
});

test("all localized capability literals keep exact key parity across language tables", () => {
  const keySet = (source) => new Set([...source.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"/gm)].map(([, key]) => key));
  const reference = keySet(localizationSources[0]);
  const critical = [
    "Quota warning",
    "Enter credential for this one-time operation",
    "Confirm and run",
    "Run",
    "Confirm this Router operation?",
    "This operation may consume provider quota. Check the provider plan before continuing.",
    "This action may use quota.",
    "The Router will apply this change.",
    "Refresh after updating the Router.",
    "Only health and version information is available for this Router capability version.",
    "Health: %@",
    "Version: %@",
  ];
  const english = new Map([...localizationSources[0].matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/gm)].map(([, key, value]) => [key, value]));
  for (const [index, source] of localizationSources.slice(1).entries()) {
    assert.deepEqual(keySet(source), reference, `language table ${index + 1} drifted`);
    const values = new Map([...source.matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)"/gm)].map(([, key, value]) => [key, value]));
    for (const key of [...reference].filter((value) => value.startsWith("capability.") || value.startsWith("field.") || value.startsWith("command."))) {
      assert.notEqual(values.get(key), key, `language table ${index + 1} left ${key} untranslated`);
    }
    for (const key of critical) assert.notEqual(values.get(key), english.get(key), `language table ${index + 1} left ${key} in English`);
  }
  const manifestCommandKeys = buildCapabilityManifest().commands.map(({ ui }) => ui.localizationKey);
  assert.equal(new Set(manifestCommandKeys).size, manifestCommandKeys.length, "manifest command localization keys must be unique");
  for (const source of localizationSources) {
    for (const key of manifestCommandKeys) {
      const escapedKey = key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      const occurrences = [...source.matchAll(new RegExp(`^\\s*"${escapedKey}":`, "gm"))].length;
      assert.equal(occurrences, 1, `${key} must occur exactly once in each language table`);
    }
  }
});

test("host process source contract keeps the executable-name helper used by Swift tests", () => {
  const source = readSwiftSource(path.join(root, "apps/macos/ModelRouterTray/Tests/HostProcessDetectionTests.swift"));
  assert.match(source, /anyProcessRunning/);
  assert.match(source, /hostProcessNames/);
  assert.match(swiftSource, /nonisolated static func anyProcessRunning/);
});

test("the published Node manifest keeps every capability available to Swift", () => {
  const manifest = buildCapabilityManifest();
  assert.equal(manifest.capabilitySchemaVersion, fixture.capabilitySchemaVersion);
  assert.ok(manifest.capabilities.every((capability) => capability.swift === "full"));
  assert.deepEqual(manifest.commands.map(({ name }) => name).sort(), [...fixture.nodeCommands].sort());
});
