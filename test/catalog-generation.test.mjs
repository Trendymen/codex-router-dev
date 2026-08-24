import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
import ownershipCatalogOracle from "./acceptance/oracles/ownership-catalog.json" with { type: "json" };

const artifactNames = [
  "merged-models.json",
  "routed-models.json",
  "node-routes.json",
  "control-models.json",
  "swift-models.json",
  "browser-models.json",
];

function dispatchCatalogOracleRows(rows) {
  const dispatch = {
    "catalog-lifecycle-atomicity": ({ contract }) => {
      const actual = validateCatalogSchema(contract.input.catalog, { type: "object", required: ["models"], properties: { models: { type: "array" } }, additionalProperties: false });
      assert.equal(actual.models.length, contract.expected.modelCount);
    },
  };
  assert.deepEqual(Object.keys(dispatch).sort(), rows.map(({ id }) => id).sort());
  for (const row of rows) dispatch[row.id](row);
}

test("Appendix E catalog consumer dispatches its checked-in catalog oracle row", () => {
  dispatchCatalogOracleRows(ownershipCatalogOracle.rows.filter(({ id }) => id === "catalog-lifecycle-atomicity"));
});

test("变异 Appendix E catalog oracle 后，同一 catalog consumer 必须失败", () => {
  const tampered = structuredClone(ownershipCatalogOracle.rows.filter(({ id }) => id === "catalog-lifecycle-atomicity"));
  tampered[0].contract.expected.modelCount = 1;
  assert.throws(() => dispatchCatalogOracleRows(tampered));
});

function artifacts(label) {
  const catalog = {
    models: [{
      slug: `router/${label}`,
      base_instructions: `instructions ${label}`,
      model_messages: { instructions_template: `template ${label}` },
      supports_parallel_tool_calls: false,
    }],
  };
  const route = {
    slug: `router/${label}`, provider: "router", upstreamModel: "router-model",
    effectiveTransport: "openai-responses", toolDialect: "responses-functions", requestProfile: "router",
    reasoningDisplayMode: "raw-preserve", effectiveFinalReasoningShape: "raw-content", purpose: "primary",
  };
  const models = { version: 1, models: [{
    slug: route.slug, provider: route.provider, upstreamModel: route.upstreamModel,
    effectiveTransport: route.effectiveTransport, toolDialect: route.toolDialect,
    reasoningDisplayMode: route.reasoningDisplayMode, effectiveFinalReasoningShape: route.effectiveFinalReasoningShape,
    declaredFinalReasoningShape: "raw-content", rolloutState: "stable", purpose: route.purpose,
    routable: true, listed: true, visible: true,
  }] };
  return {
    "merged-models.json": catalog,
    "routed-models.json": catalog,
    "node-routes.json": { version: 1, routes: [route] },
    "control-models.json": models,
    "swift-models.json": models,
    "browser-models.json": models,
  };
}

function legacy0147MergedOnlyFixture(label) {
  const legacy = artifacts(label)["merged-models.json"];
  delete legacy.models[0].base_instructions;
  delete legacy.models[0].supports_parallel_tool_calls;
  return legacy;
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

test("Windows catalog filesystem retries one transient staging rename", () => {
  let attempts = 0;
  const waits = [];
  const operations = createCatalogGenerationFileSystem({
    platform: "win32",
    renameSystemCall() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("transient sharing violation");
        error.code = "EPERM";
        throw error;
      }
      return "renamed";
    },
    wait(milliseconds) { waits.push(milliseconds); },
  });

  assert.equal(operations.rename("staging", "generation"), "renamed");
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [10]);
});

test("Windows catalog filesystem preserves the original transient rename error after its retry bound", () => {
  const first = new Error("first transient sharing violation");
  first.code = "EPERM";
  const second = new Error("second transient sharing violation");
  second.code = "EBUSY";
  let attempts = 0;
  const waits = [];
  const operations = createCatalogGenerationFileSystem({
    platform: "win32",
    renameSystemCall() {
      attempts += 1;
      throw attempts === 1 ? first : second;
    },
    wait(milliseconds) { waits.push(milliseconds); },
  });

  assert.throws(() => operations.rename("staging", "generation"), (error) => error === first);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [10]);
});

test("catalog filesystem does not retry non-transient rename errors", () => {
  const original = new Error("cross-device rename");
  original.code = "EXDEV";
  let attempts = 0;
  const waits = [];
  const operations = createCatalogGenerationFileSystem({
    platform: "win32",
    renameSystemCall() {
      attempts += 1;
      throw original;
    },
    wait(milliseconds) { waits.push(milliseconds); },
  });

  assert.throws(() => operations.rename("staging", "generation"), (error) => error === original);
  assert.equal(attempts, 1);
  assert.deepEqual(waits, []);
});

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

test("generation rejects malformed routes and UI snapshots before staging any generation", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-safe-schema-"));
  try {
    for (const [name, value] of [
      ["node-routes.json", { version: 1, routes: [{ slug: "x", provider: "p", unexpected: true }] }],
      ["control-models.json", { version: 1, models: [{ slug: "x", provider: "p", unexpected: true }] }],
      ["swift-models.json", { version: 2, models: [] }],
      ["browser-models.json", { version: 1, models: "bad" }],
    ]) {
      const generationsDir = path.join(stateDir, `catalog-${name}`);
      publishCatalogGeneration({ files: artifacts(`old-${name}`), generationsDir, legacyPaths: {}, operations: testOperations() });
      const oldBytes = readCurrent(generationsDir);
      const files = artifacts(`invalid-${name}`);
      files[name] = value;
      assert.throws(() => publishCatalogGeneration({
        files, generationsDir, legacyPaths: {}, operations: testOperations(),
      }), /safe snapshot|unexpected|version|models|routes/);
      assert.deepEqual(readCurrent(generationsDir), oldBytes, `${name} malformed bytes must leave the old generation visible`);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("current authority rejects regular files, directories, outside links and incomplete generations without mutation", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-current-authority-"));
  try {
    const generationsDir = path.join(stateDir, "catalog-generations");
    for (const kind of ["file", "directory", "outside", "incomplete"]) {
      rmSync(generationsDir, { recursive: true, force: true });
      mkdirSync(generationsDir, { recursive: true });
      const current = path.join(generationsDir, "current");
      if (kind === "file") writeFileSync(current, "not a pointer");
      if (kind === "directory") mkdirSync(current);
      if (kind === "outside") {
        const outside = path.join(stateDir, "outside"); mkdirSync(outside); testOperations().symlink(outside, current, "dir");
      }
      if (kind === "incomplete") {
        const incomplete = path.join(generationsDir, "incomplete"); mkdirSync(incomplete); writeFileSync(path.join(incomplete, "merged-models.json"), "{}"); testOperations().symlink("incomplete", current, "dir");
      }
      const before = lstatSync(current);
      assert.throws(() => publishCatalogGeneration({ files: artifacts(kind), generationsDir, legacyPaths: {}, operations: testOperations() }), /current|generation/i, kind);
      assert.equal(lstatSync(current).ino, before.ino, `${kind} current object changed`);
    }
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
        /injected|rollback was incomplete/,
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

test("an incomplete legacy artifact set fails closed before any bootstrap pointer", () => {
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
        operations: testOperations(),
      }),
      /incomplete legacy artifact set/,
    );
    assert.equal(lstatSync(legacyPath).isFile(), true);
    assert.deepEqual(readFileSync(legacyPath), original);
    assert.equal(statSync(legacyPath).mode & 0o777, originalMode);
    assert.throws(() => lstatSync(path.join(generationsDir, "current")), /ENOENT/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a legacy merged-only installation bootstraps deterministic empty companion snapshots", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-merged-only-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const oldMergedBytes = Buffer.from(`${JSON.stringify(legacy0147MergedOnlyFixture("legacy-merged-only"), null, 2)}\n`);
  const expectedBootstrap = {
    "merged-models.json": oldMergedBytes,
    "routed-models.json": Buffer.from('{\n  "models": []\n}\n'),
    "node-routes.json": Buffer.from('{\n  "version": 1,\n  "routes": []\n}\n'),
    "control-models.json": Buffer.from('{\n  "version": 1,\n  "models": []\n}\n'),
    "swift-models.json": Buffer.from('{\n  "version": 1,\n  "models": []\n}\n'),
    "browser-models.json": Buffer.from('{\n  "version": 1,\n  "models": []\n}\n'),
  };
  const base = testOperations();
  let oldView;
  let currentRenames = 0;
  try {
    writeFileSync(legacyPaths["merged-models.json"], oldMergedBytes, { mode: 0o640 });
    const operations = {
      ...base,
      rename(source, target) {
        if (path.basename(target) === "current" && ++currentRenames === 2) {
          oldView = readCurrent(generationsDir);
          for (const name of artifactNames) assert.deepEqual(readFileSync(legacyPaths[name]), expectedBootstrap[name]);
        }
        return base.rename(source, target);
      },
    };
    publishCatalogGeneration({
      files: artifacts("merged-only-new"), generationsDir, legacyPaths, operations,
    });
    assert.equal(currentRenames, 2);
    assert.deepEqual(oldView, expectedBootstrap);
    const bootstrap = readdirSync(generationsDir).find((name) => name.startsWith("bootstrap-"));
    assert.ok(bootstrap);
    if (process.platform !== "win32") {
      for (const name of artifactNames) {
        assert.equal(statSync(path.join(generationsDir, bootstrap, name)).mode & 0o777, 0o600);
      }
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bootstrap pointer rename failure removes its temporary pointer", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-bootstrap-pointer-residue-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const oldMergedBytes = Buffer.from(`${JSON.stringify(artifacts("bootstrap-pointer-old")["merged-models.json"], null, 2)}\n`);
  const base = testOperations();
  try {
    writeFileSync(legacyPaths["merged-models.json"], oldMergedBytes, { mode: 0o640 });
    assert.throws(() => publishCatalogGeneration({
      files: artifacts("bootstrap-pointer-new"),
      generationsDir,
      legacyPaths,
      operations: {
        ...base,
        rename(source, target) {
          if (path.basename(target) === "current") throw new Error("injected bootstrap pointer rename failure");
          return base.rename(source, target);
        },
      },
    }), /injected bootstrap pointer rename failure/);
    assert.deepEqual(readFileSync(legacyPaths["merged-models.json"]), oldMergedBytes);
    assert.throws(() => lstatSync(path.join(generationsDir, "current")), /ENOENT/);
    assert.equal(readdirSync(generationsDir).some((name) => name.startsWith(".bootstrap-current-")), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("stable topology rename failure removes its catalog-next temporary link", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-stable-residue-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const base = testOperations();
  try {
    publishCatalogGeneration({ files: artifacts("stable-old"), generationsDir, legacyPaths: {}, operations: base });
    for (const name of artifactNames) {
      writeFileSync(legacyPaths[name], Buffer.from(`${JSON.stringify(artifacts("stable-regular")[name], null, 2)}\n`));
    }
    assert.throws(() => publishCatalogGeneration({
      files: artifacts("stable-new"),
      generationsDir,
      legacyPaths,
      operations: {
        ...base,
        rename(source, target) {
          if (target.includes(".json") && source.includes(".catalog-next-")) {
            throw new Error("injected stable topology rename failure");
          }
          return base.rename(source, target);
        },
      },
    }), /injected stable topology rename failure/);
    assert.equal(readdirSync(stateDir).some((name) => name.includes(".catalog-next-")), false);
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
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const old = artifacts("bootstrap-failure-old");
  const oldBytes = Object.fromEntries(artifactNames.map((name) => [
    name,
    Buffer.from(`${JSON.stringify(old[name], null, 2)}\n`),
  ]));
  try {
    for (const name of artifactNames) writeFileSync(legacyPaths[name], oldBytes[name], { mode: 0o640 });
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
        legacyPaths,
        operations,
      }),
      /injected bootstrap pointer failure/,
    );
    assert.throws(() => lstatSync(path.join(generationsDir, "current")), /ENOENT/);
    for (const name of artifactNames) {
      assert.deepEqual(readFileSync(legacyPaths[name]), oldBytes[name]);
      if (process.platform !== "win32") assert.equal(statSync(legacyPaths[name]).mode & 0o777, 0o640);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bootstrap rollback never leaves a stable legacy path missing while restoring regular files", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-restore-visible-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const old = artifacts("restore-visible-old");
  const oldBytes = Object.fromEntries(artifactNames.map((name) => [
    name,
    Buffer.from(`${JSON.stringify(old[name], null, 2)}\n`),
  ]));
  try {
    for (const name of artifactNames) writeFileSync(legacyPaths[name], oldBytes[name], { mode: 0o640 });
    const base = testOperations();
    let failedNewPointer = false;
    let restoreObservations = 0;
    const operations = {
      ...base,
      symlink(source, target, type) {
        if (!failedNewPointer && path.basename(target).startsWith(".current-next-")) {
          failedNewPointer = true;
          throw new Error("injected new-pointer failure after stable topology");
        }
        return base.symlink(source, target, type);
      },
      rename(source, target) {
        const result = base.rename(source, target);
        if (source.includes(".catalog-rollback-") && Object.values(legacyPaths).includes(target)) {
          restoreObservations += 1;
          for (const name of artifactNames) {
            assert.equal(existsSync(legacyPaths[name]), true, `${name} disappeared after restore ${restoreObservations}`);
            assert.deepEqual(readFileSync(legacyPaths[name]), oldBytes[name], `${name} changed after restore ${restoreObservations}`);
          }
        }
        return result;
      },
    };
    let failure;
    try {
      publishCatalogGeneration({ files: artifacts("restore-visible-new"), generationsDir, legacyPaths, operations });
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message || "", /injected new-pointer failure after stable topology/);
    assert.equal(failure instanceof AggregateError, false, "rollback must not add a restoration failure");
    assert.equal(restoreObservations, artifactNames.length);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("bootstrap rollback restores each regular legacy file to its captured mode after protection", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-restore-mode-"));
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const old = artifacts("restore-mode-old");
  try {
    for (const name of artifactNames) {
      writeFileSync(legacyPaths[name], `${JSON.stringify(old[name], null, 2)}\n`, { mode: 0o640 });
    }
    const base = testOperations();
    let failedNewPointer = false;
    const restoredModes = new Map();
    const operations = {
      ...base,
      lstat(target) {
        const stat = base.lstat(target);
        if (Object.values(legacyPaths).includes(target)) {
          const captured = Object.create(stat);
          captured.mode = (stat.mode & ~0o777) | 0o640;
          return captured;
        }
        return stat;
      },
      chmod(target, mode) {
        if (target.includes(".catalog-rollback-")) restoredModes.set(target, mode);
        return base.chmod(target, mode);
      },
      protect(target) {
        // Production protection can tighten a recreated file. The restore
        // contract must still put the captured mode back afterwards.
        chmodSync(target, 0o600);
      },
      symlink(source, target, type) {
        if (!failedNewPointer && path.basename(target).startsWith(".current-next-")) {
          failedNewPointer = true;
          throw new Error("injected mode-restore pointer failure");
        }
        return base.symlink(source, target, type);
      },
    };
    let failure;
    try {
      publishCatalogGeneration({ files: artifacts("restore-mode-new"), generationsDir, legacyPaths, operations });
    } catch (error) {
      failure = error;
    }
    assert.match(failure?.message || "", /injected mode-restore pointer failure/);
    assert.equal(failure instanceof AggregateError, false, "rollback must not add a restoration failure");
    assert.equal(restoredModes.size, artifactNames.length);
    for (const [target, mode] of restoredModes) assert.equal(mode, 0o640, target);
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

test("ordinary symlink-topology update fault matrix preserves one complete old reader view", () => {
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
  // The injected authority seam records the actual platform operation graph;
  // only file writes and file fsyncs have an invariant cardinality here.
  assert.ok(counts.fsyncDirectory > 0);
  assert.ok(counts.symlink > 0);
  assert.ok(counts.rename > 0);

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

function bootstrapLegacyFixture(stateDir) {
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const old = artifacts("bootstrap-matrix-old");
  const stable = Object.fromEntries(artifactNames.map((name) => [
    name,
    Buffer.from(`${JSON.stringify(old[name], null, 2)}\n`),
  ]));
  for (const name of artifactNames) writeFileSync(legacyPaths[name], stable[name], { mode: 0o600 });
  return { generationsDir, legacyPaths, stable };
}

test("bootstrap migration fault matrix restores legacy topology after every observed ordinal", () => {
  const probeDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-bootstrap-probe-"));
  let counts;
  try {
    const fixture = bootstrapLegacyFixture(probeDir);
    counts = {};
    publishCatalogGeneration({
      files: artifacts("bootstrap-matrix-probe"),
      generationsDir: fixture.generationsDir,
      legacyPaths: fixture.legacyPaths,
      operations: countedOperations(testOperations(), counts),
    });
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  assert.ok(counts.writeFile >= 12, "new and bootstrap generations each write six artifacts");
  assert.ok(counts.fsyncFile >= 12);

  for (const [operation, total] of Object.entries(counts)) {
    for (let ordinal = 1; ordinal <= total; ordinal += 1) {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-bootstrap-matrix-"));
      try {
        const fixture = bootstrapLegacyFixture(stateDir);
        assert.throws(
          () => publishCatalogGeneration({
            files: artifacts(`bootstrap-${operation}-${ordinal}`),
            generationsDir: fixture.generationsDir,
            legacyPaths: fixture.legacyPaths,
            operations: countedOperations(testOperations(), {}, { operation, ordinal }),
          }),
          new RegExp(`injected ${operation} #${ordinal}`),
        );
        assert.throws(() => lstatSync(path.join(fixture.generationsDir, "current")), /ENOENT/);
        assert.deepEqual(
          Object.fromEntries(artifactNames.map((name) => [name, readFileSync(fixture.legacyPaths[name])])),
          fixture.stable,
        );
        if (existsSync(fixture.generationsDir)) {
          const leftovers = readdirSync(fixture.generationsDir);
          assert.equal(
            leftovers.some((name) => name.startsWith("bootstrap-") || name.startsWith(".staging-")),
            false,
            `${operation} #${ordinal} left bootstrap staging behind`,
          );
        }
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }
});

function mergedOnlyLegacyFixture(stateDir) {
  const generationsDir = path.join(stateDir, "catalog-generations");
  const legacyPaths = Object.fromEntries(artifactNames.map((name) => [name, path.join(stateDir, name)]));
  const merged = Buffer.from(`${JSON.stringify(legacy0147MergedOnlyFixture("merged-only-matrix-old"), null, 2)}\n`);
  writeFileSync(legacyPaths["merged-models.json"], merged, { mode: 0o640 });
  return { generationsDir, legacyPaths, merged, mode: statSync(legacyPaths["merged-models.json"]).mode & 0o777 };
}

test("merged-only bootstrap fault matrix preserves its legacy view at every authority ordinal", () => {
  const probeDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-merged-only-probe-"));
  let counts;
  try {
    const fixture = mergedOnlyLegacyFixture(probeDir);
    counts = {};
    publishCatalogGeneration({
      files: artifacts("merged-only-matrix-probe"),
      generationsDir: fixture.generationsDir,
      legacyPaths: fixture.legacyPaths,
      operations: countedOperations(testOperations(), counts),
    });
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }

  for (const [operation, total] of Object.entries(counts)) {
    for (let ordinal = 1; ordinal <= total; ordinal += 1) {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "catalog-generation-merged-only-matrix-"));
      try {
        const fixture = mergedOnlyLegacyFixture(stateDir);
        assert.throws(() => publishCatalogGeneration({
          files: artifacts(`merged-only-${operation}-${ordinal}`),
          generationsDir: fixture.generationsDir,
          legacyPaths: fixture.legacyPaths,
          operations: countedOperations(testOperations(), {}, { operation, ordinal }),
        }), new RegExp(`injected ${operation} #${ordinal}`));
        assert.throws(() => lstatSync(path.join(fixture.generationsDir, "current")), /ENOENT/);
        assert.deepEqual(readFileSync(fixture.legacyPaths["merged-models.json"]), fixture.merged);
        if (process.platform !== "win32") {
          assert.equal(statSync(fixture.legacyPaths["merged-models.json"]).mode & 0o777, fixture.mode);
        }
        for (const name of artifactNames.slice(1)) assert.equal(existsSync(fixture.legacyPaths[name]), false);
        if (existsSync(fixture.generationsDir)) {
          assert.equal(readdirSync(fixture.generationsDir).some((name) => (
            name.startsWith("bootstrap-") || name.startsWith(".staging-") || name.startsWith(".bootstrap-current-")
          )), false, `${operation} #${ordinal} left bootstrap residue behind`);
        }
        assert.equal(readdirSync(stateDir).some((name) => name.includes(".catalog-next-")), false);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }
});
