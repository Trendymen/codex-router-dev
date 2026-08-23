import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildServiceProcessState,
  clearServiceProcessState,
  serviceProcessOwns,
  writeServiceProcessState,
} from "../src/service-process.mjs";

const root = path.join(os.tmpdir(), "codex-router-checkout");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(os.tmpdir(), "codex-router-service-state");

function identity() {
  return "2026-08-18T00:00:00Z|node.exe";
}

function commandLine() {
  return `node "${root}/src/start.mjs"`;
}

test("service process state requires the router start.mjs command line", () => {
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine,
    sourceRoot: root,
    stateDir,
    ports: { router: 4202, api: 4203 },
  });
  assert.equal(state.pid, 4242);
  assert.equal(state.managed, true);
  assert.deepEqual(state.ports, { router: 4202, api: 4203 });
  assert.equal(
    serviceProcessOwns(state, {
      platform: "win32",
      identity,
      commandLine,
      sourceRoot: root,
      stateDir,
    }),
    true,
  );
  assert.equal(
    serviceProcessOwns(state, {
      platform: "win32",
      identity,
      commandLine: () => "node C:/other/src/start.mjs",
      sourceRoot: root,
      stateDir,
    }),
    false,
  );
  assert.equal(
    buildServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity,
      commandLine: () => "node C:/other/src/start.mjs",
      sourceRoot: root,
      stateDir,
    }),
    undefined,
  );
});

test("service process state is private, readable, and removable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-state-"));
  const statePath = path.join(directory, "service-process.json");
  try {
    const state = writeServiceProcessState({
      pid: 4242,
      platform: "win32",
      identity,
      commandLine,
      sourceRoot: root,
      stateDir,
      statePath,
    });
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).pid, state.pid);
    clearServiceProcessState(statePath);
    assert.throws(() => readFileSync(statePath, "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service process state records only Node-owned ports", () => {
  const state = buildServiceProcessState({
    pid: 4242,
    platform: "win32",
    identity,
    commandLine,
    sourceRoot: root,
    stateDir,
    ports: { oauth: 5301, api: 5302, grokOauth: 5303, devinCli: 5304, router: 5305 },
  });
  assert.deepEqual(state.ports, {
    oauth: 5301,
    api: 5302,
    grokOauth: 5303,
    devinCli: 5304,
    router: 5305,
  });
  assert.equal("gateway" in state.ports, false);
});

test("service process coverage does not require a removed gateway runtime", () => {
  const source = readFileSync(path.join(repositoryRoot, "src", "start.mjs"), "utf8");
  assert.doesNotMatch(source, /gateway-supervisor\.mjs|litellm-config\.mjs|venv-runtime\.mjs/);
  assert.doesNotMatch(source, /MODEL_ROUTER_GATEWAY_|CODEX_ROUTER_GATEWAY_|\.venv|4200/);
});
