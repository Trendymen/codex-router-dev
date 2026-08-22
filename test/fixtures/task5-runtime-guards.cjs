const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const events = [];
const marker = "__TASK5_RUNTIME_GUARDS__";
const fdPaths = new Map();
const fileHandlePaths = new WeakMap();
const isolationRoot = canonicalPath(process.env.TASK5_RUNTIME_GUARD_ROOT);

function canonicalPath(value) {
  try {
    const raw = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString("utf8") : value;
    return typeof raw === "string" ? path.resolve(raw) : "";
  } catch {
    return "";
  }
}

function pathValue(value) {
  return canonicalPath(value).replaceAll("\\", "/");
}

function isCcSwitchPath(value) {
  return /(?:^|\/)\.cc-switch(?:\/|$)/.test(pathValue(value));
}

function outsideIsolation(value) {
  const target = canonicalPath(value);
  if (!isolationRoot || !target) return false;
  const relative = path.relative(isolationRoot, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function record(kind, value, extra = {}) {
  const resolved = pathValue(value);
  const event = { kind, ...(resolved ? { path: resolved } : {}), ...extra };
  if (resolved && isCcSwitchPath(value)) event.ccSwitchAccess = true;
  if (resolved && outsideIsolation(value)) event.outsideIsolation = true;
  events.push(event);
  return event;
}

function blockCcSwitch(kind, value) {
  if (!isCcSwitchPath(value)) return false;
  record(kind, value, { blocked: true });
  throw new Error("CC Switch database access is blocked by the Task 5 runtime guard.");
}

function trackedPath(value) {
  if (typeof value === "number") return fdPaths.get(value);
  if (value && typeof value === "object") return fileHandlePaths.get(value);
  return value;
}

function blockOutsideMutation(kind, value) {
  const target = trackedPath(value);
  if (!outsideIsolation(target)) return false;
  record(kind, target, { blocked: true });
  throw new Error("Task 5 runtime guard blocked mutation outside isolated root.");
}

function blockMutationTarget(kind, value) {
  const target = trackedPath(value);
  blockCcSwitch(kind, target);
  blockOutsideMutation(kind, target);
}

function blockPathArguments(kind, args, indices) {
  for (const index of indices) blockCcSwitch(kind, args[index]);
}

function mutationOpenFlags(flags) {
  if (typeof flags === "string") return /[wa+]/.test(flags);
  if (!Number.isInteger(flags)) return false;
  const { O_WRONLY = 0, O_RDWR = 0, O_CREAT = 0, O_TRUNC = 0, O_APPEND = 0 } = fs.constants;
  return Boolean(flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND));
}

function recordPathOrDescriptor(kind, value, extra = {}) {
  const target = trackedPath(value);
  if (typeof value === "number") {
    record(kind, target, { fd: value, ...extra });
    return;
  }
  if (value && typeof value === "object" && target !== undefined) {
    record(kind, target, extra);
    return;
  }
  record(kind, target, extra);
}

function guardFileHandle(handle, target) {
  if (!handle || typeof handle !== "object" || fileHandlePaths.has(handle)) return handle;
  fileHandlePaths.set(handle, target);
  for (const name of [
    "write", "writev", "writeFile", "appendFile", "truncate", "chmod", "chown", "utimes",
    "sync", "datasync", "createWriteStream",
  ]) {
    if (typeof handle[name] !== "function") continue;
    const original = handle[name];
    handle[name] = function guardedFileHandleMutation(...args) {
      blockMutationTarget(`fs.promises.FileHandle.${name}`, target);
      record(`fs.promises.FileHandle.${name}`, target);
      return original.apply(this, args);
    };
  }
  if (typeof handle.close === "function") {
    const originalClose = handle.close;
    handle.close = function guardedFileHandleClose(...args) {
      const result = originalClose.apply(this, args);
      Promise.resolve(result).finally(() => fileHandlePaths.delete(handle));
      return result;
    };
  }
  return handle;
}

function wrapPathOperation(name, { mutation = false, paths = [0], pathOrDescriptor = false } = {}) {
  const original = fs[name];
  if (typeof original !== "function") return;
  fs[name] = function guardedFsOperation(...args) {
    if (mutation) {
      for (const index of paths) blockMutationTarget(`fs.${name}`, args[index]);
    } else {
      blockPathArguments(`fs.${name}`, args, paths);
    }
    if (mutation) {
      for (const index of paths) {
        if (pathOrDescriptor && index === 0) recordPathOrDescriptor(`fs.${name}`, args[index]);
        else record(`fs.${name}`, args[index]);
      }
    }
    return original.apply(this, args);
  };
}

function wrapOpen(name, sync) {
  const original = fs[name];
  if (typeof original !== "function") return;
  fs[name] = function guardedOpen(...args) {
    const writes = mutationOpenFlags(args[1]);
    if (writes) blockMutationTarget(`fs.${name}`, args[0]);
    else blockCcSwitch(`fs.${name}`, args[0]);
    if (writes) record(`fs.${name}`, args[0], { ...(typeof args[1] === "number" ? { numericOpenFlags: true } : {}) });
    if (sync) {
      const fd = original.apply(this, args);
      fdPaths.set(fd, canonicalPath(args[0]));
      return fd;
    }
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === "function") {
      const callback = args[callbackIndex];
      args[callbackIndex] = function guardedOpenCallback(error, fd, ...rest) {
        if (!error && typeof fd === "number") fdPaths.set(fd, canonicalPath(args[0]));
        return callback.call(this, error, fd, ...rest);
      };
    }
    return original.apply(this, args);
  };
}

function wrapClose(name, sync) {
  const original = fs[name];
  if (typeof original !== "function") return;
  fs[name] = function guardedClose(...args) {
    const fd = args[0];
    if (sync) {
      const result = original.apply(this, args);
      fdPaths.delete(fd);
      return result;
    }
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === "function") {
      const callback = args[callbackIndex];
      args[callbackIndex] = function guardedCloseCallback(error, ...rest) {
        if (!error) fdPaths.delete(fd);
        return callback.call(this, error, ...rest);
      };
    }
    return original.apply(this, args);
  };
}

function wrapDescriptorMutation(name) {
  const original = fs[name];
  if (typeof original !== "function") return;
  fs[name] = function guardedDescriptorMutation(...args) {
    blockMutationTarget(`fs.${name}`, args[0]);
    recordPathOrDescriptor(`fs.${name}`, args[0]);
    return original.apply(this, args);
  };
}

for (const name of [
  "access", "accessSync", "existsSync", "lstat", "lstatSync", "opendir", "opendirSync",
  "readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync",
  "realpath", "realpathSync", "stat", "statSync", "statfs", "statfsSync", "watch",
  "watchFile", "unwatchFile", "createReadStream",
]) wrapPathOperation(name);
wrapOpen("open", false);
wrapOpen("openSync", true);
wrapClose("close", false);
wrapClose("closeSync", true);
wrapPathOperation("createWriteStream", { mutation: true });
for (const name of [
  "appendFile", "appendFileSync", "chmod", "chmodSync", "lchown", "lchownSync", "lutimes",
  "lutimesSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rm", "rmSync", "truncate",
  "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "writeFile", "writeFileSync",
]) wrapPathOperation(name, { mutation: true, pathOrDescriptor: ["appendFile", "appendFileSync", "writeFile", "writeFileSync"].includes(name) });
for (const name of ["copyFile", "copyFileSync", "cp", "cpSync", "rename", "renameSync", "link", "linkSync", "symlink", "symlinkSync"]) {
  wrapPathOperation(name, { mutation: true, paths: [0, 1] });
}
for (const name of [
  "write", "writeSync", "writev", "writevSync", "ftruncate", "ftruncateSync", "fchmod", "fchmodSync",
  "fchown", "fchownSync", "futimes", "futimesSync", "fdatasync", "fdatasyncSync", "fsync", "fsyncSync",
]) wrapDescriptorMutation(name);

function wrapPromisePathOperation(name, { mutation = false, paths = [0], pathOrDescriptor = false } = {}) {
  const original = fs.promises[name];
  if (typeof original !== "function") return;
  fs.promises[name] = function guardedPromiseOperation(...args) {
    if (mutation) {
      for (const index of paths) blockMutationTarget(`fs.promises.${name}`, args[index]);
    } else {
      blockPathArguments(`fs.promises.${name}`, args, paths);
    }
    if (mutation) {
      for (const index of paths) {
        if (pathOrDescriptor && index === 0) recordPathOrDescriptor(`fs.promises.${name}`, args[index]);
        else record(`fs.promises.${name}`, args[index]);
      }
    }
    return original.apply(this, args);
  };
}

for (const name of ["access", "lstat", "opendir", "readFile", "readdir", "readlink", "realpath", "stat", "statfs", "watch"]) {
  wrapPromisePathOperation(name);
}
for (const name of [
  "appendFile", "chmod", "chown", "lchown", "lutimes", "mkdir", "mkdtemp", "rm", "truncate", "unlink",
  "utimes", "writeFile",
]) wrapPromisePathOperation(name, { mutation: true, pathOrDescriptor: ["appendFile", "writeFile"].includes(name) });
for (const name of ["copyFile", "cp", "rename", "link", "symlink"]) {
  wrapPromisePathOperation(name, { mutation: true, paths: [0, 1] });
}

if (typeof fs.promises.open === "function") {
  const originalOpen = fs.promises.open;
  fs.promises.open = function guardedPromiseOpen(...args) {
    const writes = mutationOpenFlags(args[1]);
    if (writes) blockMutationTarget("fs.promises.open", args[0]);
    else blockCcSwitch("fs.promises.open", args[0]);
    if (writes) record("fs.promises.open", args[0], { ...(typeof args[1] === "number" ? { numericOpenFlags: true } : {}) });
    return originalOpen.apply(this, args).then((handle) => guardFileHandle(handle, canonicalPath(args[0])));
  };
}

for (const name of ["execFile", "execFileSync", "spawn", "spawnSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function guardedChildOperation(...args) {
    if (args.some((value) => String(value || "").includes("config-manager.mjs"))) record("config-manager", "");
    // Windows ACL probes are external host behavior, not Router state. Keep
    // the isolation test from creating PowerShell's first-run cache while
    // retaining the normal affirmative result the doctor needs for its check.
    if (String(args[0]).toLowerCase() === "powershell.exe") return name.endsWith("Sync") ? "true" : undefined;
    return original.apply(this, args);
  };
}

syncBuiltinESMExports();
process.on("exit", () => {
  process.stderr.write(`${marker}${JSON.stringify(events)}\n`);
});
