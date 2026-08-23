import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveServiceTarget } from "../src/service-target.mjs";
import { ownedRuntimePaths, restoreOwnedRuntime, snapshotOwnedRuntime } from "../src/owned-runtime-paths.mjs";
import { migrateRuntime } from "../src/runtime-migration.mjs";
import { runRuntimeMigration, verifySwiftCommandContract } from "../src/update.mjs";
import { buildCapabilityManifest } from "../src/capability-manifest.mjs";

const snapshot = Object.freeze({ version: 1, entries: Object.freeze({}) });

test("migration commits only after install and every replacement contract passes", async () => {
  const events = [];
  const result = await migrateRuntime({
    snapshot,
    installReplacement: async () => events.push("install"),
    bootstrapReplacement: async () => events.push("bootstrap"),
    verifyRouterHealth: async () => events.push("health"),
    verifyBrowserContract: async () => events.push("browser"),
    verifySwiftContract: async () => events.push("swift"),
    publishReplacement: async () => events.push("publish"),
    cleanupOld: async () => events.push("cleanup"),
    restoreSnapshot: async () => events.push("restore"),
    restartOldService: async () => events.push("restart-old"),
  });
  assert.deepEqual(events, ["install", "bootstrap", "health", "browser", "swift", "publish", "cleanup"]);
  assert.deepEqual(result, { ok: true, cleaned: true });
});

test("every replacement failure restores first, restarts the old service, skips cleanup, and rethrows identity", async () => {
  const failures = [
    ["install", "installReplacement"],
    ["bootstrap", "bootstrapReplacement"],
    ["health", "verifyRouterHealth"],
    ["browser", "verifyBrowserContract"],
    ["swift", "verifySwiftContract"],
    ["publish", "publishReplacement"],
  ];
  for (const [label, operation] of failures) {
    const events = [];
    const primary = new Error(`${label}-failure`);
    const steps = {
      snapshot,
      installReplacement: async () => {
        events.push("install");
        if (operation === "installReplacement") throw primary;
      },
      bootstrapReplacement: async () => {
        events.push("bootstrap");
        if (operation === "bootstrapReplacement") throw primary;
      },
      verifyRouterHealth: async () => {
        events.push("health");
        if (operation === "verifyRouterHealth") throw primary;
      },
      verifyBrowserContract: async () => {
        events.push("browser");
        if (operation === "verifyBrowserContract") throw primary;
      },
      verifySwiftContract: async () => {
        events.push("swift");
        if (operation === "verifySwiftContract") throw primary;
      },
      publishReplacement: async () => {
        events.push("publish");
        if (operation === "publishReplacement") throw primary;
      },
      cleanupOld: async () => events.push("cleanup"),
      restoreSnapshot: async () => events.push("restore"),
      restartOldService: async () => events.push("restart-old"),
    };
    await assert.rejects(migrateRuntime(steps), (error) => error === primary, label);
    assert.equal(events.at(-2), "restore", label);
    assert.equal(events.at(-1), "restart-old", label);
    assert.equal(events.includes("cleanup"), false, label);
  }
});

test("real replacement tree is restored for every failure boundary without residue or cleanup", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-matrix-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: process.platform,
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-matrix-test",
    trayLabel: "com.example.codex-router-matrix-test.tray",
    ports: { oauth: 46301, router: 46302, api: 46303, grokOauth: 46308, devinCli: 46310 },
  });
  try {
    const paths = ownedRuntimePaths(target, {
      userHome: root,
      codexHome: root,
      dshHome: path.join(root, "dsh"),
      geminiHome: path.join(root, "gemini"),
    });
    const oldFile = path.join(target.appPath, "Contents", "Resources", "old.txt");
    mkdirSync(path.dirname(oldFile), { recursive: true });
    writeFileSync(oldFile, "old tree\n", { mode: 0o640 });
    const snapshot = snapshotOwnedRuntime(paths);
    const failures = ["install", "bootstrap", "health", "browser", "swift", "publish"];
    for (const boundary of failures) {
      let cleanupCalls = 0;
      const events = [];
      const primary = new Error(`${boundary} boundary failed`);
      const step = (name) => async () => {
        events.push(name);
        if (name === boundary) {
          writeFileSync(path.join(target.appPath, "replacement-residue.txt"), "new\n");
          throw primary;
        }
      };
      await assert.rejects(migrateRuntime({
        snapshot,
        installReplacement: step("install"),
        bootstrapReplacement: step("bootstrap"),
        verifyRouterHealth: step("health"),
        verifyBrowserContract: step("browser"),
        verifySwiftContract: step("swift"),
        publishReplacement: step("publish"),
        cleanupOld: async () => { cleanupCalls += 1; },
        restoreSnapshot: async () => { events.push("restore"); restoreOwnedRuntime(snapshot); },
        restartOldService: async () => events.push("restart-old"),
      }), (error) => error === primary);
      assert.equal(cleanupCalls, 0, boundary);
      assert.deepEqual(readFileSync(oldFile), Buffer.from("old tree\n"), boundary);
      assert.equal(existsSync(path.join(target.appPath, "replacement-residue.txt")), false, boundary);
      assert.deepEqual(events.slice(-2), ["restore", "restart-old"], boundary);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rollback errors remain visible without replacing the primary failure", async () => {
  const primary = new Error("health failed");
  const rollback = new Error("restore failed");
  await assert.rejects(
    migrateRuntime({
      snapshot,
      installReplacement: async () => {},
      verifyRouterHealth: async () => { throw primary; },
      restoreSnapshot: async () => { throw rollback; },
      restartOldService: async () => {},
      cleanupOld: async () => {},
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1], rollback);
      return true;
    },
  );
});

test("Swift verifier runs the built-app probe and rejects a mismatched command manifest", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-swift-probe-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: "darwin",
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-swift-test",
    trayLabel: "com.example.codex-router-swift-test.tray",
    ports: { oauth: 46401, router: 46402, api: 46403, grokOauth: 46408, devinCli: 46410 },
  });
  try {
    const manifest = buildCapabilityManifest();
    const files = new Map([
      ["ModelRouterTrayApp.swift", "capabilitySchemaVersion executeCanonicalCommand("],
      ["desktop-command-bridge.mjs", "DesktopCommandBridge"],
    ]);
    const run = () => ({ status: 0, stdout: JSON.stringify({ ok: true, value: { capabilityManifest: manifest } }), stderr: "" });
    assert.deepEqual(verifySwiftCommandContract(target, {
      exists: () => true,
      read: (file) => files.get(path.basename(file)) || "",
      run,
    }), { ok: true });
    assert.throws(() => verifySwiftCommandContract(target, {
      exists: () => true,
      read: (file) => files.get(path.basename(file)) || "",
      run: () => ({ status: 0, stdout: JSON.stringify({ ok: true, value: { capabilityManifest: { ...manifest, commands: [] } } }), stderr: "" }),
    }), /different command set|incompatible/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public runtime migration binds explicit runtime roots to its snapshot", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-roots-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: process.platform,
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-roots-test",
    trayLabel: "com.example.codex-router-roots-test.tray",
    ports: { oauth: 46501, router: 46502, api: 46503, grokOauth: 46508, devinCli: 46510 },
  });
  const runtimeRoots = { userHome: root, codexHome: root, dshHome: path.join(root, "dsh"), geminiHome: path.join(root, "gemini") };
  try {
    const paths = ownedRuntimePaths(target, runtimeRoots);
    const snapshot = snapshotOwnedRuntime(paths);
    const events = [];
    await runRuntimeMigration({
      target,
      runtimeRoots,
      snapshot,
      installReplacement: async () => events.push("install"),
      verifyReplacement: async () => events.push("verify"),
      publishReplacement: async () => events.push("publish"),
      cleanupOld: async () => events.push("cleanup"),
      restoreSnapshot: async () => events.push("restore"),
      restartOldService: async () => events.push("restart"),
    });
    assert.deepEqual(events, ["install", "verify", "publish", "cleanup"]);
    await assert.rejects(
      runRuntimeMigration({
        target,
        runtimeRoots: { ...runtimeRoots, dshHome: path.join(root, "other-dsh") },
        snapshot,
        installReplacement: async () => {},
      }),
      /different ServiceTarget|runtime roots|snapshot/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
