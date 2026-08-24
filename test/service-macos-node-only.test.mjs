import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const service = path.join(root, "src", "service-macos.mjs");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function render(rootDir, extra = {}) {
  return execFileSync(process.execPath, [service, "render"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MODEL_ROUTER_SERVICE_MODE: "acceptance",
      MODEL_ROUTER_ISOLATION_ROOT: rootDir,
      MODEL_ROUTER_SERVICE_PLATFORM: "darwin",
      MODEL_ROUTER_SERVICE_LABEL: "io.github.codex-router.acceptance",
      MODEL_ROUTER_TRAY_SERVICE_LABEL: "io.github.codex-router.acceptance.tray",
      MODEL_ROUTER_OAUTH_PORT: "5201",
      MODEL_ROUTER_PORT: "5202",
      MODEL_ROUTER_API_PORT: "5203",
      MODEL_ROUTER_GROK_OAUTH_PORT: "5208",
      MODEL_ROUTER_DEVIN_CLI_PORT: "5210",
      MODEL_ROUTER_TARGET: "codex",
      ...extra,
    },
  });
}

test("LaunchAgent starts exactly the absolute Node runtime and src/start.mjs", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "node-only-service-"));
  try {
    const nodeBinary = path.join(rootDir, "toolchain", "node");
    const plist = render(rootDir, {
      CODEX_ROUTER_NODE_BIN: nodeBinary,
    });
    assert.equal((plist.match(/<key>ProgramArguments<\/key>/g) || []).length, 1);
    assert.match(plist, new RegExp(`<string>${escapeRegExp(nodeBinary)}</string>`));
    assert.match(plist, new RegExp(`<string>${escapeRegExp(path.join(root, "src", "start.mjs"))}</string>`));
    const programArguments = plist.match(/<key>ProgramArguments<\/key>[\s\S]*?<\/array>/)?.[0] || "";
    assert.doesNotMatch(programArguments, /python|pip|uv|litellm|gateway|venv|rust|tauri|electron/i);
    assert.doesNotMatch(plist, /4200/);
    assert.match(plist, /<key>MODEL_ROUTER_PORT<\/key>\s*<string>5202<\/string>/);
    assert.match(plist, /<key>MODEL_ROUTER_API_PORT<\/key>\s*<string>5203<\/string>/);
    assert.match(plist, /<key>MODEL_ROUTER_OAUTH_PORT<\/key>\s*<string>5201<\/string>/);
    assert.match(plist, /<key>MODEL_ROUTER_GROK_OAUTH_PORT<\/key>\s*<string>5208<\/string>/);
    assert.match(plist, /<key>MODEL_ROUTER_DEVIN_CLI_PORT<\/key>\s*<string>5210<\/string>/);
    assert.match(plist, /<key>CODEX_ROUTER_GROK_OAUTH_PORT<\/key>\s*<string>5208<\/string>/);
    assert.match(plist, /<key>CODEX_ROUTER_DEVIN_CLI_PORT<\/key>\s*<string>5210<\/string>/);
    assert.doesNotMatch(plist, /MODEL_ROUTER_CALLER_KEY|CODEX_ROUTER_CALLER_KEY|MODEL_ROUTER_INTERNAL_KEY|CODEX_ROUTER_INTERNAL_KEY/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("LaunchAgent render keeps private state files untouched and service paths isolated", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "node-only-service-state-"));
  const stateDir = path.join(rootDir, "state");
  try {
    const caller = path.join(stateDir, "caller-secret");
    const internal = path.join(stateDir, "internal-secret");
    const callerBytes = "caller-fixture\n";
    const internalBytes = "internal-fixture\n";
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(caller, callerBytes, { mode: 0o600 });
    writeFileSync(internal, internalBytes, { mode: 0o600 });
    const before = [readFileSync(caller), readFileSync(internal)];
    const plist = render(rootDir, { MODEL_ROUTER_STATE_DIR: stateDir });
    assert.match(plist, new RegExp(rootDir.replaceAll("\\", "\\\\")));
    assert.deepEqual([readFileSync(caller), readFileSync(internal)], before);
    if (process.platform !== "win32") {
      assert.equal(statSync(caller).mode & 0o777, 0o600);
      assert.equal(statSync(internal).mode & 0o777, 0o600);
    }
    assert.doesNotMatch(plist, /caller-fixture|internal-fixture/);
    assert.match(readFileSync(service, "utf8"), /mode:\s*0o600/);
    assert.match(readFileSync(service, "utf8"), /mode:\s*0o700/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("service source has no legacy runtime launch contract", () => {
  const source = readFileSync(service, "utf8");
  assert.match(source, /["']src["'],\s*["']start\.mjs["']/);
  assert.doesNotMatch(source, /gateway-supervisor|litellm|python|venv|4200/i);
});
