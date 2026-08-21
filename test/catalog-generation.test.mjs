import assert from "node:assert/strict";
import {
  lstatSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCatalogGenerationFileSystem,
  publishCatalogGeneration,
  validateCatalogSchema,
} from "../src/catalog-generation.mjs";

const artifactNames = [
  "merged-models.json",
  "routed-models.json",
  "node-routes.json",
  "control-models.json",
  "swift-models.json",
  "browser-models.json",
];

function artifacts(label) {
  const catalog = {
    models: [{
      slug: `router/${label}`,
      base_instructions: `instructions ${label}`,
      model_messages: { instructions_template: `template ${label}` },
      supports_parallel_tool_calls: false,
    }],
  };
  const models = { version: 1, models: [{ slug: `router/${label}`, provider: "router" }] };
  return {
    "merged-models.json": catalog,
    "routed-models.json": catalog,
    "node-routes.json": { version: 1, routes: [{ slug: `router/${label}`, provider: "router" }] },
    "control-models.json": models,
    "swift-models.json": models,
    "browser-models.json": models,
  };
}

function readCurrent(generationsDir) {
  return Object.fromEntries(artifactNames.map((name) => [
    name,
    readFileSync(path.join(generationsDir, "current", name)),
  ]));
}

function testOperations() {
  const base = createCatalogGenerationFileSystem();
  if (process.platform !== "win32") return { ...base, protect: () => {} };
  // CI need not have SeCreateSymbolicLinkPrivilege. Keep the production seam
  // unchanged, but exercise the same switch ordering through junctions/hard
  // links so failure assertions do not become Windows-only skips.
  return {
    ...base,
    protect: () => {},
    symlink(source, target, type) {
      if (type === "dir") return base.symlink(path.resolve(path.dirname(target), source), target, "junction");
      return linkSync(path.resolve(path.dirname(target), source), target);
    },
    rename(source, target) {
      if (path.basename(target) === "current" && base.exists(target)) base.remove(target, { recursive: true, force: true });
      return base.rename(source, target);
    },
  };
}

function failingOperations(boundary, base = testOperations()) {
  return {
    ...base,
    writeFile(...args) {
      if (boundary === "write") throw new Error("injected write failure");
      return base.writeFile(...args);
    },
    fsyncFile(...args) {
      if (boundary === "file-fsync") throw new Error("injected file fsync failure");
      return base.fsyncFile(...args);
    },
    fsyncDirectory(...args) {
      if (boundary === "directory-fsync") throw new Error("injected directory fsync failure");
      return base.fsyncDirectory(...args);
    },
    symlink(...args) {
      if (boundary === "symlink") throw new Error("injected symlink failure");
      return base.symlink(...args);
    },
    rename(source, target) {
      if (boundary === "pointer-rename" && path.basename(target) === "current") {
        throw new Error("injected pointer rename failure");
      }
      return base.rename(source, target);
    },
  };
}

test("both versioned Codex schemas reject incomplete routed entries", () => {
  for (const version of ["0.147", "0.149"]) {
    const schema = JSON.parse(readFileSync(
      new URL(`./fixtures/codex-model-catalog-${version}.schema.json`, import.meta.url),
      "utf8",
    ));
    assert.doesNotThrow(() => validateCatalogSchema(artifacts("schema")["routed-models.json"], schema));
    assert.throws(
      () => validateCatalogSchema({ models: [{ slug: "missing-contract" }] }, schema),
      version === "0.147" ? /model_messages/ : /base_instructions/,
    );
  }
});

test("merged entries require an explicit parallel-tool boolean", () => {
  const incomplete = artifacts("merged-contract");
  // Keep the routed artifact valid so this exercises the merged contract,
  // rather than the stricter 0.149 routed validator.
  incomplete["routed-models.json"] = artifacts("routed-contract")["routed-models.json"];
  delete incomplete["merged-models.json"].models[0].supports_parallel_tool_calls;
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-merged-schema-"));
  try {
    assert.throws(
      () => publishCatalogGeneration({
        files: incomplete,
        generationsDir: path.join(stateDir, "catalog-generations"),
        legacyPaths: {},
        operations: testOperations(),
      }),
      /supports_parallel_tool_calls/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

for (const boundary of ["write", "file-fsync", "directory-fsync", "symlink", "pointer-rename"]) {
  test(`a ${boundary} failure preserves the complete previous generation`, () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-failure-"));
    const generationsDir = path.join(stateDir, "catalog-generations");
    try {
      publishCatalogGeneration({
        files: artifacts("old"), generationsDir, operations: testOperations(), legacyPaths: {},
      });
      const oldBytes = readCurrent(generationsDir);
      assert.throws(
        () => publishCatalogGeneration({
          files: artifacts("new"),
          generationsDir,
          operations: failingOperations(boundary, testOperations()),
          legacyPaths: {},
        }),
        /injected/,
      );
      assert.deepEqual(readCurrent(generationsDir), oldBytes);
      // On Windows the injected seam uses a privilege-free junction. The
      // important assertion is that every reader still resolves one old set.
      assert.ok(lstatSync(path.join(generationsDir, "current")));
      if (process.platform !== "win32") {
        for (const name of artifactNames) {
          assert.equal(statSync(path.join(generationsDir, "current", name)).mode & 0o777, 0o600);
        }
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test("regular legacy catalog paths migrate to generation links and restore byte and mode snapshots on failure", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-migration-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPath = path.join(stateDir, "merged-models.json");
  const original = Buffer.from("{\"legacy\":true}\n");
  try {
    writeFileSync(legacyPath, original, { mode: 0o640 });
    const originalMode = statSync(legacyPath).mode & 0o777;
    assert.throws(
      () => publishCatalogGeneration({
        files: artifacts("new"),
        generationsDir,
        legacyPaths: { "merged-models.json": legacyPath },
        operations: failingOperations("pointer-rename", testOperations()),
      }),
      /injected pointer rename failure/,
    );
    assert.equal(lstatSync(legacyPath).isFile(), true);
    assert.deepEqual(readFileSync(legacyPath), original);
    assert.equal(statSync(legacyPath).mode & 0o777, originalMode);

    publishCatalogGeneration({
      files: artifacts("new"),
      generationsDir,
      legacyPaths: { "merged-models.json": legacyPath },
      operations: testOperations(),
    });
    assert.equal(process.platform === "win32" ? lstatSync(legacyPath).isFile() : lstatSync(legacyPath).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(legacyPath), readCurrent(generationsDir)["merged-models.json"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("first publication bootstraps a complete old generation before switching current to new", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-bootstrap-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const old = artifacts("old-bootstrap");
  const oldBytes = Object.fromEntries(artifactNames.map((name) => [
    name,
    Buffer.from(`${JSON.stringify(old[name], null, 2)}\n`),
  ]));
  for (const name of artifactNames) writeFileSync(legacyPaths[name], oldBytes[name], { mode: 0o600 });
  const base = testOperations();
  let currentRenames = 0;
  const operations = {
    ...base,
    rename(source, target) {
      if (path.basename(target) === "current") {
        currentRenames += 1;
        if (currentRenames === 2) {
          for (const name of artifactNames) assert.deepEqual(readFileSync(legacyPaths[name]), oldBytes[name]);
        }
      }
      return base.rename(source, target);
    },
  };
  try {
    publishCatalogGeneration({
      files: artifacts("new-bootstrap"), generationsDir, legacyPaths, operations,
    });
    assert.equal(currentRenames, 2, "bootstrap old pointer then one new pointer switch");
    for (const name of artifactNames) {
      assert.deepEqual(readFileSync(legacyPaths[name]), readCurrent(generationsDir)[name]);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a first-generation bootstrap-pointer failure restores the regular file", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-first-migration-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPath = path.join(stateDir, "merged-models.json");
  const original = Buffer.from("{\"legacy\":true}\n");
  try {
    writeFileSync(legacyPath, original, { mode: 0o640 });
    const base = testOperations();
    let symlinkCalls = 0;
    const operations = {
      ...base,
      symlink(...args) {
        symlinkCalls += 1;
        if (symlinkCalls === 1) throw new Error("injected bootstrap pointer failure");
        return base.symlink(...args);
      },
    };
    assert.throws(
      () => publishCatalogGeneration({
        files: artifacts("new"),
        generationsDir,
        legacyPaths: { "merged-models.json": legacyPath },
        operations,
      }),
      /injected bootstrap pointer failure/,
    );
    assert.throws(() => lstatSync(path.join(generationsDir, "current")), /ENOENT/);
    assert.deepEqual(readFileSync(legacyPath), original);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function legacyFixture(stateDir) {
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  publishCatalogGeneration({
    files: artifacts("matrix-old"), generationsDir, legacyPaths, operations: testOperations(),
  });
  return {
    generationsDir,
    legacyPaths,
    current: readCurrent(generationsDir),
    stable: Object.fromEntries(artifactNames.map((name) => [name, readFileSync(legacyPaths[name])])),
  };
}

function countedOperations(base, counts, fail = undefined) {
  const wrap = (operation) => (...args) => {
    counts[operation] = (counts[operation] || 0) + 1;
    if (fail?.operation === operation && fail.ordinal === counts[operation]) {
      throw new Error(`injected ${operation} #${fail.ordinal}`);
    }
    return base[operation](...args);
  };
  return {
    ...base,
    writeFile: wrap("writeFile"),
    fsyncFile: wrap("fsyncFile"),
    fsyncDirectory: wrap("fsyncDirectory"),
    symlink: wrap("symlink"),
    rename: wrap("rename"),
  };
}

test("every publication operation ordinal preserves one complete old reader view", () => {
  const probeDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-matrix-probe-"));
  let counts;
  try {
    const fixture = legacyFixture(probeDir);
    counts = {};
    publishCatalogGeneration({
      files: artifacts("matrix-probe"),
      generationsDir: fixture.generationsDir,
      legacyPaths: fixture.legacyPaths,
      operations: countedOperations(testOperations(), counts),
    });
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  assert.equal(counts.writeFile, 6);
  assert.equal(counts.fsyncFile, 6);
  assert.ok(counts.fsyncDirectory >= 4, "syncs staging, generation root, stable parents, and pointer parent");
  assert.ok(counts.symlink >= 7, "covers six stable links plus the current pointer");
  assert.ok(counts.rename >= 8, "covers staging, six stable migrations, and the current pointer");

  for (const [operation, total] of Object.entries(counts)) {
    for (let ordinal = 1; ordinal <= total; ordinal += 1) {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-matrix-"));
      try {
        const fixture = legacyFixture(stateDir);
        const oldModes = Object.fromEntries(artifactNames.map((name) => [
          name,
          statSync(path.join(fixture.generationsDir, "current", name)).mode & 0o777,
        ]));
        assert.throws(
          () => publishCatalogGeneration({
            files: artifacts(`matrix-${operation}-${ordinal}`),
            generationsDir: fixture.generationsDir,
            legacyPaths: fixture.legacyPaths,
            operations: countedOperations(testOperations(), {}, { operation, ordinal }),
          }),
          new RegExp(`injected ${operation} #${ordinal}`),
        );
        assert.deepEqual(readCurrent(fixture.generationsDir), fixture.current);
        assert.deepEqual(
          Object.fromEntries(artifactNames.map((name) => [name, readFileSync(fixture.legacyPaths[name])])),
          fixture.stable,
        );
        for (const name of artifactNames) {
          assert.equal(statSync(path.join(fixture.generationsDir, "current", name)).mode & 0o777, oldModes[name]);
        }
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }
});
