const childProcess = require("node:child_process");
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { syncBuiltinESMExports } = require("node:module");

const tracePath = process.env.CONTROL_SAFE_TRACE;

function trace(type, detail = {}) {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify({ type, owner: process.env.CONTROL_SAFE_CANONICAL_COMMAND || null, ...detail })}\n`);
}

function commandName(command) {
  return path.basename(String(command || "")).toLowerCase();
}

function scriptName(args) {
  const script = Array.isArray(args)
    ? args.find((value) => typeof value === "string" && /\.(?:mjs|js|ps1|sh)$/i.test(value))
    : undefined;
  return script ? path.basename(script).toLowerCase() : "";
}

function fixtureFor(command, args) {
  const executable = commandName(command);
  const script = scriptName(args);
  const argv = Array.isArray(args) ? args.map(String) : [];
  const rollback = script === "update.mjs" && argv.includes("--rollback");
  const category = /git(?:\.exe)?$/.test(executable)
    ? "git"
    : /install|npm|pip|uv|curl|wget/.test(executable) || /install/.test(script)
      ? "install"
      : /service|schtasks|launchctl|systemctl|taskkill/.test(executable) || /service/.test(script)
        ? "service"
        : /update/.test(script)
          ? rollback ? "rollback" : "update"
          : /download|vision-host|local-download/.test(script)
            ? "download"
            : "child";
  trace("child", { api: "sync", category, executable, script, stubbed: true });

  if (category === "git") {
    if (argv.includes("remote") && argv.includes("get-url")) return "https://github.com/duolahypercho/codex-router.git\n";
    if (argv.includes("rev-parse") && argv.includes("refs/codex-router/rollback")) return "fixture-rollback-head\n";
    if (argv.includes("rev-parse")) return "fixture-current-head\n";
    if (argv.includes("status")) return "";
    return "fixture-git-ok\n";
  }
  if (/^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) {
    const joined = argv.join(" ");
    if (joined.includes("WindowsIdentity")) return "S-1-5-21-1000-1000-1000-1000";
    if (joined.includes("GetAccessControl")) return "True";
    return "";
  }
  if (argv.includes("app-server")) {
    return [
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: { rateLimits: { planType: "fixture", primary: { usedPercent: 0 } } } }),
      JSON.stringify({ id: 3, result: { summary: {}, dailyUsageBuckets: [] } }),
      "",
    ].join("\n");
  }
  if (script === "service.mjs") return `${JSON.stringify({ state: "running", installed: true })}\n`;
  if (script === "doctor.mjs") return `${JSON.stringify({ checks: [], ok: true })}\n`;
  if (script === "update.mjs") return `${JSON.stringify(rollback ? { rolledBack: true } : { updated: true })}\n`;
  if (script === "catalog.mjs") return `${JSON.stringify({ models: [] })}\n`;
  if (script === "config-manager.mjs") return `${JSON.stringify({ changed: true })}\n`;
  if (script === "node-snapshot-triggers.mjs") return `${JSON.stringify({ refreshed: true })}\n`;
  if (script === "tray-service.mjs") return `${JSON.stringify({ state: "running" })}\n`;
  if (script === "subagent-verify.mjs" || script === "agent-check.mjs") return `${JSON.stringify({ ok: true, checks: [] })}\n`;
  if (script === "control.mjs") return `${JSON.stringify({ ok: true })}\n`;
  return "{}\n";
}

function syncResult(command, args) {
  if (/^(?:where|which)(?:\.exe)?$/.test(commandName(command))) {
    fixtureFor(command, args);
    return {
      pid: process.pid,
      status: 1,
      signal: null,
      stdout: "",
      stderr: "not found",
      output: [null, "", "not found"],
      error: undefined,
    };
  }
  const stdout = fixtureFor(command, args);
  return {
    pid: process.pid,
    status: 0,
    signal: null,
    stdout,
    stderr: "",
    output: [null, stdout, ""],
    error: undefined,
  };
}

function asyncChild(command, args) {
  const output = fixtureFor(command, args);
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  child.unref = () => child;
  queueMicrotask(() => {
    child.stdout.end(output);
    child.stderr.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

childProcess.spawnSync = function safeSpawnSync(command, args) {
  return syncResult(command, args);
};
childProcess.execFileSync = function safeExecFileSync(command, args) {
  if (/^(?:where|which)(?:\.exe)?$/.test(commandName(command))) {
    fixtureFor(command, args);
    throw Object.assign(new Error("deterministic executable absence"), { code: "ENOENT" });
  }
  if (/^(?:npm|npx)(?:\.cmd|\.exe)?$/.test(commandName(command))) {
    fixtureFor(command, args);
    throw Object.assign(new Error("deterministic package-manager absence"), { code: "ENOENT" });
  }
  return fixtureFor(command, args);
};
childProcess.execSync = function safeExecSync(command) {
  return fixtureFor(String(command).split(/\s+/)[0], []);
};
childProcess.spawn = function safeSpawn(command, args) {
  return asyncChild(command, args);
};
childProcess.execFile = function safeExecFile(command, args, options, callback) {
  const cb = typeof options === "function" ? options : callback;
  const child = asyncChild(command, args);
  if (typeof cb === "function") queueMicrotask(() => cb(null, fixtureFor(command, args), ""));
  return child;
};

function blockNetwork(api) {
  return function blockedNetwork() {
    trace("network", { api });
    throw new Error(`CONTROL_SAFE_NETWORK_BLOCKED:${api}`);
  };
}

globalThis.fetch = blockNetwork("fetch");
for (const [module, names] of [
  [http, ["request", "get"]],
  [https, ["request", "get"]],
  [net, ["connect", "createConnection"]],
  [tls, ["connect"]],
  [dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]],
]) {
  for (const name of names) {
    const prefix = module === dns ? "dns" : module === net ? "net" : module === tls ? "tls" : module === https ? "https" : "http";
    module[name] = blockNetwork(`${prefix}.${name}`);
  }
}
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
  if (dns.promises && typeof dns.promises[name] === "function") dns.promises[name] = blockNetwork(`dns.promises.${name}`);
}

trace("preload", { pid: process.pid });
syncBuiltinESMExports();
