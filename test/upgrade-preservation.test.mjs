import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
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
import upgradePlatformOracle from "./acceptance/oracles/upgrade-platform.json" with { type: "json" };

const MANAGED_CATALOG_FILES = [
  "merged-models.json",
  "routed-models.json",
  "node-routes.json",
  "control-models.json",
  "swift-models.json",
  "browser-models.json",
];

function installManagedCatalogTopology(target, label = "snapshot") {
  const generations = path.join(target.stateRoot, "catalog-generations");
  const generation = `generation-${label}`;
  const generationDir = path.join(generations, generation);
  mkdirSync(generationDir, { recursive: true, mode: 0o700 });
  for (const name of MANAGED_CATALOG_FILES) {
    writeFileSync(path.join(generationDir, name), `${name}:${label}\n`, { mode: 0o600 });
    chmodSync(path.join(generationDir, name), 0o600);
  }
  symlinkSync(generation, path.join(generations, "current"), "dir");
  for (const name of MANAGED_CATALOG_FILES) {
    symlinkSync(`catalog-generations/current/${name}`, path.join(target.stateRoot, name), "file");
  }
  return { generation, generationDir };
}

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

test("Appendix G upgrade consumer dispatches every checked-in upgrade/platform oracle row", () => {
  const { root, paths } = fixture();
  try {
    const dispatch = {
      "upgrade-preservation": ({ contract }) => {
        const snapshot = snapshotOwnedRuntime(paths);
        assert.equal(snapshot.version, contract.expected.snapshotVersion, contract.fixture);
        assert.equal(snapshot.entries["router-plist"].bytes.toString("utf8"), contract.expected.routerPlist.replace("\\n", "\n"), contract.fixture);
      },
    };
    const rows = upgradePlatformOracle.rows.filter(({ id }) => id === "upgrade-preservation");
    assert.deepEqual(Object.keys(dispatch).sort(), rows.map(({ id }) => id).sort());
    for (const row of rows) dispatch[row.id](row);
  }
  finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("managed catalog topology snapshots the authoritative generation instead of rejecting its six stable links", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    const topology = installManagedCatalogTopology(target);
    const paths = ownedRuntimePaths(target, runtimeRoots);
    const snapshot = snapshotOwnedRuntime(paths);
    assert.equal(snapshot.catalogTopology.generation, topology.generation);
    assert.equal(snapshot.entries["state-catalog"].type, "catalog-topology-link");
    assert.deepEqual(snapshot.catalogTopology.files["merged-models.json"].bytes, Buffer.from("merged-models.json:snapshot\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed catalog topology recreates a private generation when the snapshotted authority was deleted", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    const topology = installManagedCatalogTopology(target, "deleted");
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    rmSync(topology.generationDir, { recursive: true, force: true });

    restoreOwnedRuntime(snapshot);

    const current = readlinkSync(path.join(target.stateRoot, "catalog-generations", "current"));
    assert.match(current, /^restore-/);
    for (const name of MANAGED_CATALOG_FILES) {
      const restored = path.join(target.stateRoot, "catalog-generations", current, name);
      assert.deepEqual(readFileSync(restored), Buffer.from(`${name}:deleted\n`));
      assert.equal(statSync(restored).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed catalog topology does not reuse a generation whose captured bytes no longer match", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    const topology = installManagedCatalogTopology(target, "changed");
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    writeFileSync(path.join(topology.generationDir, "merged-models.json"), "mutated\n", { mode: 0o600 });
    chmodSync(path.join(topology.generationDir, "merged-models.json"), 0o600);

    restoreOwnedRuntime(snapshot);

    const current = readlinkSync(path.join(target.stateRoot, "catalog-generations", "current"));
    assert.match(current, /^restore-/);
    assert.notEqual(current, topology.generation);
    assert.deepEqual(readFileSync(path.join(target.stateRoot, "catalog-generations", current, "merged-models.json")), Buffer.from("merged-models.json:changed\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed catalog topology rejects dangling, redirected, and hard-linked catalog authorities", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const cases = ["dangling-stable", "redirected-stable", "hard-linked-generation"];
  for (const label of cases) {
    const { root, target, runtimeRoots } = fixture();
    try {
      const topology = installManagedCatalogTopology(target, label);
      if (label === "dangling-stable") {
        rmSync(path.join(target.stateRoot, "catalog-generations", "current"), { force: true });
      } else if (label === "redirected-stable") {
        const stable = path.join(target.stateRoot, "merged-models.json");
        rmSync(stable, { force: true });
        symlinkSync("catalog-generations/current/routed-models.json", stable, "file");
      } else {
        const artifact = path.join(topology.generationDir, "merged-models.json");
        const alias = path.join(root, "foreign-alias.json");
        writeFileSync(alias, "foreign\n", { mode: 0o600 });
        rmSync(artifact, { force: true });
        linkSync(alias, artifact);
      }
      assert.throws(
        () => snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots)),
        /catalog|topology|link|generation|private|hard/i,
        label,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("managed catalog topology restore fails closed when a stable link was replaced", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    installManagedCatalogTopology(target, "restore-tamper");
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    const stable = path.join(target.stateRoot, "merged-models.json");
    rmSync(stable, { force: true });
    symlinkSync("catalog-generations/current/routed-models.json", stable, "file");
    assert.throws(() => restoreOwnedRuntime(snapshot), /catalog|topology|link|target/i);
    assert.equal(readlinkSync(stable), "catalog-generations/current/routed-models.json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forged catalog topology snapshot cannot mutate a different state root", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  const externalRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-external-catalog-"));
  try {
    installManagedCatalogTopology(target, "bound");
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    installManagedCatalogTopology({ stateRoot: externalRoot }, "external");
    const externalCurrent = path.join(externalRoot, "catalog-generations", "current");
    const before = readlinkSync(externalCurrent);
    const forged = {
      ...snapshot,
      catalogTopology: {
        ...snapshot.catalogTopology,
        stateRoot: externalRoot,
        generationsDir: path.join(externalRoot, "catalog-generations"),
      },
    };
    assert.throws(() => restoreOwnedRuntime(forged), /snapshot|state root|topology|resolver|bound/i);
    assert.equal(readlinkSync(externalCurrent), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("catalog topology snapshot requires BigInt identities before any restore write", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    const topology = installManagedCatalogTopology(target, "identity-schema");
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    const forged = {
      ...snapshot,
      catalogTopology: {
        ...snapshot.catalogTopology,
        identities: {
          ...snapshot.catalogTopology.identities,
          stateIdentity: { dev: Number(snapshot.catalogTopology.identities.stateIdentity.dev), ino: 1 },
        },
      },
    };
    assert.throws(() => restoreOwnedRuntime(forged), /BigInt|identity|topology/i);
    assert.equal(readlinkSync(path.join(target.stateRoot, "catalog-generations", "current")), topology.generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog snapshot detects post-capture byte mutation before it can switch current", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    const topology = installManagedCatalogTopology(target, "digest");
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    snapshot.catalogTopology.files["merged-models.json"].bytes[0] ^= 1;
    const current = path.join(target.stateRoot, "catalog-generations", "current");
    assert.throws(() => restoreOwnedRuntime(snapshot), /snapshot|artifact|digest|topology/i);
    assert.equal(readlinkSync(current), topology.generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog topology requires exactly six generation files and rejects any topology authority mixed with legacy files", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const cases = ["extra-generation-file", "mixed-legacy-authority"];
  for (const label of cases) {
    const { root, target, runtimeRoots } = fixture();
    try {
      if (label === "extra-generation-file") {
        const topology = installManagedCatalogTopology(target, label);
        writeFileSync(path.join(topology.generationDir, "foreign.json"), "{}\n", { mode: 0o600 });
      } else {
        mkdirSync(path.join(target.stateRoot, "catalog-generations"), { recursive: true });
        writeFileSync(path.join(target.stateRoot, "merged-models.json"), "legacy\n", { mode: 0o600 });
      }
      assert.throws(() => snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots)), /catalog|topology|generation|mixed|exact/i, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an originally missing runtime artifact cannot be replaced by a dangling link during restore", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, paths } = fixture();
  try {
    const snapshot = snapshotOwnedRuntime({ ...paths, ids: ["state-dsh-catalog"] });
    const missing = path.join(target.stateRoot, "dsh-models.json");
    symlinkSync("gone.json", missing, "file");
    assert.throws(() => restoreOwnedRuntime(snapshot), /symlink|junction|link|missing/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog topology applies Windows ACL privacy through an injectable filesystem without requiring mode 0600", {
  skip: process.platform === "win32" && "Windows CI test uses the production ACL seam on the host filesystem",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    const topology = installManagedCatalogTopology(target, "windows-acl");
    for (const name of MANAGED_CATALOG_FILES) chmodSync(path.join(topology.generationDir, name), 0o640);
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots), {
      fs: {
        platform: "win32",
        verifyProtected: () => true,
        readlink(targetPath) {
          if (targetPath === path.join(target.stateRoot, "catalog-generations", "current")) return "generation-windows-acl";
          const name = path.basename(targetPath);
          if (MANAGED_CATALOG_FILES.includes(name)) return `catalog-generations\\current\\${name}`;
          return readlinkSync(targetPath);
        },
      },
    });
    assert.equal(snapshot.catalogTopology.files["merged-models.json"].mode, 0o640);
    assert.throws(() => snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots), {
      fs: { platform: "win32", verifyProtected: () => false },
    }), /ACL|private|catalog/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows adapter restores a missing generation through normalized links, ACL privacy, and privilege failure cleanup", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-win-catalog-"));
  const target = resolveServiceTarget({
    mode: "test",
    platform: "win32",
    isolationRoot: root,
    sourceRoot: path.join(root, "checkout"),
    routerLabel: "com.example.codex-router-win-catalog",
    trayLabel: "com.example.codex-router-win-catalog.tray",
    ports: { oauth: 46601, router: 46602, api: 46603, grokOauth: 46608, devinCli: 46610 },
  });
  const runtimeRoots = { userHome: root, codexHome: root, dshHome: path.join(root, "dsh"), geminiHome: path.join(root, "gemini") };
  let protectedCalls = 0;
  let verifiedCalls = 0;
  const adapter = {
    platform: "win32",
    protect: () => { protectedCalls += 1; },
    verifyProtected: () => { verifiedCalls += 1; return true; },
    readlink(targetPath) {
      if (targetPath === path.join(target.stateRoot, "catalog-generations", "current")) return readlinkSync(targetPath);
      const name = path.basename(targetPath);
      if (MANAGED_CATALOG_FILES.includes(name)) return `catalog-generations\\current\\${name}`;
      return readlinkSync(targetPath);
    },
  };
  try {
    mkdirSync(target.stateRoot, { recursive: true });
    const topology = installManagedCatalogTopology(target, "win");
    for (const name of MANAGED_CATALOG_FILES) chmodSync(path.join(topology.generationDir, name), 0o640);
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots), { fs: adapter });
    rmSync(topology.generationDir, { recursive: true, force: true });
    const generations = path.join(target.stateRoot, "catalog-generations");
    assert.throws(() => restoreOwnedRuntime(snapshot, {
      fs: { ...adapter, symlink: () => { throw new Error("Windows symlink privilege denied"); } },
    }), /privilege|symlink|restore/i);
    assert.equal(readdirSync(generations).some((name) => name.startsWith("restore-")), false);
    let renameAttempts = 0;
    restoreOwnedRuntime(snapshot, { fs: {
      ...adapter,
      rename(source, destination) {
        if (destination === path.join(generations, "current")) renameAttempts += 1;
        if (destination === path.join(generations, "current") && renameAttempts === 1) {
          const error = new Error("transient sharing violation");
          error.code = "EPERM";
          throw error;
        }
        return renameSync(source, destination);
      },
    } });
    assert.match(readlinkSync(path.join(generations, "current")), /^restore-/);
    assert.equal(renameAttempts, 2);
    assert.ok(protectedCalls >= MANAGED_CATALOG_FILES.length);
    assert.ok(verifiedCalls >= MANAGED_CATALOG_FILES.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog pointer restore removes staged generations and rolls back its pointer after every injected commit fault", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  for (const fault of ["symlink", "rename", "fsync", "validate"]) {
    const { root, target, runtimeRoots } = fixture();
    try {
      const topology = installManagedCatalogTopology(target, `atomic-${fault}`);
      const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
      writeFileSync(path.join(topology.generationDir, "merged-models.json"), "mutated\n", { mode: 0o600 });
      chmodSync(path.join(topology.generationDir, "merged-models.json"), 0o600);
      const generations = path.join(target.stateRoot, "catalog-generations");
      let generationFsyncs = 0;
      let readlinks = 0;
      let renameCalls = 0;
      const descriptors = new Map();
      assert.throws(() => restoreOwnedRuntime(snapshot, {
        fs: {
          ...(fault === "rename" ? { platform: "win32" } : {}),
          symlink(source, destination, type) {
            if (fault === "symlink" && path.basename(destination).includes("catalog-current-restore")) throw new Error("injected pointer symlink");
            return symlinkSync(source, destination, type);
          },
          rename(source, destination) {
            if (fault === "rename" && destination === path.join(generations, "current")) {
              renameCalls += 1;
              const error = new Error("injected persistent sharing violation");
              error.code = "EBUSY";
              throw error;
            }
            return renameSync(source, destination);
          },
          open(file, flags, mode) {
            const descriptor = mode === undefined ? openSync(file, flags) : openSync(file, flags, mode);
            descriptors.set(descriptor, file);
            return descriptor;
          },
          fsync(descriptor) {
            if (descriptors.get(descriptor) === generations) {
              generationFsyncs += 1;
              if (fault === "fsync" && generationFsyncs === 2) throw new Error("injected postcommit fsync");
            }
            return fsyncSync(descriptor);
          },
          close(descriptor) {
            descriptors.delete(descriptor);
            return closeSync(descriptor);
          },
          readlink(targetPath) {
            readlinks += 1;
            if (fault === "validate" && readlinks > 7) throw new Error("injected postcommit validation");
            return readlinkSync(targetPath);
          },
        },
      }), /injected|catalog|restore/i, fault);
      assert.equal(readlinkSync(path.join(generations, "current")), topology.generation, fault);
      assert.equal(readdirSync(generations).some((name) => name.startsWith("restore-")), false, fault);
      if (fault === "rename") assert.equal(renameCalls, 2, "Windows retry bound");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("catalog restore aborts before writes when an ancestor identity is swapped to an external directory or link", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  for (const kind of ["directory", "link"]) {
    const { root, target, runtimeRoots } = fixture();
    const external = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-ancestor-external-"));
    try {
    const topology = installManagedCatalogTopology(target, "ancestor-swap");
    const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
    writeFileSync(path.join(topology.generationDir, "merged-models.json"), "mutated\n", { mode: 0o600 });
    const marker = path.join(external, "must-not-change");
    writeFileSync(marker, "external\n", { mode: 0o600 });
    const swap = kind === "link" ? path.join(root, "swapped-state-root") : external;
    if (kind === "link") symlinkSync(external, swap, "dir");
    let stateRootReads = 0;
    assert.throws(() => restoreOwnedRuntime(snapshot, {
      fs: {
        lstat(targetPath, options) {
          if (targetPath === target.stateRoot && ++stateRootReads >= 2) return lstatSync(swap, options);
          return lstatSync(targetPath, options);
        },
      },
    }), /identity|directory|symlink|catalog/i);
    assert.deepEqual(readFileSync(marker), Buffer.from("external\n"));
    assert.equal(readdirSync(path.join(target.stateRoot, "catalog-generations")).some((name) => name.startsWith("restore-")), false, kind);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }
});

test("catalog restore rejects a late replacement of its newly-created generation before any external write", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  for (const kind of ["directory", "link"]) {
    const { root, target, runtimeRoots } = fixture();
    const external = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-new-generation-swap-"));
    try {
      const topology = installManagedCatalogTopology(target, `new-generation-${kind}`);
      const snapshot = snapshotOwnedRuntime(ownedRuntimePaths(target, runtimeRoots));
      writeFileSync(path.join(topology.generationDir, "merged-models.json"), "mutated\n", { mode: 0o600 });
      const marker = path.join(external, "must-not-change");
      writeFileSync(marker, "external\n", { mode: 0o600 });
      let generationStats = 0;
      assert.throws(() => restoreOwnedRuntime(snapshot, {
        fs: {
          lstat(targetPath, options) {
            if (path.basename(targetPath).startsWith("restore-") && ++generationStats === 2) {
              const parked = `${targetPath}.parked`;
              renameSync(targetPath, parked);
              if (kind === "directory") renameSync(external, targetPath);
              else symlinkSync(external, targetPath, "dir");
            }
            return lstatSync(targetPath, options);
          },
        },
      }), /identity|directory|symlink|catalog/i, kind);
      const markerPath = kind === "directory" ? path.join(target.stateRoot, "catalog-generations", "restore-") : marker;
      if (kind === "directory") {
        const generations = path.join(target.stateRoot, "catalog-generations");
        const swapped = readdirSync(generations).find((name) => name.startsWith("restore-") && !name.endsWith(".parked"));
        assert.deepEqual(readFileSync(path.join(generations, swapped, "must-not-change")), Buffer.from("external\n"));
      } else {
        assert.deepEqual(readFileSync(markerPath), Buffer.from("external\n"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }
});

test("a dangling non-catalog owned symlink is rejected during resolver preflight", {
  skip: process.platform === "win32" && "Windows CI must not assume symlink privilege",
}, () => {
  const { root, target, runtimeRoots } = fixture();
  try {
    const secret = path.join(target.stateRoot, "caller-secret");
    rmSync(secret, { force: true });
    symlinkSync("missing-secret", secret, "file");
    assert.throws(() => ownedRuntimePaths(target, runtimeRoots), /symlink|junction|link/i);
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
    const snapshot = snapshotOwnedRuntime({ ...paths, ids: ["caller-secret"] });
    let renames = 0;
    let flushFailed = false;
    const primaryRestoreFs = {
      rename(from, to) {
        renames += 1;
        // 1: target -> backup, 2: staging -> target, 3: backup -> target.
        if (renames === 3) throw new Error("rollback rename failed");
        renameSync(from, to);
      },
      ...(process.platform === "win32"
        ? {
            verifyProtected() {
              if (renames === 2) throw new Error("post-install verification failure");
              return true;
            },
          }
        : {
            fsync(fd) {
              if (!flushFailed && renames === 2) {
                flushFailed = true;
                throw new Error("post-install flush failure");
              }
              return fsyncSync(fd);
            },
          }),
    };
    assert.throws(
      () => restoreOwnedRuntime(snapshot, { fs: primaryRestoreFs }),
      (error) => error instanceof AggregateError && /rollback rename failed/.test(String(error.errors?.[1]?.message || error.message)),
    );
    const leftovers = readdirSync(path.dirname(paths.protected["caller-secret"]));
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

test("staged file writes retry short writes until every byte is durable", () => {
  const { root, target, paths } = fixture();
  try {
    const snapshot = snapshotOwnedRuntime({ ...paths, ids: ["router-plist"] });
    const positions = [];
    let calls = 0;
    restoreOwnedRuntime(snapshot, {
      fs: {
        writeFd(fd, bytes, offset, length, position) {
          positions.push({ offset, length, position });
          calls += 1;
          const partial = calls === 1 ? Math.min(3, length) : length;
          return writeSync(fd, bytes, offset, partial, position);
        },
      },
    });
    assert.ok(calls > 1);
    assert.deepEqual(positions.map(({ offset, position }) => [offset, position]), [[0, 0], [3, 3]]);
    assert.deepEqual(readFileSync(target.routerPlistPath), Buffer.from("old-router-plist\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zero or negative staged writes fail before commit and preserve the original", () => {
  for (const reported of [0, -1]) {
    const { root, target, paths } = fixture();
    try {
      const snapshot = snapshotOwnedRuntime({ ...paths, ids: ["router-plist"] });
      assert.throws(
        () => restoreOwnedRuntime(snapshot, {
          fs: {
            writeFd() {
              return reported;
            },
          },
        }),
        /write|byte/i,
      );
      assert.deepEqual(readFileSync(target.routerPlistPath), Buffer.from("old-router-plist\n"));
      assert.deepEqual(
        readdirSync(path.dirname(target.routerPlistPath)).filter((name) => name.includes("runtime-")),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("atomic file and tree replacement never mutate target metadata after rename", () => {
  const { root, target, paths } = fixture();
  const nested = path.join(target.appPath, "Contents", "Resources", "old.txt");
  try {
    mkdirSync(path.dirname(nested), { recursive: true });
    writeFileSync(nested, "old nested bytes\n", { mode: 0o640 });
    const snapshot = snapshotOwnedRuntime({ ...paths, ids: ["router-plist", "tray-app"] });
    const renamedTargets = new Set();
    const metadataAfterRename = [];
    restoreOwnedRuntime(snapshot, {
      fs: {
        rename(from, to) {
          const result = renameSync(from, to);
          if (to === target.routerPlistPath || to === target.appPath) renamedTargets.add(to);
          return result;
        },
        chmod(file, mode) {
          if (renamedTargets.has(file)) metadataAfterRename.push(file);
          return chmodSync(file, mode);
        },
        protect(file, ...args) {
          if (renamedTargets.has(file)) metadataAfterRename.push(file);
          return undefined;
        },
      },
    });
    assert.deepEqual(metadataAfterRename, []);
    assert.deepEqual(readFileSync(target.routerPlistPath), Buffer.from("old-router-plist\n"));
    assert.deepEqual(readFileSync(nested), Buffer.from("old nested bytes\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
