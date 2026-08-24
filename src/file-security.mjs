import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

let windowsSid;

// Windows keeps these protected-file owner ACEs after icacls removes
// inheritance on hosted runners.  Use their numeric SIDs because localized
// account names are not a stable security boundary.
const WINDOWS_TRUSTED_PRIVATE_FILE_SIDS = new Set([
  "S-1-5-18", // LocalSystem
  "S-1-5-32-544", // BUILTIN\\Administrators
]);

function currentWindowsSid() {
  if (windowsSid) return windowsSid;
  const script =
    "[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)";
  windowsSid = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (!windowsSid) throw new Error("Could not resolve the current Windows user SID.");
  return windowsSid;
}

export function windowsFullControlGrant(sid) {
  if (!/^S-\d+(?:-\d+)+$/i.test(sid)) {
    throw new Error("Could not format an invalid Windows user SID.");
  }
  // icacls requires an asterisk before a numeric SID so it is not resolved as
  // an account name. Without it, hosted runners fail with system error 1332.
  return `*${sid}:(F)`;
}

/**
 * `protectPrivateFile` deliberately produces a closed ACL: explicit,
 * non-inherited FullControl allows for the current SID and Windows' trusted
 * system owner SIDs only. Treat anything wider as unsafe rather than trying
 * to infer whether a group is harmless.
 */
export function windowsAclIsPrivateForCurrentUser({ protected: rulesProtected, currentSid, rules } = {}) {
  if (rulesProtected !== true || !/^S-\d+(?:-\d+)+$/i.test(String(currentSid || "")) || !Array.isArray(rules) || rules.length === 0) return false;
  const trustedSids = new Set([currentSid, ...WINDOWS_TRUSTED_PRIVATE_FILE_SIDS]);
  const trustedRule = (rule) => rule
    && rule.inherited !== true
    && rule.type === "Allow"
    && trustedSids.has(rule.sid)
    && String(rule.rights || "").split(",").map((right) => right.trim()).includes("FullControl");
  return rules.some((rule) => trustedRule(rule) && rule.sid === currentSid)
    && rules.every(trustedRule);
}

export function protectPrivateFile(target) {
  chmodSync(target, 0o600);
  if (process.platform !== "win32") return target;
  const sid = currentWindowsSid();
  execFileSync(
    "icacls.exe",
    [target, "/inheritance:r", "/grant:r", windowsFullControlGrant(sid)],
    { stdio: "ignore" },
  );
  return target;
}

function removePreparedFile(temporary) {
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function preparedStateError(action, state) {
  return new Error(`Cannot ${action} private file: it is already ${state}.`);
}

/**
 * Stage an owner-only private file before entering a caller's critical
 * section.  The empty file is created and protected while its descriptor is
 * closed; commit only writes that already-protected file and atomically
 * renames it into place.  This is important on Windows where ACL discovery
 * and icacls are process-wide work that must not be serialized under a lock.
 */
export function preparePrivateFile(target, { directoryMode } = {}) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (directoryMode !== undefined) chmodSync(directory, directoryMode);
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    // wx makes the staging name a single-writer claim even when multiple
    // callers prepare the same target concurrently.
    writeFileSync(temporary, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    protectPrivateFile(temporary);
  } catch (error) {
    try {
      removePreparedFile(temporary);
    } catch {
      // The preparation error is the useful identity.  Cleanup is best effort
      // here and a caller cannot safely commit a state it never received.
    }
    throw error;
  }

  let state = "prepared";
  return {
    target,
    temporary,
    get committed() { return state === "committed"; },
    get aborted() { return state === "aborted"; },
    commit(contents) {
      if (state === "committed") throw preparedStateError("commit", "committed");
      if (state === "aborted") throw preparedStateError("commit", "aborted");
      try {
        // Re-open and truncate only after the protected descriptor from the
        // prepare phase has been closed.  The ACL therefore survives without
        // another SID lookup or icacls invocation.
        writeFileSync(temporary, contents, { encoding: "utf8", flag: "w", mode: 0o600 });
        renameSync(temporary, target);
        state = "committed";
        return target;
      } catch (error) {
        try {
          removePreparedFile(temporary);
          state = "aborted";
        } catch {
          // Keep the original write/rename error.  An explicit abort can retry
          // cleanup while the state remains prepared.
        }
        throw error;
      }
    },
    abort() {
      if (state === "committed" || state === "aborted") return false;
      removePreparedFile(temporary);
      state = "aborted";
      return true;
    },
  };
}

export function preparePrivateJson(target, { space = 2, directoryMode } = {}) {
  const prepared = preparePrivateFile(target, { directoryMode });
  return {
    target: prepared.target,
    temporary: prepared.temporary,
    get committed() { return prepared.committed; },
    get aborted() { return prepared.aborted; },
    commit(value) {
      return prepared.commit(`${JSON.stringify(value, null, space)}\n`);
    },
    abort() {
      return prepared.abort();
    },
  };
}

// All private JSON state uses the same temp-file, owner-only, atomic replace.
// Keeping it here prevents one state writer from drifting away from the rest.
export function writePrivateFile(target, contents, { directoryMode } = {}) {
  const prepared = preparePrivateFile(target, { directoryMode });
  try {
    prepared.commit(contents);
  } catch (error) {
    try {
      prepared.abort();
    } catch {
      // Preserve the original write/rename error identity.
    }
    throw error;
  }
  return target;
}

export function writePrivateJson(target, value, { space = 2, directoryMode } = {}) {
  writePrivateFile(target, `${JSON.stringify(value, null, space)}\n`, { directoryMode });
  return value;
}

export function privateFileIsProtected(target) {
  if (!existsSync(target)) return false;
  if (process.platform !== "win32") return (statSync(target).mode & 0o777) === 0o600;
  const script = [
    // Get-Acl lazy-loads Microsoft.PowerShell.Security, which can fail under
    // concurrent Windows processes. The .NET API returns the same FileSecurity
    // object without importing a PowerShell module.
    "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
    "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$rules = @($acl.Access | ForEach-Object { $ruleSid = ''; try { $ruleSid = $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch {}; [pscustomobject]@{ sid = $ruleSid; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() } })",
    "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentSid = $identity.User.Value; rules = $rules } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const acl = JSON.parse(output);
    return windowsAclIsPrivateForCurrentUser({ ...acl, rules: Array.isArray(acl?.rules) ? acl.rules : [acl?.rules] });
  } catch {
    return false;
  }
}
