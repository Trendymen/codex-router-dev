import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveServiceTarget } from "../src/service-target.mjs";
import { ownedRuntimePaths, restoreOwnedRuntime, snapshotOwnedRuntime } from "../src/owned-runtime-paths.mjs";
import { migrateRuntime } from "../src/runtime-migration.mjs";
import { runRuntimeMigration, verifySwiftCommandContract } from "../src/update.mjs";
import { buildCapabilityManifest } from "../src/capability-manifest.mjs";
import { withCatalogPublicationLock } from "../src/catalog-publication-lock.mjs";

const snapshot = Object.freeze({ version: 1, entries: Object.freeze({}) });
const MANAGED_CATALOG_FILES = [
  "merged-models.json", "routed-models.json", "node-routes.json",
  "control-models.json", "swift-models.json", "browser-models.json",
];

function installManagedCatalogTopology(target, label) {
  const generations = path.join(target.stateRoot, "catalog-generations");
  const generation = `generation-${label}`;
  const directory = path.join(generations, generation);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of MANAGED_CATALOG_FILES) {
    writeFileSync(path.join(directory, name), `${name}:${label}\n`, { mode: 0o600 });
    chmodSync(path.join(directory, name), 0o600);
  }
  symlinkSync(generation, path.join(generations, "current"), "dir");
  for (const name of MANAGED_CATALOG_FILES) {
    symlinkSync(`catalog-generations/current/${name}`, path.join(target.stateRoot, name), "file");
  }
}

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

test("migration preserves its primary failure when managed catalog restore refuses a tampered topology", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-catalog-migration-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: process.platform,
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-catalog-migration",
    trayLabel: "com.example.codex-router-catalog-migration.tray",
    ports: { oauth: 46421, router: 46422, api: 46423, grokOauth: 46428, devinCli: 46430 },
  });
  try {
    mkdirSync(target.stateRoot, { recursive: true });
    installManagedCatalogTopology(target, "migration");
    const runtimeRoots = { userHome: root, codexHome: root, dshHome: path.join(root, "dsh"), geminiHome: path.join(root, "gemini") };
    const saved = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    const stable = path.join(target.stateRoot, "merged-models.json");
    rmSync(stable, { force: true });
    symlinkSync("catalog-generations/current/routed-models.json", stable, "file");
    const primary = new Error("health failed");
    await assert.rejects(migrateRuntime({
      snapshot: saved,
      verifyRouterHealth: async () => { throw primary; },
      restoreSnapshot: async (value) => restoreOwnedRuntime(value),
      restartOldService: async () => {},
    }), (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0], primary);
      assert.match(String(error.errors[1]), /catalog|topology|link|target/i);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      preflight: async () => events.push("preflight"),
      installReplacement: async () => events.push("install"),
      verifyReplacement: async () => events.push("verify"),
      publishReplacement: async () => events.push("publish"),
      cleanupOld: async () => events.push("cleanup"),
      restoreSnapshot: async () => events.push("restore"),
      restartOldService: async () => events.push("restart"),
    });
    assert.deepEqual(events, ["preflight", "install", "verify", "publish", "cleanup"]);
    const reorderedRuntimeRoots = {
      geminiHome: runtimeRoots.geminiHome,
      dshHome: runtimeRoots.dshHome,
      codexHome: runtimeRoots.codexHome,
      userHome: runtimeRoots.userHome,
    };
    await runRuntimeMigration({
      target,
      runtimeRoots: reorderedRuntimeRoots,
      snapshot,
      preflight: async () => events.push("reordered-preflight"),
      installReplacement: async () => events.push("reordered-install"),
      verifyReplacement: async () => events.push("reordered-verify"),
      publishReplacement: async () => events.push("reordered-publish"),
      cleanupOld: async () => events.push("reordered-cleanup"),
      restoreSnapshot: async () => events.push("reordered-restore"),
      restartOldService: async () => events.push("reordered-restart"),
    });
    assert.deepEqual(events.slice(-5), ["reordered-preflight", "reordered-install", "reordered-verify", "reordered-publish", "reordered-cleanup"]);
    for (const invalidRoots of [
      { ...runtimeRoots, dshHome: path.join(root, "other-dsh") },
      { ...runtimeRoots, extraRoot: path.join(root, "extra") },
      { userHome: runtimeRoots.userHome, codexHome: runtimeRoots.codexHome, dshHome: runtimeRoots.dshHome },
      Object.create(runtimeRoots),
    ]) {
      let preflightReached = false;
      await assert.rejects(
        runRuntimeMigration({
          target,
          runtimeRoots: invalidRoots,
        snapshot,
        preflight: async () => { preflightReached = true; },
        installReplacement: async () => {},
        verifyReplacement: async () => {},
        publishReplacement: async () => {},
        cleanupOld: async () => {},
        restoreSnapshot: async () => {},
        restartOldService: async () => {},
        }),
        /different ServiceTarget|runtime roots|snapshot/i,
      );
      assert.equal(preflightReached, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("best-effort deferred completion and cleanup never replace migration success or its primary failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-defer-finally-"));
  const target = resolveServiceTarget({
    mode: "test", platform: process.platform, isolationRoot: root,
    sourceRoot: path.join(root, "checkout"), routerLabel: "com.example.defer-finally",
    trayLabel: "com.example.defer-finally.tray",
    ports: { oauth: 46541, router: 46542, api: 46543, grokOauth: 46548, devinCli: 46550 },
  });
  const runtimeRoots = { userHome: root, codexHome: root, dshHome: path.join(root, "dsh"), geminiHome: path.join(root, "gemini") };
  const replacement = { token: "a".repeat(32), transactionToken: "b".repeat(32) };
  const rollback = { token: "c".repeat(32), transactionToken: "d".repeat(32) };
  try {
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    const cleaned = [];
    const common = {
      target, runtimeRoots, snapshot, preflight: async () => {}, verifyReplacement: async () => {},
      publishReplacement: async () => {}, cleanupOld: async () => {}, restoreSnapshot: async () => {},
      signalStartupRebuildCompletion: () => { throw new Error("signal unavailable"); },
      cleanupStartupRebuildDefer: (handle) => { cleaned.push(handle); throw new Error("cleanup unavailable"); },
    };
    assert.deepEqual(await runRuntimeMigration({ ...common, installReplacement: async () => replacement, restartOldService: async () => rollback }), { ok: true, cleaned: true });
    assert.deepEqual(cleaned, [replacement, undefined]);

    cleaned.length = 0;
    const primary = new Error("primary verify failure");
    await assert.rejects(
      runRuntimeMigration({ ...common, installReplacement: async () => replacement, verifyReplacement: async () => { throw primary; }, restartOldService: async () => rollback }),
      (error) => error === primary,
    );
    assert.deepEqual(cleaned, [replacement, rollback]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime migration holds the catalog publication lock through rollback before a later publisher may commit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-publication-lock-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: process.platform,
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-publication-lock",
    trayLabel: "com.example.codex-router-publication-lock.tray",
    ports: { oauth: 46521, router: 46522, api: 46523, grokOauth: 46528, devinCli: 46530 },
  });
  const runtimeRoots = { userHome: root, codexHome: root, dshHome: path.join(root, "dsh"), geminiHome: path.join(root, "gemini") };
  let continueFailure;
  const releaseFailure = new Promise((resolve) => { continueFailure = resolve; });
  let snapshotTaken;
  const snapshotReady = new Promise((resolve) => { snapshotTaken = resolve; });
  const events = [];
  try {
    mkdirSync(target.stateRoot, { recursive: true });
    const migration = runRuntimeMigration({
      target,
      runtimeRoots,
      snapshot: () => {
        events.push("snapshot");
        snapshotTaken();
        return snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
      },
      preflight: async () => {},
      installReplacement: async () => { await releaseFailure; throw new Error("replacement failed"); },
      verifyReplacement: async () => {},
      publishReplacement: async () => {},
      cleanupOld: async () => {},
      restoreSnapshot: async () => events.push("restore"),
      restartOldService: async () => events.push("restart"),
    });
    await snapshotReady;
    let publisherEntered = false;
    const publisher = withCatalogPublicationLock(async () => {
      publisherEntered = true;
      events.push("publisher");
    }, { stateDir: target.stateRoot, waitMs: 2_000, retryMs: 10, staleMs: 2_000, heartbeatMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(publisherEntered, false, "publisher entered while migration still owned the lock");
    continueFailure();
    await assert.rejects(migration, /replacement failed/);
    await publisher;
    assert.deepEqual(events, ["snapshot", "restore", "restart", "publisher"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
