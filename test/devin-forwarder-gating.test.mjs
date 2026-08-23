import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { freePort } from "./port-pool.mjs";
import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_READY_TIMEOUT_MS = 30_000;

function waitForReadyOrExit(child, readErrors) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const finish = () => clearInterval(watchdog);
    const watchdog = setInterval(() => {
      if (readErrors().includes("[codex-router] ready")) {
        finish();
        resolve({ ready: true });
      } else if (Date.now() - started >= STARTUP_READY_TIMEOUT_MS) {
        finish();
        reject(new Error(`startup did not become ready within ${STARTUP_READY_TIMEOUT_MS} ms; stderr:\n${readErrors()}`));
      }
    }, 25);
    child.once("exit", (code, signal) => {
      finish();
      resolve({ ready: false, exit: { code, signal } });
    });
  });
}

async function squat(port) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    listening: () => server.listening,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.unref();
    }),
  };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let hardStop;
  await Promise.race([
    exited,
    new Promise((resolve) => { hardStop = setTimeout(resolve, 5_000); }),
  ]);
  clearTimeout(hardStop);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function runStartup({ curatedDevinModel = false, occupyDevinPort = false } = {}) {
  const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
  assert.equal(new Set(ports).size, ports.length);
  const [routerPort, _unusedPort, oauthPort, apiPort, grokOauthPort, devinPort] = ports;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "model-router-devin-gate-"));
  const stateDir = path.join(rootDir, "state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "internal-secret"), "devin-gate-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), "devin-gate-caller-key-with-sufficient-length\n", { mode: 0o600 });
  if (curatedDevinModel) {
    writeFileSync(
      path.join(stateDir, "user-models.json"),
      `${JSON.stringify({
        version: 1,
        models: [userModelEntry({ providerId: "devin-cli", upstreamId: "gate-test-model", priority: 900 })],
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  const squatter = occupyDevinPort ? await squat(devinPort) : undefined;
  const child = spawn(process.execPath, [path.join(root, "src", "start.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_TARGET: "codex",
      MODEL_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_PORT: String(routerPort),
      MODEL_ROUTER_OAUTH_PORT: String(oauthPort),
      MODEL_ROUTER_API_PORT: String(apiPort),
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokOauthPort),
      MODEL_ROUTER_DEVIN_CLI_PORT: String(devinPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    const startup = await waitForReadyOrExit(child, () => errors);
    return {
      ...startup,
      errors,
      squatterHeldPort: squatter ? squatter.listening() : undefined,
    };
  } finally {
    await stopChild(child);
    if (squatter) await squatter.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("an install with no curated Devin model reaches Node readiness without binding its port", { timeout: 60_000 }, async () => {
  const { ready, errors, squatterHeldPort } = await runStartup({ occupyDevinPort: true });
  assert.equal(ready, true, errors);
  assert.doesNotMatch(errors, /\[devin-cli\]|Devin CLI forwarder/, errors);
  assert.equal(squatterHeldPort, true, "something took the Devin port from this test");
});

test("a curated Devin model starts its forwarder before Node readiness", { timeout: 60_000 }, async () => {
  const { ready, errors } = await runStartup({ curatedDevinModel: true });
  assert.equal(ready, true, errors);
  assert.match(errors, /\[devin-cli\] listening/, errors);
});

test("a curated Devin model that cannot bind its port fails startup by name", { timeout: 60_000 }, async () => {
  const { ready, exit, errors } = await runStartup({ curatedDevinModel: true, occupyDevinPort: true });
  assert.equal(ready, false, errors);
  assert.match(errors, /startup failed: Devin CLI forwarder exited before becoming healthy\./, errors);
  assert.equal(exit.code, 1, errors);
});

test("neither secret is echoed while the Node runtime is ready", { timeout: 60_000 }, async () => {
  const { ready, errors } = await runStartup({ curatedDevinModel: true });
  assert.equal(ready, true, errors);
  assert.doesNotMatch(errors, /devin-gate-internal-key-with-sufficient-length/);
  assert.doesNotMatch(errors, /devin-gate-caller-key-with-sufficient-length/);
});
