import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordTrayBuild, trayRebuildPlan, traySourceFingerprint } from "../src/install-plan.mjs";

test("non-macOS companion rebuilds are refused without inspecting binaries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-rebuild-unsupported-"));
  try {
    assert.equal(trayRebuildPlan({ root, platform: "win32" }), "unsupported");
    assert.equal(trayRebuildPlan({ root, platform: "linux" }), "unsupported");
    assert.equal(traySourceFingerprint(root, "win32"), "");
    assert.throws(() => recordTrayBuild({ root, platform: "win32" }), /only built on macOS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS tray source fingerprint is stable for a fixed source tree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-rebuild-macos-"));
  try {
    const base = path.join(root, "apps", "macos", "ModelRouterTray");
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(base, "Package.swift"), "// fixture\n", { encoding: "utf8" });
    assert.equal(traySourceFingerprint(root, "darwin"), traySourceFingerprint(root, "darwin"));
    assert.equal(existsSync(path.join(base, "Package.swift")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
