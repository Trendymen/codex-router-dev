import { spawn as spawnProcess } from "node:child_process";
import path from "node:path";

import { waitForHealth as pollHealth } from "./health-probe.mjs";
import { PORTS, SOURCE_ROOT, loopback } from "./paths.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

const FORWARDER_DEFINITIONS = Object.freeze([
  { name: "oauth", label: "OAuth forwarder", script: "oauth-forwarder.mjs", port: "oauth" },
  { name: "api", label: "API forwarder", script: "api-forwarder.mjs", port: "api" },
  { name: "grokOauth", label: "Grok OAuth forwarder", script: "grok-oauth-forwarder.mjs", port: "grokOauth" },
]);

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 3_000;
const DEFAULT_STOP_KILL_WAIT_MS = 1_000;

function childAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function scriptPath(sourceRoot, script) {
  return path.join(sourceRoot, "src", script);
}

function healthSpec(port, internalKey, expectedService) {
  return {
    url: loopback(port, "/health"),
    headers: internalKey ? { Authorization: `Bearer ${internalKey}` } : {},
    expectedService,
  };
}

/**
 * Return the complete child topology owned by the Node service.
 *
 * The topology is deliberately data-only. It has no provider discovery and no
 * legacy runtime path, so tests can prove the forbidden process set without
 * spawning a service.
 */
export function nodeRuntimeTopology({
  sourceRoot = SOURCE_ROOT,
  nodeBinary = process.execPath,
  ports = PORTS,
  environment = {},
  internalKey,
  devinCliRouted = false,
} = {}) {
  const forwarders = FORWARDER_DEFINITIONS.map(({ name, label, script, port }) => ({
    name,
    label,
    command: nodeBinary,
    args: [scriptPath(sourceRoot, script)],
    cwd: sourceRoot,
    env: environment,
    health: healthSpec(ports[port], internalKey),
  }));
  if (devinCliRouted) {
    forwarders.push({
      name: "devinCli",
      label: "Devin CLI forwarder",
      command: nodeBinary,
      args: [scriptPath(sourceRoot, "devin-cli-forwarder.mjs")],
      cwd: sourceRoot,
      env: environment,
      health: healthSpec(ports.devinCli, internalKey),
    });
  }
  return {
    forwarders,
    router: {
      name: "router",
      label: "Router",
      command: nodeBinary,
      args: [scriptPath(sourceRoot, "router.mjs")],
      cwd: sourceRoot,
      env: environment,
      health: healthSpec(ports.router, internalKey, "codex-router"),
    },
  };
}

function defaultChildFactory(spec) {
  const command = spawnableCommand(spec.command, spec.args || []);
  return spawnProcess(command.command, command.args, {
    cwd: spec.cwd || SOURCE_ROOT,
    env: { ...process.env, ...(spec.env || {}) },
    stdio: "inherit",
    ...command.options,
  });
}

function defaultHealthWait({ spec, child, isShuttingDown, timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS }) {
  if (!spec.health) return Promise.resolve();
  return pollHealth({
    ...spec.health,
    label: spec.label || spec.name,
    timeoutMs,
    child,
    isShuttingDown,
  });
}

function stopChild(child, signal) {
  if (!childAlive(child) || typeof child.kill !== "function") return;
  try {
    child.kill(signal);
  } catch {
    // Preserve the startup error when cleanup itself encounters a dead child.
  }
}

function cancellableWait(milliseconds) {
  let timer;
  let resolveWait;
  const promise = new Promise((resolve) => {
    resolveWait = resolve;
    timer = setTimeout(resolve, Math.max(0, milliseconds));
  });
  return {
    promise,
    cancel() {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      resolveWait?.();
    },
  };
}

async function waitForRecords(records, timeoutMs) {
  const pending = records.filter((record) => childAlive(record.child));
  if (!pending.length) return;
  const timeout = cancellableWait(timeoutMs);
  try {
    await Promise.race([
      Promise.all(pending.map((record) => record.exitPromise)),
      timeout.promise,
    ]);
  } finally {
    // A normal graceful exit should not leave a referenced timer behind for the
    // entire grace window. Do not unref the timer: a still-live owned child must
    // keep the shutdown wait observable until this bounded wait completes.
    timeout.cancel();
  }
}

/**
 * Start, health-check, and own the Router plus its required Node forwarders.
 * `childFactory` and `waitForHealth` are injectable for platform-neutral tests.
 */
export async function startNodeRuntime(config = {}) {
  const topology = config.forwarders && config.router
    ? config
    : { ...nodeRuntimeTopology(config), ...config };
  const childFactory = config.childFactory || defaultChildFactory;
  const waitForHealth = config.waitForHealth || defaultHealthWait;
  const records = [];
  const startupTimeoutMs = Number.isFinite(config.startupTimeoutMs) && config.startupTimeoutMs >= 0
    ? config.startupTimeoutMs
    : DEFAULT_STARTUP_TIMEOUT_MS;
  const startupDeadline = Date.now() + startupTimeoutMs;
  let stopping = false;
  let stopPromise;
  let exitSettled = false;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const markExit = (record, code, signal, error) => {
    if (record.exit) return;
    record.state = "stopped";
    record.exit = { code, signal, ...(error ? { error } : {}) };
    record.resolveExit?.(record.exit);
    if (exitSettled) return;
    exitSettled = true;
    resolveExit({
      name: record.name,
      label: record.label,
      code,
      signal,
      stopping,
      ...(error ? { error } : {}),
    });
  };

  const stopOwned = (signal = "SIGTERM") => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const owned = records.slice();
      for (const record of owned) stopChild(record.child, signal);
      await waitForRecords(owned, config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
      const stillAlive = owned.filter((record) => childAlive(record.child));
      for (const record of stillAlive) stopChild(record.child, "SIGKILL");
      await waitForRecords(stillAlive, config.stopKillWaitMs ?? DEFAULT_STOP_KILL_WAIT_MS);
    })();
    return stopPromise;
  };

  const startChild = async (spec) => {
    const child = await childFactory(spec);
    if (!child || typeof child !== "object") {
      throw new Error(`${spec.label || spec.name} did not return a child process.`);
    }
    const record = {
      name: spec.name,
      label: spec.label || spec.name,
      spec,
      child,
      state: "starting",
    };
    record.exitPromise = new Promise((resolve) => {
      record.resolveExit = resolve;
    });
    record.errorPromise = new Promise((_, reject) => {
      record.rejectError = reject;
    });
    records.push(record);
    if (typeof child.once === "function") {
      child.once("error", (error) => {
        record.error = error;
        record.rejectError(error);
        markExit(record, null, null, error);
      });
    }
    if (typeof child.once === "function") {
      child.once("exit", (code, signal) => markExit(record, code, signal));
    }
    if (!childAlive(child)) {
      markExit(record, child.exitCode ?? null, child.signalCode ?? null);
      throw new Error(`${record.label} exited before becoming healthy.`);
    }
    if ((!config.childFactory || config.awaitSpawn === true) && typeof child.once === "function") {
      const spawned = new Promise((resolve) => child.once("spawn", resolve));
      await Promise.race([spawned, record.errorPromise]);
    }
    const remainingMs = Math.max(0, startupDeadline - Date.now());
    await Promise.race([
      waitForHealth({
        spec,
        child,
        timeoutMs: remainingMs,
        isShuttingDown: () => stopping || config.isShuttingDown?.() === true,
      }),
      record.errorPromise,
    ]);
    if (Date.now() > startupDeadline) {
      throw new Error(`${record.label} startup deadline exceeded.`);
    }
    if (!childAlive(child)) {
      throw new Error(`${record.label} exited before becoming healthy.`);
    }
    record.state = "ready";
    return record;
  };

  try {
    const forwarderStarts = (topology.forwarders || []).map((spec) => startChild(spec));
    try {
      await Promise.all(forwarderStarts);
    } catch (error) {
      await Promise.allSettled(forwarderStarts);
      throw error;
    }
    if (!topology.router) throw new Error("Node runtime topology is missing the Router.");
    const router = await startChild(topology.router);
    return Object.freeze({
      children: records.map((record) => record.child),
      forwarders: records
        .filter((record) => record.name !== "router")
        .map((record) => record.child),
      router: router.child,
      records,
      exited,
      stop: stopOwned,
    });
  } catch (error) {
    await stopOwned();
    throw error;
  }
}

export function nodeRuntimeHealth(runtime) {
  const records = Array.isArray(runtime?.records) ? runtime.records : [];
  const stateFor = (name) => {
    const record = records.find((entry) => entry.name === name);
    return record?.state === "ready" && childAlive(record.child) ? "ready" : "stopped";
  };
  const router = stateFor("router");
  const forwarders = Object.fromEntries(
    records
      .filter((record) => record.name !== "router")
      .map((record) => [record.name, stateFor(record.name)]),
  );
  return {
    router,
    forwarders,
    degraded: [
      ...(router === "ready" ? [] : ["router"]),
      ...Object.entries(forwarders)
        .filter(([, state]) => state !== "ready")
        .map(([name]) => name),
    ],
  };
}
