import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(script, command, platform, rootDir) {
  return execFileSync(process.execPath, [path.join(root, "src", script), command], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MODEL_ROUTER_SERVICE_PLATFORM: platform,
      MODEL_ROUTER_STATE_DIR: path.join(rootDir, "state"),
      CODEX_ROUTER_STATE_DIR: path.join(rootDir, "state"),
      MODEL_ROUTER_TARGET: "codex",
    },
  });
}

test("macOS service manifest contains only the Node router contract", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "node-service-render-"));
  try {
    const plist = run("service-macos.mjs", "render", "darwin", rootDir);
    assert.match(plist, /io\.github\.codex-router/);
    assert.doesNotMatch(plist, /MODEL_ROUTER_GATEWAY|CODEX_ROUTER_GATEWAY|LITELLM|PYTHONIOENCODING|PYTHONUTF8|\.venv/i);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Linux and Windows service entrypoints refuse before rendering", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "unsupported-service-render-"));
  try {
    for (const [script, platform] of [["service-linux.mjs", "linux"], ["service-windows.mjs", "win32"]]) {
      assert.throws(() => run(script, "render", platform, rootDir), /unsupported_platform/);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
