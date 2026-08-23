const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;

function scriptName(args) {
  const script = Array.isArray(args) ? args.find((value) => typeof value === "string" && value.endsWith(".mjs")) : undefined;
  return script ? path.basename(script) : "";
}

childProcess.spawnSync = function safeSpawnSync(command, args, options) {
  const script = scriptName(args);
  if (["service.mjs", "doctor.mjs", "update.mjs", "catalog.mjs", "config-manager.mjs", "node-snapshot-triggers.mjs", "tray-service.mjs"].includes(script)) {
    const stdout = script === "doctor.mjs"
      ? `${JSON.stringify({ checks: [] })}\n`
      : script === "service.mjs"
        ? `${JSON.stringify({ state: "running" })}\n`
        : script === "update.mjs"
          ? `${JSON.stringify({ updated: true })}\n`
          : "{}\n";
    return { pid: process.pid, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""], error: undefined };
  }
  // Rollback/update owns the git checkout and is the one command that must not
  // reach the shared repository from this isolated bridge oracle.
  if (String(command).toLowerCase().endsWith("git.exe") || String(command).toLowerCase() === "git") {
    return { pid: process.pid, status: 1, signal: null, stdout: "", stderr: "isolated git stub", output: [null, "", "isolated git stub"], error: undefined };
  }
  return originalSpawnSync.apply(this, arguments);
};

childProcess.spawn = function safeSpawn(command, args) {
  if (scriptName(args) === "vision-download.mjs") {
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => child;
    return child;
  }
  return originalSpawn.apply(this, arguments);
};

syncBuiltinESMExports();
