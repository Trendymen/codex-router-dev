import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveServiceTarget } from "../src/service-target.mjs";
import { uninstallRouterRuntimeTransaction } from "../src/local-uninstall.mjs";
import { ownedRuntimePaths, snapshotOwnedRuntime } from "../src/owned-runtime-paths.mjs";

test("router uninstall uses only the closed runtime list and never targets retained local weights", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-uninstall-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: process.platform,
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-uninstall-test",
    trayLabel: "com.example.codex-router-uninstall-test.tray",
    ports: { oauth: 46201, router: 46202, api: 46203, grokOauth: 46208, devinCli: 46210 },
  });
  const runtimeRoots = { userHome: root, codexHome: root, dshHome: path.join(root, "dsh"), geminiHome: path.join(root, "gemini") };
  const events = [];
  try {
    const result = await uninstallRouterRuntimeTransaction({
      target,
      runtimeRoots,
      snapshot: { version: 1, entries: {} },
      installReplacement: async () => {},
      verifyReplacement: async () => {},
      cleanupOld: async (context) => {
        events.push("cleanup");
        assert.equal(context.some((value) => value.includes(".ollama")), false);
        assert.ok(context.every((value) => typeof value === "string" && !/[!*?]/.test(value)));
      },
      restoreSnapshot: async () => events.push("restore"),
      restartOldService: async () => events.push("restart"),
      ownedPaths: ["legacy-litellm-config"],
    });
    assert.deepEqual(result, { ok: true, cleaned: true });
    assert.deepEqual(events, ["cleanup"]);
    await assert.rejects(
      uninstallRouterRuntimeTransaction({
        target,
        runtimeRoots,
        snapshot: { version: 1, entries: {} },
        ownedPaths: ["state-catalog"],
        cleanupOld: async () => {},
        restoreSnapshot: async () => {},
        restartOldService: async () => {},
      }),
      /cleanup|protected|allowlist/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("router uninstall restores and restarts before returning a cleanup failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-uninstall-failure-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: process.platform,
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-uninstall-failure",
    trayLabel: "com.example.codex-router-uninstall-failure.tray",
    ports: { oauth: 46211, router: 46212, api: 46213, grokOauth: 46218, devinCli: 46220 },
  });
  const runtimeRoots = { userHome: root, codexHome: root, dshHome: path.join(root, "dsh"), geminiHome: path.join(root, "gemini") };
  const events = [];
  const primary = new Error("cleanup failed");
  try {
    const paths = ownedRuntimePaths(target, runtimeRoots);
    const snapshot = snapshotOwnedRuntime(paths);
    await assert.rejects(
      uninstallRouterRuntimeTransaction({
        target,
        runtimeRoots,
        snapshot,
        cleanupOld: async () => { throw primary; },
        restoreSnapshot: async () => events.push("restore"),
        restartOldService: async () => events.push("restart"),
      }),
      (error) => error === primary,
    );
    assert.deepEqual(events, ["restore", "restart"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("router uninstall never downgrades to arbitrary paths without a validated target", async () => {
  await assert.rejects(
    uninstallRouterRuntimeTransaction({
      snapshot: { version: 1, entries: {} },
      ownedPaths: ["../foreign"],
      cleanupOld: async () => {},
      restoreSnapshot: async () => {},
      restartOldService: async () => {},
    }),
    /ServiceTarget|validated|allowlist|path/i,
  );
});
