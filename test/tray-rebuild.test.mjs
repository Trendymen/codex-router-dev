import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("macOS tray fingerprint includes nested SwiftPM and bundle resources", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-fingerprint-resources-"));
  try {
    const base = path.join(root, "apps", "macos", "ModelRouterTray");
    const nested = path.join(base, "Sources", "Resources", "ProviderIcons");
    const bundleResources = path.join(base, "Resources");
    const binaryResource = path.join(bundleResources, "binary.dat");
    mkdirSync(nested, { recursive: true });
    mkdirSync(bundleResources, { recursive: true });
    writeFileSync(path.join(base, "Package.swift"), "// fixture\n");
    writeFileSync(path.join(nested, "fixture.svg"), "<svg>one</svg>\n");
    writeFileSync(path.join(bundleResources, "AppIcon.svg"), "<svg>one</svg>\n");
    writeFileSync(binaryResource, Buffer.from([0x80]));
    const before = traySourceFingerprint(root, "darwin");
    writeFileSync(path.join(nested, "fixture.svg"), "<svg>two</svg>\n");
    assert.notEqual(traySourceFingerprint(root, "darwin"), before);
    writeFileSync(path.join(bundleResources, "AppIcon.svg"), "<svg>two</svg>\n");
    assert.notEqual(traySourceFingerprint(root, "darwin"), before);
    const changed = traySourceFingerprint(root, "darwin");
    writeFileSync(binaryResource, Buffer.from([0x81]));
    assert.notEqual(traySourceFingerprint(root, "darwin"), changed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS tray fingerprint refuses symlinked SwiftPM inputs", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tray-fingerprint-symlink-"));
  try {
    const base = path.join(root, "apps", "macos", "ModelRouterTray");
    mkdirSync(path.join(base, "Sources"), { recursive: true });
    writeFileSync(path.join(base, "Package.swift"), "// fixture\n");
    writeFileSync(path.join(base, "Sources", "Fixture.swift"), "struct Fixture {}\n");
    let supported = true;
    try {
      symlinkSync("Fixture.swift", path.join(base, "Sources", "Alias.swift"));
    } catch (error) {
      supported = false;
      assert.match(String(error?.code || error), /EPERM|EACCES|operation not permitted/i);
    }
    if (supported) assert.throws(() => traySourceFingerprint(root, "darwin"), /symlink|link/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
