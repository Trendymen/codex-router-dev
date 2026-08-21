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

test("a first-generation migration failure removes its new pointer and restores the regular file", () => {
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
        if (symlinkCalls === 2) throw new Error("injected legacy migration failure");
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
      /injected legacy migration failure/,
    );
    assert.throws(() => lstatSync(path.join(generationsDir, "current")), /ENOENT/);
    assert.deepEqual(readFileSync(legacyPath), original);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
