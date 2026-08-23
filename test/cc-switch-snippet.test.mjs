import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregateSnippetStatus,
  renderAggregateSnippet,
} from "../src/cc-switch-snippet.mjs";

const capability =
  "http://127.0.0.1:46192/_codex-router/caller-capability-decoy-with-sufficient-length/v1";
const redactedCapability =
  "http://127.0.0.1:46192/_codex-router/[REDACTED]/v1";
const routedCatalogPath = "/private/router-state/routed-models.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeGuard = path.join(root, "test", "fixtures", "task5-runtime-guards.cjs");
const guardMarker = "__TASK5_RUNTIME_GUARDS__";

function snapshotTree(directory, relative = "") {
  const target = path.join(directory, relative);
  return readdirSync(target, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const next = path.join(relative, entry.name);
      const full = path.join(directory, next);
      const mode = statSync(full).mode & 0o777;
      if (entry.isDirectory()) return [{ type: "directory", path: next, mode }, ...snapshotTree(directory, next)];
      if (entry.isSymbolicLink()) return [{ type: "symlink", path: next, mode, target: readlinkSync(full) }];
      return [{ type: "file", path: next, mode, bytes: readFileSync(full).toString("base64") }];
    });
}

function guardEvents(stderr) {
  return stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith(guardMarker))
    .flatMap((line) => JSON.parse(line.slice(guardMarker.length)));
}

function writeCodexStub(directory) {
  const target = path.join(directory, process.platform === "win32" ? "codex-test.cmd" : "codex-test");
  writeFileSync(
    target,
    process.platform === "win32"
      ? "@echo off\r\nif \"%1\"==\"--version\" (echo codex-cli 99.0.0& exit /b 0)\r\nif \"%1\"==\"login\" exit /b 0\r\nif \"%1\"==\"debug\" (echo {\"models\":[]}& exit /b 0)\r\nexit /b 1\r\n"
      : "#!/bin/sh\ncase \"$1\" in\n  --version) echo 'codex-cli 99.0.0' ;;\n  login) exit 0 ;;\n  debug) printf '%s\\n' '{\"models\":[]}' ;;\n  *) exit 1 ;;\nesac\n",
    { mode: 0o755 },
  );
  return target;
}

test("authenticated aggregate snippet is deterministic and usable", () => {
  const fixture = { routedCatalogPath, callerBaseUrl: capability };
  const first = renderAggregateSnippet(fixture);

  assert.equal(first, renderAggregateSnippet(fixture));
  assert.match(first, /routed-models\.json/);
  assert.match(first, /_codex-router\/[^/]+\/v1/);
  assert.match(first, /model_provider = "custom"/);
  assert.doesNotMatch(first, /^model\s*=/m);
  assert.match(first, /supports_standalone_web_search = true/);
  assert.match(first, /wire_api = "responses"/);
});

test("aggregate status is redacted and contains no protected snippet", () => {
  const status = aggregateSnippetStatus({
    routedCatalogPath,
    redactedBaseUrl: redactedCapability,
  });
  const serialized = JSON.stringify(status);

  assert.deepEqual(status, {
    modelCatalogJson: routedCatalogPath,
    baseUrl: redactedCapability,
    supportsStandaloneWebSearch: true,
  });
  assert.doesNotMatch(serialized, /caller-capability-decoy-with-sufficient-length/);
  assert.doesNotMatch(serialized, /model_provider/);
});

test("aggregate status rejects an unredacted caller capability", () => {
  assert.throws(
    () => aggregateSnippetStatus({ routedCatalogPath, redactedBaseUrl: capability }),
    /canonical redacted caller URL/,
  );
});

test("aggregate status accepts only the exact canonical redacted caller URL", () => {
  const rejected = [
    `${redactedCapability}?next=/elsewhere`,
    `${redactedCapability} trailing-text`,
    `http://user@127.0.0.1:46192/_codex-router/[REDACTED]/v1`,
    `http://127.0.0.1:46192/_codex-router/${capability.split("/")[4]}/v1 [REDACTED]`,
    `http://127.0.0.1:46192/_codex-router/[REDACTED]/v1#fragment`,
    "http://127.0.0.1/_codex-router/[REDACTED]/v1",
    "https://127.0.0.1:46192/_codex-router/[REDACTED]/v1",
  ];

  for (const redactedBaseUrl of rejected) {
    assert.throws(
      () => aggregateSnippetStatus({ routedCatalogPath, redactedBaseUrl }),
      /canonical redacted caller URL/,
      redactedBaseUrl,
    );
  }
  assert.equal(
    aggregateSnippetStatus({ routedCatalogPath, redactedBaseUrl: "unavailable" }).baseUrl,
    "unavailable",
  );
});

test("rejected aggregate status errors do not echo the supplied capability", () => {
  const mixedCapability = `${capability} [REDACTED]`;
  let error;
  try {
    aggregateSnippetStatus({ routedCatalogPath, redactedBaseUrl: mixedCapability });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /caller-capability-decoy-with-sufficient-length/);
});

test("pure snippet and status surfaces do not carry filesystem or configuration writers", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/cc-switch-snippet.mjs", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(source, /(?:writeFile|writeFileSync|cc-switch\.db|config-manager)/);
});

test("catalog status is redacted while the local render command alone returns the snippet", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-snippet-"));
  const stateDir = path.join(codexHome, "router-state");
  const decoyDatabase = path.join(codexHome, ".cc-switch", "cc-switch.db");
  const secret = "catalog-command-capability-decoy-with-sufficient-length";
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_PORT: "46192",
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(decoyDatabase), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${secret}\n`, { mode: 0o600 });
  writeFileSync(path.join(codexHome, "config.toml"), "", { mode: 0o600 });
  writeFileSync(decoyDatabase, "do-not-touch", { mode: 0o600 });

  try {
    const status = spawnSync(process.execPath, ["src/control.mjs", "catalog", "status"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, new RegExp(secret));
    assert.equal(JSON.parse(status.stdout).aggregate.baseUrl, "unavailable");
    assert.equal(readFileSync(decoyDatabase, "utf8"), "do-not-touch");

    const rendered = spawnSync(process.execPath, ["src/control.mjs", "catalog", "render-snippet"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, new RegExp(secret));
    assert.match(rendered.stdout, /routed-models\.json/);
    assert.equal(readFileSync(decoyDatabase, "utf8"), "do-not-touch");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("read-only snippet, status, and doctor calls leave the fully isolated home untouched", () => {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-guard-"));
  const home = path.join(isolated, "home");
  const codexHome = path.join(isolated, "codex");
  const stateDir = path.join(codexHome, "router-state");
  const secret = "runtime-guard-caller-capability-decoy-with-sufficient-length";
  const ccSwitchDatabase = path.join(home, ".cc-switch", "cc-switch.db");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(isolated, "tmp"), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(ccSwitchDatabase), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(codexHome, "config.toml"), `web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${secret}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "internal-secret"), "runtime-guard-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(ccSwitchDatabase, "do-not-touch", { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TMP: path.join(isolated, "tmp"),
    TEMP: path.join(isolated, "tmp"),
    TMPDIR: path.join(isolated, "tmp"),
    CODEX_HOME: codexHome,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_PORT: "46192",
    CODEX_BIN: writeCodexStub(isolated),
    CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
    TASK5_RUNTIME_GUARD_ROOT: isolated,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${runtimeGuard}`.trim(),
  };

  try {
    const before = snapshotTree(isolated);
    for (const args of [
      ["src/control.mjs", "catalog", "status"],
      ["src/control.mjs", "catalog", "render-snippet"],
      ["src/doctor.mjs", "--json"],
    ]) {
      const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
      if (args[2] === "render-snippet") {
        assert.match(result.stdout, new RegExp(secret));
        assert.doesNotMatch(result.stderr, new RegExp(secret));
      } else {
        assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, new RegExp(secret));
      }
      assert.deepEqual(guardEvents(result.stderr), []);
      assert.deepEqual(snapshotTree(isolated), before, args.join(" "));
    }

    const ccSwitchOperations = [
      "readFileSync",
      "statSync",
      "openSync",
      "createWriteStream",
      "promises.open",
    ];
    for (const operation of ccSwitchOperations) {
      const script = `const fs = require("node:fs"); const target = process.argv[1]; const op = process.argv[2]; if (op === "readFileSync") fs.readFileSync(target); else if (op === "statSync") fs.statSync(target); else if (op === "openSync") fs.openSync(target, "w"); else if (op === "createWriteStream") fs.createWriteStream(target); else fs.promises.open(target, "w");`;
      const result = spawnSync(process.execPath, ["-e", script, ccSwitchDatabase, operation], {
        cwd: root,
        env,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, operation);
      assert.ok(
        guardEvents(result.stderr).some((event) => event.ccSwitchAccess && event.blocked),
        operation,
      );
      assert.deepEqual(snapshotTree(isolated), before, operation);
    }
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

test("runtime guard records canonical mutation paths, numeric flags, descriptors, FileHandles, and every CC Switch path position", () => {
  const container = mkdtempSync(path.join(os.tmpdir(), "codex-router-runtime-guard-self-test-"));
  const isolated = path.join(container, "guard-root");
  const ccSwitchDatabase = path.join(isolated, ".cc-switch", "cc-switch.db");
  const outside = path.join(container, "outside", "blocked.txt");
  mkdirSync(isolated, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(ccSwitchDatabase), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(outside), { recursive: true, mode: 0o700 });
  writeFileSync(ccSwitchDatabase, "do-not-touch", { mode: 0o600 });
  const env = {
    ...process.env,
    TASK5_RUNTIME_GUARD_ROOT: isolated,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${runtimeGuard}`.trim(),
  };
  const script = String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const { pathToFileURL } = require("node:url");
    const root = process.argv[1];
    const cc = process.argv[2];
    const outside = process.argv[3];
    const source = path.join(root, "source.txt");
    const numeric = path.join(root, "numeric.txt");
    const handled = path.join(root, "handled.txt");
    fs.writeFileSync(source, "source");
    const fd = fs.openSync(numeric, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC);
    fs.writeSync(fd, "first");
    fs.writevSync(fd, [Buffer.from("second")]);
    fs.ftruncateSync(fd, 3);
    try { fs.fchmodSync(fd, 0o600); } catch {}
    try { fs.fchownSync(fd, 0, 0); } catch {}
    try { fs.futimesSync(fd, new Date(), new Date()); } catch {}
    fs.fdatasyncSync(fd); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.copyFileSync(source, path.join(root, "copy.txt"));
    fs.renameSync(path.join(root, "copy.txt"), path.join(root, "renamed.txt"));
    fs.linkSync(source, path.join(root, "linked.txt"));
    try { fs.symlinkSync(source, path.join(root, "symlinked.txt")); } catch {}
    const stream = fs.createWriteStream(path.join(root, "stream.txt"));
    if (!stream || typeof stream.write !== "function") throw new Error("createWriteStream return shape changed");
    stream.end("stream");
    (async () => {
      const handle = await fs.promises.open(handled, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC);
      await handle.write("one"); await handle.writev([Buffer.from("two")]);
      await handle.writeFile("three"); await handle.appendFile("four"); await handle.truncate(2);
      try { await handle.chmod(0o600); } catch {}
      try { await handle.chown(0, 0); } catch {}
      try { await handle.utimes(new Date(), new Date()); } catch {}
      await handle.sync(); await handle.datasync();
      const handleStream = handle.createWriteStream();
      if (!handleStream || typeof handleStream.write !== "function") throw new Error("FileHandle createWriteStream return shape changed");
      handleStream.end(); await handle.close();
      for (const value of [Buffer.from(path.dirname(cc)), pathToFileURL(cc)]) {
        try { fs.statSync(value); } catch {}
      }
      process.chdir(root);
      try { await fs.promises.readFile(".cc-switch/cc-switch.db"); } catch {}
      try { fs.copyFileSync(source, cc); } catch {}
      try { fs.renameSync(cc, path.join(root, "blocked-rename.txt")); } catch {}
      try { fs.writeFileSync(outside, "outside"); } catch (error) {
        if (error.message !== "Task 5 runtime guard blocked mutation outside isolated root.") throw error;
      }
    })().catch((error) => { console.error(error.stack); process.exitCode = 1; });
  `;

  try {
    const result = spawnSync(process.execPath, ["-e", script, isolated, ccSwitchDatabase, outside], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const events = guardEvents(result.stderr);
    const expected = [
      "fs.openSync",
      "fs.writeSync",
      "fs.writevSync",
      "fs.ftruncateSync",
      "fs.fchmodSync",
      "fs.fchownSync",
      "fs.futimesSync",
      "fs.fdatasyncSync",
      "fs.fsyncSync",
      "fs.promises.open",
      "fs.promises.FileHandle.write",
      "fs.promises.FileHandle.writev",
      "fs.promises.FileHandle.writeFile",
      "fs.promises.FileHandle.appendFile",
      "fs.promises.FileHandle.truncate",
      "fs.promises.FileHandle.chmod",
      "fs.promises.FileHandle.chown",
      "fs.promises.FileHandle.utimes",
      "fs.promises.FileHandle.sync",
      "fs.promises.FileHandle.datasync",
      "fs.createWriteStream",
    ];
    for (const kind of expected) assert.ok(events.some((event) => event.kind === kind), kind);
    for (const kind of ["fs.copyFileSync", "fs.renameSync", "fs.linkSync", "fs.symlinkSync"]) {
      assert.ok(events.filter((event) => event.kind === kind).length >= 2, kind);
    }
    assert.ok(events.some((event) => event.kind === "fs.openSync" && event.numericOpenFlags), "numeric flags");
    assert.ok(events.filter((event) => event.ccSwitchAccess && event.blocked).length >= 5, "CC root and descendants");
    assert.ok(
      events.some((event) => event.path === path.resolve(outside).replaceAll("\\", "/") && event.outsideIsolation && event.blocked),
      "outside isolation write",
    );
    assert.equal(existsSync(outside), false, "guard blocks the outside write before the original API runs");
    assert.ok(events.every((event) => event.path === undefined || path.isAbsolute(event.path)), "canonical paths");
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("only the explicit local catalog command references protected snippet rendering", () => {
  const sourceFiles = readdirSync(path.join(root, "src"))
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => readFileSync(path.join(root, "src", name), "utf8").includes("renderAggregateSnippet"));

  assert.deepEqual(sourceFiles.sort(), ["cc-switch-snippet.mjs", "control.mjs"]);
});

test("production source has no SQLite or CC Switch database adapter", () => {
  const forbidden = /(?:better-sqlite3|node:sqlite|from\s+["']sqlite|cc-switch\.db|\.cc-switch[\\/])/i;
  const offenders = readdirSync(path.join(root, "src"))
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => forbidden.test(readFileSync(path.join(root, "src", name), "utf8")));

  assert.deepEqual(offenders, []);
});

test("aggregate status never leaks a decoy caller capability into a support bundle or log tail", { skip: process.platform !== "darwin" }, () => {
  const isolated = mkdtempSync(path.join(os.tmpdir(), "codex-router-support-redaction-"));
  const codexHome = path.join(isolated, "codex");
  const stateDir = path.join(codexHome, "router-state");
  const secret = "support-bundle-caller-capability-decoy-with-sufficient-length";
  const capabilityUrl = `http://127.0.0.1:46195/_codex-router/${secret}/v1`;
  const output = path.join(isolated, "support.json");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(codexHome, "config.toml"), "", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${secret}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "internal-secret"), "support-internal-key-with-sufficient-length\n", { mode: 0o600 });
  writeFileSync(path.join(stateDir, "router.log"), `base_url=${capabilityUrl}\n`, { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: path.join(isolated, "home"),
    USERPROFILE: path.join(isolated, "home"),
    APPDATA: path.join(isolated, "home", "AppData", "Roaming"),
    LOCALAPPDATA: path.join(isolated, "home", "AppData", "Local"),
    CODEX_HOME: codexHome,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_PORT: "46195",
    CODEX_BIN: writeCodexStub(isolated),
    CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
  };

  try {
    const result = spawnSync(
      process.execPath,
      ["src/support-bundle.mjs", "--include-logs", "--output", output],
      { cwd: root, env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const surfaces = `${result.stdout}\n${result.stderr}\n${readFileSync(output, "utf8")}`;
    assert.doesNotMatch(surfaces, new RegExp(secret));
    assert.doesNotMatch(surfaces, /model_provider = "custom"/);
    assert.match(readFileSync(output, "utf8"), /\[REDACTED\]/);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
