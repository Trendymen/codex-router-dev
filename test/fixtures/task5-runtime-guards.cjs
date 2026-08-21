const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const events = [];
const marker = "__TASK5_RUNTIME_GUARDS__";

function pathValue(value) {
  return typeof value === "string" ? value.replaceAll("\\", "/") : "";
}

function record(kind, value) {
  const target = pathValue(value);
  events.push({
    kind,
    ...(target.includes("/.cc-switch/") ? { ccSwitchAccess: true } : {}),
  });
}

for (const name of [
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "copyFile",
  "copyFileSync",
  "mkdir",
  "mkdirSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "writeFile",
  "writeFileSync",
]) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function guardedFsOperation(...args) {
    record(`fs.${name}`, args[0]);
    return original.apply(this, args);
  };
}

for (const name of ["writeFile", "appendFile", "mkdir", "rename", "rm", "unlink", "chmod", "copyFile"]) {
  const original = fs.promises[name];
  if (typeof original !== "function") continue;
  fs.promises[name] = async function guardedPromiseOperation(...args) {
    record(`fs.promises.${name}`, args[0]);
    return original.apply(this, args);
  };
}

for (const name of ["execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedChildOperation(...args) {
    if (args.some((value) => String(value || "").includes("config-manager.mjs"))) {
      record("config-manager", "");
    }
    // Windows ACL probes are external host behavior, not Router state. Keep
    // the isolation test from creating PowerShell's first-run cache while
    // retaining the normal affirmative result the doctor needs for its check.
    if (String(args[0]).toLowerCase() === "powershell.exe") {
      return name.endsWith("Sync") ? "true" : undefined;
    }
    return original.apply(this, args);
  };
}

syncBuiltinESMExports();
process.on("exit", () => {
  process.stderr.write(`${marker}${JSON.stringify(events)}\n`);
});
