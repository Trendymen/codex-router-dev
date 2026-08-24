import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  nodeMeetsMinimum,
  STEPS,
  recordStep,
  stepStatus,
  trayRebuildPlan,
  traySourceFingerprint,
} from "../src/install-plan.mjs";

test("the install plan contains only the Node dependency step", () => {
  assert.deepEqual(Object.keys(STEPS), ["node-deps"]);
});

test("Node dependency status is fingerprinted by package-lock", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "node-install-plan-"));
  try {
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", ".package-lock.json"), "{}\n");
    writeFileSync(path.join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    assert.equal(stepStatus("node-deps", { root }), "run");
    recordStep("node-deps", { root });
    assert.equal(stepStatus("node-deps", { root }), "skip");
    writeFileSync(path.join(root, "package-lock.json"), "{\"lockfileVersion\":3,\"changed\":true}\n");
    assert.equal(stepStatus("node-deps", { root }), "run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-macOS tray planning is unsupported and has no executable path", () => {
  assert.equal(trayRebuildPlan({ platform: "linux" }), "unsupported");
  assert.equal(trayRebuildPlan({ platform: "win32" }), "unsupported");
  assert.equal(traySourceFingerprint(undefined, "linux"), "");
});

test("Node minimum is compared numerically, not lexically", () => {
  assert.equal(nodeMeetsMinimum("22.19.0"), true);
  assert.equal(nodeMeetsMinimum("22.20.1"), true);
  assert.equal(nodeMeetsMinimum("23.0.0"), true);
  assert.equal(nodeMeetsMinimum("22.9.0"), false);
  assert.equal(nodeMeetsMinimum("21.99.99"), false);
  assert.equal(nodeMeetsMinimum("v22.18.9"), false);
});

test("unknown legacy dependency steps fail closed", () => {
  assert.throws(() => stepStatus("python-deps"), /Unknown install step/);
});
