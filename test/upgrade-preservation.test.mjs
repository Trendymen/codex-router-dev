import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveServiceTarget } from "../src/service-target.mjs";
import {
  ownedRuntimePaths,
  removeOwnedRuntime,
  resolveOwnedArtifact,
  restoreOwnedRuntime,
  snapshotOwnedRuntime,
} from "../src/owned-runtime-paths.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-preserve-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: process.platform,
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-test",
    trayLabel: "com.example.codex-router-test.tray",
    ports: { oauth: 46101, router: 46102, api: 46103, grokOauth: 46108, devinCli: 46110 },
  });
  mkdirSync(path.dirname(target.routerPlistPath), { recursive: true });
  mkdirSync(target.stateRoot, { recursive: true });
  writeFileSync(target.routerPlistPath, "old-router-plist\n", { mode: process.platform === "win32" ? 0o640 : 0o2640 });
  if (process.platform !== "win32") chmodSync(target.routerPlistPath, 0o2640);
  const caller = path.join(target.stateRoot, "caller-secret");
  writeFileSync(caller, "caller-secret-that-must-survive\n", { mode: 0o600 });
  chmodSync(caller, 0o600);
  const runtimeRoots = {
    userHome: root,
    codexHome: root,
    dshHome: path.join(root, "dsh"),
    geminiHome: path.join(root, "gemini"),
  };
  return { root, target, runtimeRoots, paths: ownedRuntimePaths(target, runtimeRoots) };
}

test("runtime snapshots preserve exact bytes, existence, and mode before replacement", () => {
  const { root, target, paths } = fixture();
  try {
    const snapshot = snapshotOwnedRuntime(paths);
    assert.equal(snapshot.version, 2);
    assert.equal(snapshot.entries["router-plist"].existed, true);
    assert.deepEqual(snapshot.entries["router-plist"].bytes, Buffer.from("old-router-plist\n"));
    assert.equal(snapshot.entries["router-plist"].mode, statSync(target.routerPlistPath).mode & 0o7777);
    assert.equal(snapshot.entries["tray-plist"].existed, false);
    assert.equal(snapshot.entries["caller-secret"].protected, true);

    writeFileSync(target.routerPlistPath, "replacement\n", { mode: 0o600 });
    restoreOwnedRuntime(snapshot);
    assert.deepEqual(readFileSync(target.routerPlistPath), Buffer.from("old-router-plist\n"));
    assert.equal(statSync(target.routerPlistPath).mode & 0o7777, snapshot.entries["router-plist"].mode);
    assert.equal(existsSync(target.trayPlistPath), false);
    assert.deepEqual(readFileSync(path.join(target.stateRoot, "caller-secret")), Buffer.from("caller-secret-that-must-survive\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned artifact resolution is closed, root-contained, and link-safe", () => {
  const { root, target, paths } = fixture();
  try {
    assert.equal(resolveOwnedArtifact("router-plist", paths), target.routerPlistPath);
    for (const id of ["../config.toml", "*", "runtime/**", "unknown-artifact", "stateRoot"]) {
      assert.throws(() => resolveOwnedArtifact(id, paths), /unknown|allowlist|traversal|broad|wildcard|absolute/i, id);
    }

    const escape = path.join(root, "outside");
    writeFileSync(escape, "outside\n");
    const link = path.join(target.stateRoot, "caller-secret");
    try {
      // The named allowlist entry is deliberately replaced by a link. Resolver
      // must reject the link rather than trusting path.relative alone.
      rmSync(path.join(target.stateRoot, "caller-secret"), { force: true });
      let linked = false;
      if (process.platform === "win32") {
        try {
          symlinkSync(escape, link, "file");
          linked = true;
        } catch (error) {
          assert.match(String(error?.message || error), /privilege|symbolic|not permitted|access/i);
        }
      } else {
        symlinkSync(escape, link);
        linked = true;
      }
      if (linked) {
        assert.throws(() => resolveOwnedArtifact("caller-secret", paths), /symlink|junction|link/i);
      }
    } finally {
      rmSync(link, { force: true });
      rmSync(path.join(target.stateRoot, "caller-secret"), { force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("directory snapshots restore every nested byte/mode and remove replacement residue", () => {
  const { root, target, paths } = fixture();
  try {
    const nested = path.join(target.appPath, "Contents", "Resources", "old.txt");
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, "old nested bytes\n", { mode: 0o640 });
    const snapshot = snapshotOwnedRuntime(paths);
    assert.equal(snapshot.entries["tray-app"].type, "directory");
    assert.ok(snapshot.entries["tray-app"].tree.some((entry) => entry.relative === "Contents/Resources/old.txt"));

    rmSync(target.appPath, { recursive: true, force: true });
    mkdirSync(path.join(target.appPath, "Contents", "Resources"), { recursive: true });
    writeFileSync(path.join(target.appPath, "replacement-residue.txt"), "must disappear\n", { mode: 0o600 });
    restoreOwnedRuntime(snapshot);

    assert.deepEqual(readFileSync(nested), Buffer.from("old nested bytes\n"));
    if (process.platform !== "win32") assert.equal(statSync(nested).mode & 0o7777, 0o640);
    assert.equal(existsSync(path.join(target.appPath, "replacement-residue.txt")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup preflights directory ownership and never deletes a foreign child", () => {
  const { root, paths } = fixture();
  try {
    const legacy = resolveOwnedArtifact("legacy-venv", paths);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "pyvenv.cfg"), "home = C:/Python\nversion = 3.12\n", { mode: 0o640 });
    mkdirSync(path.join(legacy, "bin"), { recursive: true });
    writeFileSync(path.join(legacy, "bin", "known-runtime.dat"), "known\n", { mode: 0o640 });
    const snapshot = snapshotOwnedRuntime(paths);
    writeFileSync(path.join(legacy, "foreign-decoy.txt"), "foreign\n", { mode: 0o600 });
    assert.throws(
      () => removeOwnedRuntime(paths, { ids: ["legacy-venv"], snapshot }),
      /foreign|ownership|snapshot|unexpected/i,
    );
    assert.equal(existsSync(path.join(legacy, "bin", "known-runtime.dat")), true);
    assert.equal(existsSync(path.join(legacy, "foreign-decoy.txt")), true);

    rmSync(path.join(legacy, "foreign-decoy.txt"), { force: true });
    assert.deepEqual(removeOwnedRuntime(paths, { ids: ["legacy-venv"], snapshot }), [legacy]);
    assert.equal(existsSync(legacy), false);
    assert.throws(() => removeOwnedRuntime(paths, { ids: ["state-catalog"], snapshot }), /cleanup|catalog|protected|allowlist/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot refuses an already-present foreign legacy directory before any cleanup", () => {
  const { root, paths } = fixture();
  try {
    const legacy = resolveOwnedArtifact("legacy-venv", paths);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "foreign-router-state.json"), "foreign\n");
    assert.throws(() => snapshotOwnedRuntime(paths), /ownership|foreign|legacy|marker|recognized/i);
    assert.equal(existsSync(path.join(legacy, "foreign-router-state.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime roots require a resolver-branded ServiceTarget", () => {
  const { root, target } = fixture();
  try {
    assert.throws(() => ownedRuntimePaths({ ...target }), /validated|ServiceTarget|brand/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nonproduction runtime roots cannot escape the resolver-owned isolation root", () => {
  const { root, target } = fixture();
  try {
    assert.throws(() => ownedRuntimePaths(target, {
      userHome: path.dirname(root),
      codexHome: root,
      dshHome: root,
      geminiHome: root,
    }), /isolationRoot|inside|outside/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed backup rollback keeps the backup path and reports rollback failure", () => {
  const { root, target, paths } = fixture();
  try {
    const snapshot = snapshotOwnedRuntime(paths);
    let renames = 0;
    const primaryRestoreFs = {
      rename(from, to) {
        renames += 1;
        // 1: target -> backup, 2: staging -> target, 3: backup -> target.
        if (renames === 3) throw new Error("rollback rename failed");
        renameSync(from, to);
      },
      chmod(file, mode) {
        if (renames === 2 && file === target.routerPlistPath) throw new Error("post-commit restore failure");
        chmodSync(file, mode);
      },
    };
    assert.throws(
      () => restoreOwnedRuntime(snapshot, { fs: primaryRestoreFs }),
      (error) => error instanceof AggregateError && /rollback rename failed/.test(String(error.errors?.[1]?.message || error.message)),
    );
    const leftovers = readdirSync(path.dirname(target.routerPlistPath));
    assert.ok(leftovers.some((name) => name.includes("runtime-backup")), "failed rollback must retain backup evidence");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected skills, shim, user documents, and every provider credential survive restore", () => {
  const { root, paths } = fixture();
  const protectedIds = [
    "codex-config", "codex-auth", "codex-history", "codex-backup", "codex-skills", "skill-ownership", "codex-shim",
    "dsh-settings", "dsh-credentials", "gemini-env", "kimi-oauth-session", "grok-oauth-session",
    "devin-credentials", "credential-deepseek", "credential-qwen-plan", "credential-anthropic",
    "credential-kimi", "credential-kimi-cn", "credential-grok", "credential-zai", "credential-zai-api",
    "credential-commandcode", "credential-github-copilot", "credential-gemini", "credential-minimax",
    "credential-ollama-cloud", "credential-opencode-go", "credential-chutes", "credential-cerebras",
    "credential-fireworks", "credential-groq", "credential-huggingface", "credential-meta",
    "credential-mistral", "credential-nvidia-nim", "credential-openrouter", "credential-siliconflow",
    "credential-together", "credential-xiaomi-mimo", "credential-clinepass",
  ];
  try {
    const originals = new Map();
    for (const id of protectedIds) {
      const file = paths.protected[id];
      if (id === "codex-skills") {
        mkdirSync(path.join(file, "managed-skill"), { recursive: true });
        writeFileSync(path.join(file, "managed-skill", "SKILL.md"), `original-${id}\n`);
        originals.set(id, readFileSync(path.join(file, "managed-skill", "SKILL.md")));
      } else {
        mkdirSync(path.dirname(file), { recursive: true });
        const mode = id === "codex-config" ? 0o640 : id === "codex-auth" ? 0o400 : 0o600;
        writeFileSync(file, `original-${id}\n`, { mode });
        if (process.platform !== "win32") chmodSync(file, mode);
        originals.set(id, readFileSync(file));
      }
    }
    const snapshot = snapshotOwnedRuntime(paths);
    for (const id of protectedIds) {
      const file = paths.protected[id];
      if (id === "codex-skills") {
        rmSync(file, { recursive: true, force: true });
        mkdirSync(file, { recursive: true });
        writeFileSync(path.join(file, "foreign.txt"), "foreign\n");
      } else {
        chmodSync(file, 0o600);
        writeFileSync(file, "replacement\n");
      }
    }
    restoreOwnedRuntime(snapshot, { fs: { protect: () => {}, verifyProtected: () => true } });
    for (const id of protectedIds) {
      const file = paths.protected[id];
      const actual = id === "codex-skills" ? readFileSync(path.join(file, "managed-skill", "SKILL.md")) : readFileSync(file);
      assert.deepEqual(actual, originals.get(id), id);
      if (process.platform !== "win32" && id === "codex-config") assert.equal(statSync(file).mode & 0o7777, 0o640);
      if (process.platform !== "win32" && id === "codex-auth") assert.equal(statSync(file).mode & 0o7777, 0o400);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging writes bytes, final metadata, file flush, close, then rename", () => {
  const { root, target, paths } = fixture();
  try {
    const snapshot = snapshotOwnedRuntime({ ...paths, ids: ["router-plist"] });
    const order = [];
    restoreOwnedRuntime(snapshot, {
      fs: {
        open(file, flags, mode) { order.push(`open:${flags}`); return openSync(file, flags, mode); },
        writeFd(fd, bytes, offset, length, position) { order.push("write"); return writeSync(fd, bytes, offset, length, position); },
        chmodFd(fd, mode) { order.push("metadata"); return fchmodSync(fd, mode); },
        fsync(fd) { order.push("fsync"); return fsyncSync(fd); },
        close(fd) { order.push("close"); return closeSync(fd); },
        rename(from, to) { order.push("rename"); return renameSync(from, to); },
      },
    });
    assert.ok(order.indexOf("write") < order.indexOf("metadata"));
    assert.ok(order.indexOf("metadata") < order.indexOf("fsync"));
    assert.ok(order.indexOf("fsync") < order.indexOf("close"));
    assert.ok(order.indexOf("close") < order.indexOf("rename"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
