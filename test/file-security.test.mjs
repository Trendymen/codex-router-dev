import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  preparePrivateFile,
  preparePrivateJson,
  privateFileIsProtected,
  protectPrivateFile,
  windowsAclIsPrivateForCurrentUser,
  writePrivateJson,
  windowsFullControlGrant,
} from "../src/file-security.mjs";

test("private JSON state uses one owner-only atomic writer", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-private-json-"));
  const target = path.join(directory, "state.json");
  const value = { version: 1, enabled: true };
  try {
    assert.deepEqual(writePrivateJson(target, value, { directoryMode: 0o700 }), value);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), value);
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepared private files protect an empty same-directory staging file and commit once", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-private-prepare-"));
  const target = path.join(directory, "state.json");
  try {
    const prepared = preparePrivateFile(target, { directoryMode: 0o700 });
    assert.equal(prepared.target, target);
    assert.equal(prepared.committed, false);
    assert.equal(prepared.aborted, false);
    assert.equal(readFileSync(prepared.temporary, "utf8"), "");
    if (process.platform !== "win32") assert.equal(statSync(prepared.temporary).mode & 0o777, 0o600);
    prepared.commit("prepared\n");
    assert.equal(readFileSync(target, "utf8"), "prepared\n");
    assert.equal(prepared.committed, true);
    assert.equal(prepared.aborted, false);
    assert.throws(() => prepared.commit("second\n"), /already committed/);
    prepared.abort();
    assert.equal(prepared.aborted, false, "abort after commit is a no-op");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepared staging, committed target, and compatibility JSON wrapper stay private", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-private-visibility-"));
  const target = path.join(directory, "prepared.json");
  const wrapperTarget = path.join(directory, "wrapper.json");
  try {
    const prepared = preparePrivateFile(target, { directoryMode: 0o700 });
    if (process.platform === "win32") {
      assert.equal(privateFileIsProtected(prepared.temporary), true, "prepared staging ACL is not private");
    } else {
      assert.equal(statSync(prepared.temporary).mode & 0o777, 0o600);
    }
    prepared.commit("prepared\n");
    if (process.platform === "win32") {
      assert.equal(privateFileIsProtected(target), true, "renamed target ACL is not private");
    } else {
      assert.equal(statSync(target).mode & 0o777, 0o600);
    }

    writePrivateJson(wrapperTarget, { version: 1 }, { directoryMode: 0o700 });
    if (process.platform === "win32") {
      assert.equal(privateFileIsProtected(wrapperTarget), true, "compatibility wrapper target ACL is not private");
    } else {
      assert.equal(statSync(wrapperTarget).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepared private JSON aborts idempotently and rejects commit after abort", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-private-json-prepare-"));
  const target = path.join(directory, "state.json");
  try {
    const prepared = preparePrivateJson(target, { space: 0, directoryMode: 0o700 });
    assert.equal(prepared.committed, false);
    assert.equal(prepared.aborted, false);
    prepared.abort();
    assert.equal(prepared.aborted, true);
    prepared.abort();
    assert.equal(existsSync(prepared.temporary), false);
    assert.throws(() => prepared.commit({ version: 1 }), /already aborted/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prepared private commit preserves the rename error and cleans its staging file", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-private-commit-error-"));
  const target = path.join(directory, "target-directory");
  try {
    mkdirSync(target);
    const prepared = preparePrivateFile(target);
    let thrown;
    try {
      prepared.commit("must not replace a directory\n");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "commit should preserve the rename error");
    assert.equal(existsSync(prepared.temporary), false);
    prepared.abort();
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows numeric SID grants use the icacls SID prefix", () => {
  assert.equal(
    windowsFullControlGrant("S-1-5-21-1742564184-1656218818-310408600-500"),
    "*S-1-5-21-1742564184-1656218818-310408600-500:(F)",
  );
  assert.throws(() => windowsFullControlGrant("runner@example.com"), /invalid Windows user SID/);
});

test("Windows private ACL rejects non-owner allow entries and inherited access", () => {
  const current = "S-1-5-21-101-202-303-1001";
  const owner = { sid: current, type: "Allow", inherited: false, rights: "FullControl" };
  assert.equal(windowsAclIsPrivateForCurrentUser({ protected: true, currentSid: current, rules: [owner] }), true);
  for (const sid of ["S-1-1-0", "S-1-5-32-545"]) {
    assert.equal(windowsAclIsPrivateForCurrentUser({
      protected: true,
      currentSid: current,
      rules: [owner, { sid, type: "Allow", inherited: false, rights: "ReadAndExecute" }],
    }), false);
  }
  assert.equal(windowsAclIsPrivateForCurrentUser({ protected: true, currentSid: current, rules: [{ ...owner, inherited: true }] }), false);
  assert.equal(windowsAclIsPrivateForCurrentUser({ protected: false, currentSid: current, rules: [owner] }), false);
});

test(
  "Windows private-file ACL is protected for the current identity",
  { skip: process.platform !== "win32" },
  () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-acl-"));
    const target = path.join(directory, "private.secret");
    writeFileSync(target, "TEST_ONLY\n");
    try {
      protectPrivateFile(target);
      const script = [
        "$acl = [System.IO.File]::GetAccessControl($env:CODEX_ROUTER_PRIVATE_FILE)",
        "$identity = [Security.Principal.WindowsIdentity]::GetCurrent()",
        "$rules = @($acl.Access | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited } })",
        "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentSid = $identity.User.Value; currentName = $identity.Name; rules = $rules } | ConvertTo-Json -Compress -Depth 4",
      ].join("; ");
      const acl = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_PRIVATE_FILE: target },
        },
      ).trim();
      assert.equal(privateFileIsProtected(target), true, acl);
      execFileSync("icacls.exe", [target, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
      assert.equal(privateFileIsProtected(target), false, "Everyone allow ACE must make a private file unsafe");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
