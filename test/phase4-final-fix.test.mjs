import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { migrateRuntime } from "../src/runtime-migration.mjs";
import { buildReleasePackage } from "../scripts/package-release.mjs";
import { updateCheckout } from "../src/update.mjs";
import { currentServiceTarget } from "../src/paths.mjs";
import { ownedRuntimePaths } from "../src/owned-runtime-paths.mjs";
import { createTrayFixtureContext, readTrayFixtureContext, writeTrayFixtureContext } from "../src/tray-build-plan.mjs";
import { PRODUCTION_SERVICE_TARGET, resolveServiceTarget } from "../src/service-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function archiveEntries(archivePath) {
  const bytes = gunzipSync(readFileSync(archivePath));
  const entries = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const archivePath = (prefix ? `${prefix}/` : "") + name.replace(/\/$/, "");
    entries.set(archivePath, {
      data: Buffer.from(bytes.subarray(offset + 512, offset + 512 + size)),
      size,
      type: header[156] === 0x35 ? "directory" : "file",
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("tray fixture context requires a validated isolated target and seals every mock path", () => {
  const isolationRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-tray-context-"));
  try {
    const target = resolveServiceTarget({
      mode: "acceptance",
      isolationRoot,
      sourceRoot: path.join(isolationRoot, "checkout"),
      routerLabel: "io.github.codex-router.fixture",
      trayLabel: "io.github.codex-router.fixture.tray",
      ports: { oauth: 7211, router: 7212, api: 7213, grokOauth: 7218, devinCli: 7220 },
    });
    const tools = {
      uname: path.join(isolationRoot, "mock-tools", "uname"),
      swift: path.join(isolationRoot, "mock-tools", "swift"),
      codesign: path.join(isolationRoot, "mock-tools", "codesign"),
      plistBuddy: path.join(isolationRoot, "mock-tools", "PlistBuddy"),
    };
    const context = createTrayFixtureContext(target, { tools, buildOnly: true });
    assert.equal(context.mode, "acceptance");
    assert.equal(context.isolationRoot, isolationRoot);
    assert.equal(context.target.sourceRoot, target.sourceRoot);
    assert.equal(context.tools.codesign, tools.codesign);
    assert.equal(context.buildOnly, true);
    const contextPath = path.join(isolationRoot, "fixture-context.json");
    writeTrayFixtureContext(contextPath, target, { tools, buildOnly: true });
    assert.deepEqual(readTrayFixtureContext(contextPath), context);
    assert.throws(() => createTrayFixtureContext(PRODUCTION_SERVICE_TARGET), /acceptance|test|fixture/i);
    assert.throws(() => createTrayFixtureContext({ ...target }), /validated|ServiceTarget/i);
    assert.throws(
      () => createTrayFixtureContext(target, { tools, buildOnly: false }),
      /build-only/i,
    );
    assert.throws(
      () => createTrayFixtureContext(target, { tools: { ...tools, swift: path.join(isolationRoot, "..", "swift") } }),
      /inside|isolation|root|below/i,
    );
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

test("runtime migration runs preflight after snapshot and before revision mutation", async () => {
  const events = [];
  await migrateRuntime({
    snapshot: async () => { events.push("snapshot"); return { version: 1 }; },
    preflight: async () => events.push("preflight"),
    installReplacement: async () => events.push("revision-change"),
    verifyReplacement: async () => events.push("verify"),
    publishReplacement: async () => events.push("publish"),
    cleanupOld: async () => events.push("cleanup"),
  });
  assert.deepEqual(events, ["snapshot", "preflight", "revision-change", "verify", "publish", "cleanup"]);
});

test("vision Responses reads the dispatcher's transformed body", () => {
  const router = source("src/router.mjs");
  assert.match(
    router,
    /const body = result\.transforms\?\.length\s*\?\s*await readDispatchBody\(result\)/,
  );
});

test("update-level injection keeps snapshot and preflight before the merge", async () => {
  const target = currentServiceTarget();
  const snapshot = {
    version: 1,
    target,
    options: ownedRuntimePaths(target).options,
    entries: {},
  };
  const events = [];
  const gitCalls = [];
  const gitImpl = (args) => {
    gitCalls.push(args);
    if (args[0] === "remote") return "https://github.com/duolahypercho/codex-router.git";
    if (args[0] === "branch") return "main";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "old-revision";
    if (args[0] === "rev-parse" && args[1] === "origin/main") return "new-revision";
    return "";
  };
  await updateCheckout({
    gitImpl,
    target,
    runtime: {
      snapshot,
      preflight: async () => events.push("preflight"),
      installReplacement: async () => {
        events.push("merge");
        gitImpl(["merge", "--ff-only", "new-revision"]);
      },
      verifyReplacement: async () => events.push("verify"),
      publishReplacement: async () => events.push("publish"),
      cleanupOld: async () => events.push("cleanup"),
    },
  });
  assert.deepEqual(events, ["preflight", "merge", "verify", "publish", "cleanup"]);
  assert.ok(gitCalls.findIndex((args) => args[0] === "merge") > gitCalls.findIndex((args) => args[0] === "branch"));
});

test("update restore attempts runtime and revision independently and keeps primary first", async () => {
  const events = [];
  await assert.rejects(
    () => import("../src/update.mjs").then(({ restoreRuntimeAndRevision }) =>
      restoreRuntimeAndRevision({}, "old-revision", {
        restoreRuntime: async () => {
          events.push("runtime");
          throw new Error("runtime restore failed");
        },
        restoreRevision: async () => {
          events.push("revision");
          throw new Error("revision restore failed");
        },
      }),
    ),
    (error) => {
      assert.deepEqual(events, ["runtime", "revision"]);
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.errors[0].message, "runtime restore failed");
      assert.equal(error.errors[1].message, "revision restore failed");
      return true;
    },
  );
});

test("public lifecycle entrypoints never reach the Codex config writer", () => {
  for (const file of ["bin/install", "bin/enable", "bin/disable", "bin/update", "bin/setup", "src/control.mjs"]) {
    assert.doesNotMatch(source(file), /config-manager\.mjs/);
  }
});

test("local uninstall has no hidden publication/finalization worker", () => {
  const worker = source("src/local-uninstall.mjs");
  const control = source("src/control.mjs");
  assert.doesNotMatch(worker, /finalize-uninstall|model-overlay-publication|provider-selection|restartRouter|catalog\.mjs/);
  assert.doesNotMatch(control, /finalizeLocalModelPublication|restartRouterForLocalRoutes|finalize-uninstall/);
  assert.match(worker, /writeLocalDownload\(/);
});

test("legacy migration reads config only and never invokes a config writer", () => {
  const migration = source("src/legacy-migration.mjs");
  assert.doesNotMatch(migration, /config-manager\.mjs|copyFileSync\([^\n]*CONFIG_PATH|protectPrivateFile\(CONFIG_PATH/);
  assert.match(migration, /readFileSync\(CONFIG_PATH/);
  assert.match(migration, /configText\(/);
});

test("release workflow uses the verified packer and binds tag to HEAD", () => {
  const workflow = source(".github/workflows/release.yml");
  assert.match(workflow, /scripts\/package-release\.sh/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /SHA256SUMS/);
  assert.doesNotMatch(workflow, /git archive/);
});

test("runtime release contains only usable runtime metadata and current handoff documents", () => {
  const output = mkdtempSync(path.join(os.tmpdir(), "phase4-source-release-"));
  try {
    const result = buildReleasePackage({ sourceRoot: root, outputDir: output });
    const entries = archiveEntries(result.archivePath);
    const paths = new Set(entries.keys());
    for (const required of [
      "codex-router/runtime-package.json",
      "codex-router/docs/INSTALL.md",
      "codex-router/docs/DEVIN-CLI-PROBE.md",
      "codex-router/scripts/build-macos-tray-app.sh",
      "codex-router/README.md",
      "codex-router/SECURITY.md",
      "codex-router/LICENSE",
    ]) {
      assert.ok(paths.has(required), `missing source-release entry ${required}`);
    }
    assert.equal([...paths].some((entry) => entry.startsWith("codex-router/test/")), false);
    assert.equal(paths.has("codex-router/scripts-check.mjs"), false);
    assert.equal(paths.has("codex-router/scripts/package-release.mjs"), false);
    assert.equal(paths.has("codex-router/scripts/package-release.sh"), false);
    assert.equal(paths.has("codex-router/scripts/build-macos-tray-app.sh"), true);
    assert.equal(paths.has("codex-router/bin/test-model"), true);
    const metadata = JSON.parse(source("runtime-package.json"));
    const archivedMetadata = JSON.parse(entries.get("codex-router/runtime-package.json").data.toString("utf8"));
    const archivedPackage = JSON.parse(entries.get("codex-router/package.json").data.toString("utf8"));
    assert.equal(metadata.runtime, "node");
    assert.deepEqual(archivedMetadata, metadata);
    assert.equal(Object.hasOwn(archivedPackage.scripts || {}, "test"), false);
    assert.equal(Object.hasOwn(archivedPackage.scripts || {}, "check"), false);
    assert.equal(Object.hasOwn(archivedPackage.scripts || {}, "package"), false);
    assert.ok(metadata.entrypoints.every((entry) => paths.has(`codex-router/${entry}`)));
    const unpackRoot = mkdtempSync(path.join(os.tmpdir(), "phase4-runtime-unpack-"));
    const unpack = path.join(unpackRoot, "checkout");
    mkdirSync(unpack, { recursive: true });
    try {
      for (const [archivePath, archiveEntry] of entries) {
        if (archiveEntry.type !== "file" || !archivePath.startsWith("codex-router/")) continue;
        const target = path.join(unpack, archivePath.slice("codex-router/".length));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, archiveEntry.data);
      }
      for (const entrypoint of metadata.entrypoints) {
        const archiveEntry = entries.get(`codex-router/${entrypoint}`);
        const target = path.join(unpack, entrypoint);
        if (entrypoint.endsWith(".mjs")) {
          const checked = spawnSync(process.execPath, ["--check", target], { encoding: "utf8" });
          assert.equal(checked.status, 0, `${entrypoint}: ${checked.stderr}`);
        } else if (entrypoint === "bin/model-router") {
          const help = spawnSync("sh", [target, "--help"], { encoding: "utf8" });
          assert.ok([0, 2].includes(help.status), `${entrypoint}: ${help.stderr}`);
        } else if (entrypoint === "bin/install") {
          const help = spawnSync("sh", [target, "--help"], { encoding: "utf8" });
          assert.ok([0, 2].includes(help.status), `${entrypoint}: ${help.stderr}`);
        } else if (entrypoint === "bin/model-router-tray") {
          const mockDir = path.join(unpack, "mock-tools");
          mkdirSync(mockDir, { recursive: true });
          const logPath = path.join(mockDir, "calls.log");
          const mock = (name, body) => {
            const file = path.join(mockDir, name);
            writeFileSync(file, body, { mode: 0o755 });
            return file;
          };
          const mockUname = mock("uname", "#!/bin/sh\nprintf 'Darwin\\n'\n");
          const mockCodesign = mock("codesign", "#!/bin/sh\nprintf 'codesign %s\\n' \"$*\" >>\"$MOCK_TRAY_LOG\"\n");
          const mockPlistBuddy = mock("PlistBuddy", "#!/bin/sh\nprintf 'plistbuddy %s\\n' \"$*\" >>\"$MOCK_TRAY_LOG\"\n");
          const mockSwift = mock("swift", "#!/bin/sh\nset -eu\ntray=\"$MOCK_TRAY_DIR\"\nmkdir -p \"$tray/.build/release/ModelRouterTray_ModelRouterTray.bundle\"\nprintf '#!/bin/sh\\n' >\"$tray/.build/release/ModelRouterTray\"\nchmod +x \"$tray/.build/release/ModelRouterTray\"\n");
          const contextPath = path.join(unpackRoot, "fixture-context.json");
          const isolationRoot = unpackRoot;
          const contextScript = `
            import { resolveServiceTarget } from "./src/service-target.mjs";
            import { writeTrayFixtureContext } from "./src/tray-build-plan.mjs";
            const target = resolveServiceTarget({
              mode: "acceptance",
              isolationRoot: ${JSON.stringify(isolationRoot)},
              sourceRoot: ${JSON.stringify(unpack)},
              routerLabel: "io.github.codex-router.runtime-test",
              trayLabel: "io.github.codex-router.runtime-test.tray",
              ports: { oauth: 5211, router: 5212, api: 5213, grokOauth: 5218, devinCli: 5220 },
            });
            writeTrayFixtureContext(${JSON.stringify(contextPath)}, target, {
              tools: {
                uname: ${JSON.stringify(mockUname)},
                swift: ${JSON.stringify(mockSwift)},
                codesign: ${JSON.stringify(mockCodesign)},
                plistBuddy: ${JSON.stringify(mockPlistBuddy)},
              },
              buildOnly: true,
            });
          `;
          const contextRun = spawnSync(process.execPath, ["--input-type=module", "--eval", contextScript], {
            cwd: unpack,
            encoding: "utf8",
          });
          assert.equal(contextRun.status, 0, `${entrypoint} context: ${contextRun.stdout}\n${contextRun.stderr}`);
          const fixtureCheck = spawnSync(process.execPath, [
            "--input-type=module",
            "--eval",
            `import { readTrayFixtureContext } from "./src/tray-build-plan.mjs"; const context = readTrayFixtureContext(${JSON.stringify(contextPath)}); if (context.target.sourceRoot !== ${JSON.stringify(unpack)}) process.exit(1);`,
          ], { cwd: unpack, encoding: "utf8" });
          assert.equal(fixtureCheck.status, 0, `${entrypoint} fixture plan: ${fixtureCheck.stderr}`);
          if (process.platform === "darwin") {
            const trayRun = spawnSync("sh", [target, "--fixture-context", contextPath], {
              cwd: unpack,
              encoding: "utf8",
              env: {
                ...process.env,
                MODEL_ROUTER_UNAME_BIN: path.join(mockDir, "ignored-uname"),
                MODEL_ROUTER_SWIFT_BIN: path.join(mockDir, "ignored-swift"),
                MODEL_ROUTER_CODESIGN_BIN: path.join(mockDir, "ignored-codesign"),
                MODEL_ROUTER_PLISTBUDDY_BIN: path.join(mockDir, "ignored-PlistBuddy"),
                MODEL_ROUTER_TRAY_BUILD_ONLY: "0",
                MOCK_TRAY_DIR: path.join(unpack, "apps", "macos", "ModelRouterTray"),
                MOCK_TRAY_LOG: logPath,
              },
            });
            assert.equal(trayRun.status, 0, `${entrypoint}: ${trayRun.stdout}\n${trayRun.stderr}`);
            const bundle = path.join(isolationRoot, "Applications", "Model Router.app");
            assert.equal(readFileSync(path.join(bundle, "Contents", "MacOS", "ModelRouterTray"), "utf8"), "#!/bin/sh\n");
            const calls = readFileSync(logPath, "utf8");
            assert.match(calls, /codesign/);
            assert.match(calls, /plistbuddy/);
          }
        }
      }
    } finally {
      rmSync(unpackRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("runtime package negative paths cannot re-enter the final manifest", () => {
  const sourceText = source("scripts/package-release.mjs");
  assert.doesNotMatch(sourceText, /const PACKAGE_ROOTS = Object\.freeze\(\[[^\]]*"test"/s);
  assert.match(sourceText, /forbiddenRuntimePath/);
  assert.doesNotMatch(sourceText, /scripts-check\.mjs/);
});

test("current docs keep the runtime package distinction and protected uninstall promise", () => {
  const readme = source("README.md");
  const install = source("docs/INSTALL.md");
  assert.doesNotMatch(readme, /model-router codex apply/);
  assert.doesNotMatch(install, /model-router codex apply/);
  const protectedUninstallSentences = [
    readme.split("\n").find((line) => line.includes("卸载") && line.includes("caller key") && line.includes("config.toml")),
    install.split("\n").find((line) => line.includes("卸载") && line.includes("caller key") && line.includes("config.toml")),
  ];
  for (const line of protectedUninstallSentences) {
    assert.ok(line, "uninstall documentation must state the protected files");
    const sentence = line.slice(line.indexOf("。") + 1);
    assert.match(sentence, /caller key/);
    assert.match(sentence, /internal key/);
    assert.match(sentence, /provider keys?/i);
    assert.match(sentence, /Codex (?:身份验证|登录)/);
    assert.match(sentence, /config\.toml/);
    assert.doesNotMatch(sentence, /(?:删除|撤销)/);
  }
  assert.match(install, /runtime (?:release|package)|source (?:checkout|release)/i);
});

test("package CLI rejects options whose values are missing", () => {
  const result = spawnSync(process.execPath, ["scripts/package-release.mjs", "--output"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /missing value|requires.*path|output/i);
});
