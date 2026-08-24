import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditRemovedPathList, auditRemovedRuntime, scanRemovedRuntimeText } from "../src/dependency-removal-audit.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("shipped files contain no removed runtime execution", async () => {
  assert.deepEqual(await auditRemovedRuntime(repoRoot), []);
});

test("the closed removal list no longer ships legacy runtime files", () => {
  const removed = [
    "requirements/python.in",
    "requirements/python.txt",
    "src/litellm-config.mjs",
    "src/gateway-supervisor.mjs",
    "src/venv-runtime.mjs",
    ".github/workflows/python-lock.yml",
    "bin/lock-python",
    "scripts/verify-python-lock.py",
    "scripts/verify-zai-litellm-usage.mjs",
    "packaging/homebrew/check-formula.mjs",
    "packaging/homebrew/generate-formula.mjs",
    "test/gateway-restart.test.mjs",
    "test/gateway-supervisor.test.mjs",
    "test/python-lock.test.mjs",
  ];
  for (const relative of removed) {
    assert.equal(existsSync(path.join(repoRoot, relative)), false, relative);
  }
});

test("the audit catches Python and uv executable arrays but allows Node commands", () => {
  const positive = scanRemovedRuntimeText([
    'spawn("python3", ["-m", "pip", "install", "demo"]);',
    'execFile("uv", ["pip", "install", "-r", "requirements.txt"]);',
  ].join("\n"), "fixture/positive.mjs");
  assert.equal(positive.length, 2);
  assert.deepEqual([...new Set(positive.map((finding) => finding.kind))], ["python-install"]);

  const negative = scanRemovedRuntimeText(
    'spawn(process.execPath, ["src/router.mjs"]);\nconst runtime = "node";',
    "fixture/negative.mjs",
  );
  assert.deepEqual(negative, []);
});

test("the audit consumes removed prefixes for tracked paths and ignores shipped Node/UI paths", () => {
  const positive = auditRemovedPathList([
    "requirements/legacy.in",
    "apps/electron/main.js",
    "apps/control-center/src/main.tsx",
    "apps/desktop/src-tauri/src/main.rs",
  ]);
  assert.deepEqual(positive.map(({ kind, path }) => ({ kind, path })), [
    { kind: "removed-prefix-present", path: "apps/control-center/src/main.tsx" },
    { kind: "removed-prefix-present", path: "apps/desktop/src-tauri/src/main.rs" },
    { kind: "removed-prefix-present", path: "apps/electron/main.js" },
    { kind: "removed-prefix-present", path: "requirements/legacy.in" },
  ]);
  assert.deepEqual(
    auditRemovedPathList(["apps/desktop/ui/app.js", "apps/macos/ModelRouterTray/Sources/App.swift", "src/router.mjs"]),
    [],
  );
});
