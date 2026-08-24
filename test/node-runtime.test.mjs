import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  nodeRuntimeHealth,
  nodeRuntimeTopology,
  startNodeRuntime,
} from "../src/node-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeChild extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
  }

  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    this.exitCode = 0;
    this.emit("exit", this.exitCode, signal);
    return true;
  }

  exit(code = 1, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

class ErrorOnlyChild {
  constructor(name) {
    this.name = name;
    this.exitCode = null;
    this.signalCode = null;
    this.listeners = new Map();
  }

  once(event, listener) {
    this.listeners.set(event, listener);
    return this;
  }

  fail(error) {
    this.listeners.get("error")?.(error);
  }

  kill() {
    this.exitCode = 0;
    this.listeners.get("exit")?.(0, "SIGTERM");
    return true;
  }
}

class DelayedChild extends EventEmitter {
  constructor(name, { termDelayMs = 0, ignoreTerm = false } = {}) {
    super();
    this.name = name;
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
    this.termDelayMs = termDelayMs;
    this.ignoreTerm = ignoreTerm;
  }

  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    const delay = signal === "SIGTERM" ? this.termDelayMs : 0;
    setTimeout(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.exitCode = signal === "SIGKILL" ? 137 : 0;
      this.signalCode = signal;
      this.emit("exit", this.exitCode, signal);
    }, delay);
    return true;
  }
}

function specs() {
  return {
    forwarders: [
      { name: "oauth", label: "OAuth forwarder", command: "node", args: ["oauth.mjs"] },
      { name: "api", label: "API forwarder", command: "node", args: ["api.mjs"] },
    ],
    router: { name: "router", label: "Router", command: "node", args: ["router.mjs"] },
  };
}

function recorder({ failAt } = {}) {
  const children = [];
  let calls = 0;
  return {
    children,
    async childFactory(spec) {
      calls += 1;
      if (calls === failAt) throw new Error(`spawn ${spec.name} failed`);
      const child = new FakeChild(spec.name);
      children.push(child);
      return child;
    },
  };
}

test("topology contains Router and only required Node forwarders", () => {
  const topology = nodeRuntimeTopology({
    sourceRoot: root,
    ports: { oauth: 5101, api: 5102, grokOauth: 5103, devinCli: 5104, router: 5105 },
    devinCliRouted: true,
  });
  const all = [...topology.forwarders, topology.router];
  assert.deepEqual(all.map(({ name }) => name), [
    "oauth",
    "api",
    "grokOauth",
    "devinCli",
    "router",
  ]);
  assert.doesNotMatch(JSON.stringify(all), /litellm|python|venv|gateway-supervisor|4200/i);
  assert.match(topology.router.args.at(-1), /src[\\/]router\.mjs$/);
});

test("topology passes an explicit catalog environment unchanged to the Router child", () => {
  const catalog = path.join(root, "generated", "acceptance", "catalog.json");
  const topology = nodeRuntimeTopology({
    sourceRoot: root,
    environment: { CODEX_ROUTER_CATALOG: catalog },
  });
  assert.equal(topology.router.env.CODEX_ROUTER_CATALOG, catalog);
});

test("a forwarder spawn failure stops already-started children and rethrows the original error", async () => {
  const created = recorder({ failAt: 2 });
  await assert.rejects(
    () => startNodeRuntime({ ...specs(), childFactory: created.childFactory }),
    /spawn api failed/,
  );
  assert.deepEqual(created.children.map((child) => child.name), ["oauth"]);
  assert.deepEqual(created.children[0].kills, ["SIGTERM"]);
});

test("a Router startup failure stops every started forwarder", async () => {
  const created = recorder({ failAt: 3 });
  await assert.rejects(
    () => startNodeRuntime({ ...specs(), childFactory: created.childFactory }),
    /spawn router failed/,
  );
  assert.deepEqual(created.children.map((child) => child.kills), [["SIGTERM"], ["SIGTERM"]]);
});

test("health exposes Router and forwarders without a gateway row", async () => {
  const created = recorder();
  const runtime = await startNodeRuntime({
    ...specs(),
    childFactory: created.childFactory,
    waitForHealth: async () => {},
  });
  try {
    assert.deepEqual(nodeRuntimeHealth(runtime), {
      router: "ready",
      forwarders: { oauth: "ready", api: "ready" },
      degraded: [],
    });
    created.children[0].exit(1);
    const result = await runtime.exited;
    assert.equal(result.name, "oauth");
    assert.deepEqual(nodeRuntimeHealth(runtime).degraded, ["oauth"]);
  } finally {
    await runtime.stop();
  }
});

test("runtime stop forwards its signal once to owned children", async () => {
  const created = recorder();
  const runtime = await startNodeRuntime({
    ...specs(),
    childFactory: created.childFactory,
    waitForHealth: async () => {},
  });
  await runtime.stop("SIGINT");
  await runtime.stop("SIGKILL");
  assert.deepEqual(created.children.map((child) => child.kills), [
    ["SIGINT"],
    ["SIGINT"],
    ["SIGINT"],
  ]);
});

test("a child error aborts startup with the original error", async () => {
  const child = new ErrorOnlyChild("router");
  const original = Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  const startup = startNodeRuntime({
    forwarders: [],
    router: { name: "router", label: "Router", command: "missing-node", args: [] },
    childFactory: async () => child,
    waitForHealth: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  setTimeout(() => child.fail(original), 0);
  await assert.rejects(startup, (error) => error === original);
});

test("a real missing executable rejects startup instead of becoming an orphan", async () => {
  const missing = path.join(root, "generated", `missing-router-${process.pid}-${Date.now()}.exe`);
  await assert.rejects(
    () => startNodeRuntime({
      forwarders: [],
      router: { name: "router", label: "Router", command: missing, args: [] },
      waitForHealth: async () => {},
    }),
    (error) => error?.code === "ENOENT",
  );
});

test("stop waits for graceful exits, shares its promise, and escalates once", async () => {
  const children = [];
  const runtime = await startNodeRuntime({
    ...specs(),
    childFactory: async (spec) => {
      const child = new DelayedChild(spec.name, { termDelayMs: 1_000, ignoreTerm: spec.name === "api" });
      children.push(child);
      return child;
    },
    waitForHealth: async () => {},
    stopGraceMs: 5,
    stopKillWaitMs: 20,
  });
  const first = runtime.stop("SIGTERM");
  const second = runtime.stop("SIGTERM");
  assert.equal(first, second);
  await first;
  assert.deepEqual(children.map((child) => child.kills), [
    ["SIGTERM", "SIGKILL"],
    ["SIGTERM", "SIGKILL"],
    ["SIGTERM", "SIGKILL"],
  ]);
  assert.deepEqual(children.map((child) => child.exitCode), [137, 137, 137]);
});

test("forwarder startup runs concurrently under one bounded startup deadline", async () => {
  let active = 0;
  let maximumActive = 0;
  const timeouts = [];
  const created = recorder();
  const runtime = await startNodeRuntime({
    ...specs(),
    childFactory: created.childFactory,
    startupTimeoutMs: 100,
    waitForHealth: async ({ spec, timeoutMs }) => {
      timeouts.push([spec.name, timeoutMs]);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    },
  });
  await runtime.stop();
  assert.equal(maximumActive, 2);
  assert.equal(timeouts.length, 3);
  assert.ok(timeouts.every(([, timeoutMs]) => timeoutMs <= 100));
});

test("start.mjs does not import or spawn the removed gateway runtime", () => {
  const source = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.doesNotMatch(source, /gateway-supervisor\.mjs|litellm-config\.mjs|venv-runtime\.mjs/);
  assert.doesNotMatch(source, /LITELLM_CONFIG_PATH|MODEL_ROUTER_GATEWAY_|CODEX_ROUTER_GATEWAY_/);
  assert.doesNotMatch(source, /\.venv|4200|PYTHONIOENCODING|PYTHONUTF8/);
});
