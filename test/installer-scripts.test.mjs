import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the shipped POSIX installer is macOS-only and installs Node dependencies", () => {
  const source = readFileSync(path.join(root, "bin", "install"), "utf8");
  assert.match(source, /unsupported_platform/);
  assert.match(source, /npm ci --omit=dev/);
  assert.match(source, /install-plan\.mjs record node-deps/);
  assert.doesNotMatch(source, /(?:python|pip|uv)\s+(?:install|venv|pip)|litellm|MODEL_ROUTER_GATEWAY|CODEX_ROUTER_GATEWAY|4200/i);
});

test("public POSIX bootstrap refuses before checkout or dependency work", () => {
  const source = readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(source, /platform_name=.*uname/);
  assert.match(source, /unsupported_platform/);
  assert.doesNotMatch(source, /(?:python|pip|uv)\s+(?:install|venv|pip)|litellm|MODEL_ROUTER_GATEWAY|CODEX_ROUTER_GATEWAY|4200/i);
});

test("PowerShell entrypoints are parseable unsupported-platform shims", () => {
  for (const name of ["install.ps1", "codex-router.ps1", "model-router.ps1"]) {
    const source = readFileSync(path.join(root, name), "utf8");
    assert.match(source, /unsupported_platform/);
    assert.doesNotMatch(source, /(?:python|pip|uv)\s+(?:install|venv|pip)|litellm|cargo|tauri|electron|4200/i);
  }
});

test("PowerShell installer exits with the public refusal when invoked on Windows", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-File", path.join(root, "install.ps1"), "-CheckoutInstall"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /unsupported_platform/);
});

test("the Node install plan has no removed dependency command", () => {
  const source = readFileSync(path.join(root, "src", "install-plan.mjs"), "utf8");
  assert.match(source, /"node-deps"/);
  assert.doesNotMatch(source, /python|pip|uv|litellm|GATEWAY|4200/i);
});
