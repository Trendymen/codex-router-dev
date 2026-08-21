const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const events = [];
const marker = "__TASK5_RUNTIME_GUARDS__";

function pathValue(value) {
  try {
    const raw = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString("utf8") : value;
    return typeof raw === "string" ? path.resolve(raw).replaceAll("\\", "/") : "";
  } catch { return ""; }
}

function isCcSwitchPath(value) {
  return /(?:^|\/)\.cc-switch(?:\/|$)/.test(pathValue(value));
}

function record(kind, value, extra = {}) {
  const event = { kind, ...extra };
  if (isCcSwitchPath(value)) event.ccSwitchAccess = true;
  events.push(event);
  return event;
}

function blockCcSwitch(kind, value) {
  if (!isCcSwitchPath(value)) return false;
  record(kind, value, { blocked: true });
  throw new Error("CC Switch database access is blocked by the Task 5 runtime guard.");
}

function mutationOpenFlags(flags) {
  return typeof flags === "string" && /[wa+]/.test(flags);
}

function wrapFs(name, { mutation = false, open = false, stream = false } = {}) {
  const original = fs[name];
  if (typeof original !== "function") return;
  fs[name] = function guardedFsOperation(...args) {
    if (blockCcSwitch(`fs.${name}`, args[0])) return undefined;
    if (mutation || stream || (open && mutationOpenFlags(args[1]))) record(`fs.${name}`, args[0]);
    return original.apply(this, args);
  };
}

for (const name of [
  "access", "accessSync", "existsSync", "lstat", "lstatSync", "open", "openSync",
  "opendir", "opendirSync", "readFile", "readFileSync", "readdir", "readdirSync",
  "readlink", "readlinkSync", "realpath", "realpathSync", "stat", "statSync",
  "statfs", "statfsSync", "watch", "watchFile", "unwatchFile", "createReadStream",
]) wrapFs(name);
for (const name of ["open", "openSync"]) wrapFs(name, { open: true });
wrapFs("createWriteStream", { stream: true });

for (const name of [
  "appendFile", "appendFileSync", "chmod", "chmodSync", "copyFile", "copyFileSync",
  "chown", "chownSync", "cp", "cpSync", "lchown", "lchownSync", "link", "linkSync",
  "lutimes", "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rename", "renameSync", "rm", "rmSync",
  "symlink", "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync",
  "writeFile", "writeFileSync",
]) wrapFs(name, { mutation: true });

function wrapPromise(name, { mutation = false, open = false } = {}) {
  const original = fs.promises[name];
  if (typeof original !== "function") return;
  fs.promises[name] = async function guardedPromiseOperation(...args) {
    if (blockCcSwitch(`fs.promises.${name}`, args[0])) return undefined;
    if (mutation || (open && mutationOpenFlags(args[1]))) record(`fs.promises.${name}`, args[0]);
    const result = await original.apply(this, args);
    if (name === "open") {
      for (const method of ["write", "writeFile", "appendFile", "truncate", "createWriteStream"]) {
        if (typeof result[method] !== "function") continue;
        const originalMethod = result[method].bind(result);
        result[method] = async (...methodArgs) => {
          record(`fs.promises.FileHandle.${method}`, args[0]);
          return originalMethod(...methodArgs);
        };
      }
    }
    return result;
  };
}

for (const name of ["access", "lstat", "opendir", "readFile", "readdir", "readlink", "realpath", "stat", "statfs", "watch"]) {
  wrapPromise(name);
}
wrapPromise("open", { open: true });
for (const name of ["appendFile", "chmod", "chown", "copyFile", "cp", "lchown", "link", "lutimes", "mkdir", "mkdtemp", "rename", "rm", "symlink", "truncate", "unlink", "utimes", "writeFile"]) {
  wrapPromise(name, { mutation: true });
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
