import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRODUCTION_SERVICE_TARGET,
  resolveServiceTarget,
} from "../src/service-target.mjs";
import { trayRebuildPlan } from "../src/install-plan.mjs";
import { writeTrayFixtureContext } from "../src/tray-build-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pathsForTarget(target) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { PORTS } from "./src/paths.mjs"; process.stdout.write(JSON.stringify(PORTS));',
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: target,
        MODEL_ROUTER_OAUTH_PORT: "",
        MODEL_ROUTER_PORT: "",
        MODEL_ROUTER_API_PORT: "",
        MODEL_ROUTER_GROK_OAUTH_PORT: "",
      },
    },
  );
}

test("codex owns the default port block", () => {
  assert.deepEqual(JSON.parse(pathsForTarget("codex")), {
    oauth: 4201,
    router: 4202,
    api: 4203,
    grokOauth: 4208,
    devinCli: 4210,
  });
});

test("operators can keep an explicitly configured forwarder port block during migration", () => {
  const ports = JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", 'import { PORTS } from "./src/paths.mjs"; process.stdout.write(JSON.stringify(PORTS));'],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_TARGET: "codex",
          MODEL_ROUTER_OAUTH_PORT: "4101",
          MODEL_ROUTER_PORT: "4102",
          MODEL_ROUTER_API_PORT: "4103",
          MODEL_ROUTER_GROK_OAUTH_PORT: "4108",
        },
      },
    ),
  );
  // The Devin CLI forwarder postdates the legacy block, so an operator
  // migrating from it never pinned that port and keeps the current default.
  assert.deepEqual(ports, {
    oauth: 4101,
    router: 4102,
    api: 4103,
    grokOauth: 4108,
    devinCli: 4210,
  });
});

test("removed targets are rejected rather than silently mapped to codex", () => {
  for (const target of ["cursor", "opencode", "dsh", "gemini"]) {
    assert.throws(
      () => pathsForTarget(target),
      /MODEL_ROUTER_TARGET must be one of/,
      `${target} should no longer be a valid target`,
    );
  }
});

test("an explicit acceptance target carries one isolated Router and Tray namespace", () => {
  const root = path.join(os.tmpdir(), "codex-router-acceptance-target");
  const target = resolveServiceTarget({
    mode: "acceptance",
    isolationRoot: root,
    routerLabel: "io.github.codex-router.acceptance",
    trayLabel: "io.github.codex-router.acceptance.tray",
    ports: { oauth: 5201, router: 5202, api: 5203, grokOauth: 5208, devinCli: 5210 },
  });

  assert.notEqual(target.routerLabel, PRODUCTION_SERVICE_TARGET.routerLabel);
  assert.notEqual(target.trayLabel, PRODUCTION_SERVICE_TARGET.trayLabel);
  assert.equal(target.routerService, `${target.launchDomain}/${target.routerLabel}`);
  assert.equal(target.trayService, `${target.launchDomain}/${target.trayLabel}`);
  assert.deepEqual(target.ports, { oauth: 5201, router: 5202, api: 5203, grokOauth: 5208, devinCli: 5210 });
  for (const value of [
    target.routerPlistPath,
    target.trayPlistPath,
    target.appPath,
    target.stateRoot,
    target.supportRoot,
    target.logPath,
  ]) {
    assert.equal(path.relative(root, value).startsWith(".."), false, value);
  }
});

test("production target rejects isolated overrides without explicit acceptance mode", () => {
  assert.throws(
    () => resolveServiceTarget({ isolationRoot: path.join(os.tmpdir(), "router-test") }),
    /acceptance|test mode/i,
  );
});

test("isolated target rejects production collisions, traversal, duplicate ports, and symlink escape", () => {
  const root = path.join(os.tmpdir(), "codex-router-target-collision");
  const cases = [
    [{ mode: "acceptance", isolationRoot: root, routerLabel: PRODUCTION_SERVICE_TARGET.routerLabel }, /production|collision/i],
    [{ mode: "acceptance", isolationRoot: root, stateRoot: path.join(root, "..", "outside") }, /inside|root|traversal/i],
    [{ mode: "acceptance", isolationRoot: root, ports: { oauth: 5300, router: 5300 } }, /port|duplicate/i],
    [{ mode: "acceptance", isolationRoot: root, host: "0.0.0.0" }, /loopback|host/i],
    [{ mode: "acceptance", isolationRoot: root, routerPlistPath: path.join(root, "same.plist"), trayPlistPath: path.join(root, "same.plist") }, /plist|unique|collision/i],
    [{ mode: "acceptance", isolationRoot: root, sourceRoot: path.join(root, "..", "outside") }, /inside|root|traversal/i],
  ];
  for (const [overrides, pattern] of cases) assert.throws(() => resolveServiceTarget(overrides), pattern);
});

test("target collision checks normalize labels, ports, and cross-purpose paths", () => {
  const root = path.join(os.tmpdir(), "codex-router-cross-collision");
  const productionRoot = path.join(root, "production");
  const production = {
    ...PRODUCTION_SERVICE_TARGET,
    launchAgentsDir: path.join(productionRoot, "LaunchAgents"),
    routerPlistPath: path.join(productionRoot, "LaunchAgents", "router.plist"),
    trayPlistPath: path.join(productionRoot, "LaunchAgents", "tray.plist"),
    appPath: path.join(productionRoot, "Applications", "Router.app"),
    appBinary: path.join(productionRoot, "Applications", "Router.app", "Contents", "MacOS", "Router"),
    stateRoot: path.join(productionRoot, "state"),
    supportRoot: path.join(productionRoot, "state", "support"),
    logPath: path.join(productionRoot, "state", "router.log"),
    ports: { oauth: 6201, router: 6202, api: 6203, grokOauth: 6208, devinCli: 6210 },
  };
  const valid = {
    mode: "acceptance",
    isolationRoot: root,
    routerLabel: "io.github.codex-router.acceptance",
    trayLabel: "io.github.codex-router.acceptance.tray",
    ports: { oauth: 6301, router: 6302, api: 6303, grokOauth: 6308, devinCli: 6310 },
  };
  const cases = [
    { ...valid, routerLabel: production.trayLabel.toUpperCase() },
    { ...valid, trayLabel: production.routerLabel.toUpperCase() },
    { ...valid, ports: { ...valid.ports, oauth: production.ports.router } },
    { ...valid, routerPlistPath: path.join(root, "state") },
    { ...valid, logPath: path.join(root, "state") },
    { ...valid, stateRoot: path.join(root, "Applications") },
    { ...valid, routerPlistPath: production.routerPlistPath },
  ];
  for (const overrides of cases) {
    assert.throws(() => resolveServiceTarget(overrides, production), /collision|unique|overlap|production|port|sibling/i);
  }
});

test("acceptance target keeps the tray app and status paths away from production", () => {
  const root = path.join(os.tmpdir(), "codex-router-tray-acceptance");
  const target = resolveServiceTarget({
    mode: "acceptance",
    isolationRoot: root,
    routerLabel: "io.github.codex-router.acceptance",
    trayLabel: "io.github.codex-router.acceptance.tray",
    ports: { oauth: 6401, router: 6402, api: 6403, grokOauth: 6408, devinCli: 6410 },
  });
  assert.notEqual(target.appPath, PRODUCTION_SERVICE_TARGET.appPath);
  assert.notEqual(target.appBinary, PRODUCTION_SERVICE_TARGET.appBinary);
  assert.notEqual(target.trayPlistPath, PRODUCTION_SERVICE_TARGET.trayPlistPath);
  assert.match(target.appBinary, /ModelRouterTray/);
  assert.equal(trayRebuildPlan({ root, platform: "darwin", serviceTarget: target }), "absent");
});

test("support bundle and control logs consume the resolved target roots", () => {
  const isolationRoot = path.join(os.tmpdir(), "codex-router-consumer-target");
  const env = {
    ...process.env,
    CODEX_ROUTER_SERVICE_MODE: "acceptance",
    MODEL_ROUTER_ISOLATION_ROOT: isolationRoot,
    MODEL_ROUTER_SERVICE_LABEL: "io.github.codex-router.consumer",
    MODEL_ROUTER_TRAY_SERVICE_LABEL: "io.github.codex-router.consumer.tray",
    MODEL_ROUTER_OAUTH_PORT: "6501",
    MODEL_ROUTER_PORT: "6502",
    MODEL_ROUTER_API_PORT: "6503",
    MODEL_ROUTER_GROK_OAUTH_PORT: "6508",
    MODEL_ROUTER_DEVIN_CLI_PORT: "6510",
    CODEX_HOME: path.join(isolationRoot, "codex"),
    MODEL_ROUTER_STATE_DIR: path.join(isolationRoot, "state"),
  };
  const target = resolveServiceTarget({
    mode: "acceptance",
    isolationRoot,
    routerLabel: "io.github.codex-router.consumer",
    trayLabel: "io.github.codex-router.consumer.tray",
    ports: { oauth: 6501, router: 6502, api: 6503, grokOauth: 6508, devinCli: 6510 },
  });
  const decoy = "consumer-target-log-decoy";
  mkdirSync(target.stateRoot, { recursive: true });
  writeFileSync(target.logPath, `${decoy}\n`);
  try {
    const logs = spawnSync(process.execPath, [path.join(root, "src", "control.mjs"), "logs"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(logs.status, 0, logs.stderr);
    assert.match(logs.stdout, new RegExp(decoy));

    const supportScript = `
      import { createSupportBundle } from "./src/support-bundle.mjs";
      const target = ${JSON.stringify(target)};
      const result = createSupportBundle({ serviceTarget: target });
      process.stdout.write(JSON.stringify(result));
    `;
    const bundle = spawnSync(process.execPath, ["--input-type=module", "--eval", supportScript], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(bundle.status, 0, bundle.stderr);
    const result = JSON.parse(bundle.stdout);
    assert.match(result.path, new RegExp(target.supportRoot.replaceAll("\\", "\\\\")));
    assert.equal(JSON.parse(readFileSync(result.path, "utf8")).files.logExists, true);
  } finally {
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

test("real symlink escape is rejected while nonexistent isolated parents remain valid", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-real-link-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "codex-router-real-link-outside-"));
  const link = path.join(root, "link");
  try {
    try {
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`symlink fixture unavailable: ${error.code || error.message}`);
      return;
    }
    const base = {
      mode: "acceptance",
      isolationRoot: root,
      routerLabel: "io.github.codex-router.link",
      trayLabel: "io.github.codex-router.link.tray",
      ports: { oauth: 6601, router: 6602, api: 6603, grokOauth: 6608, devinCli: 6610 },
    };
    assert.throws(
      () => resolveServiceTarget({ ...base, stateRoot: path.join(link, "state") }),
      /symlink|junction/i,
    );
    const valid = resolveServiceTarget({ ...base, stateRoot: path.join(root, "not-created", "state") });
    assert.match(valid.stateRoot, /not-created/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("Windows target paths normalize mixed separators and case", { skip: process.platform !== "win32" }, () => {
  const root = path.join(os.tmpdir(), "codex-router-mixed-path");
  const base = {
    mode: "acceptance",
    platform: "win32",
    isolationRoot: root,
    routerLabel: "io.github.codex-router.mixed",
    trayLabel: "io.github.codex-router.mixed.tray",
    ports: { oauth: 6701, router: 6702, api: 6703, grokOauth: 6708, devinCli: 6710 },
  };
  const target = resolveServiceTarget({
    ...base,
    stateRoot: `${root}\\STATE/mixed`,
    supportRoot: `${root}\\STATE/mixed\\SUPPORT`,
    logPath: `${root}\\STATE/mixed\\router.LOG`,
  });
  assert.match(target.stateRoot.toLowerCase(), /state[\\/]mixed/);
});

test("Windows UNC paths cannot escape the isolated root", { skip: process.platform !== "win32" }, () => {
  assert.throws(
    () => resolveServiceTarget({
      mode: "acceptance",
      platform: "win32",
      isolationRoot: path.join(os.tmpdir(), "codex-router-unc"),
      routerLabel: "io.github.codex-router.unc",
      trayLabel: "io.github.codex-router.unc.tray",
      stateRoot: "\\\\server\\share\\router-state",
      ports: { oauth: 6801, router: 6802, api: 6803, grokOauth: 6808, devinCli: 6810 },
    }),
    /inside|root|traversal/i,
  );
});

test("bundle identifier rewrite follows the validated Tray label", async () => {
  const { setBundleIdentifier } = await import("../src/tray-bundle.mjs");
  const source = "<key>CFBundleIdentifier</key>\n<string>io.github.codex-router.tray</string>\n";
  const rewritten = setBundleIdentifier(source, "io.github.codex-router.acceptance.tray");
  assert.match(rewritten, /io\.github\.codex-router\.acceptance\.tray/);
  assert.doesNotMatch(rewritten, /io\.github\.codex-router\.tray/);
});

test("tray fixture plans resolve from a repository-external cwd without mutation", () => {
  const isolationRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-wrapper-cwd-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "codex-router-outside-cwd-"));
  try {
    const isolatedSourceRoot = path.join(isolationRoot, "checkout");
    mkdirSync(isolatedSourceRoot, { recursive: true });
    const target = resolveServiceTarget({
      mode: "acceptance",
      isolationRoot,
      sourceRoot: isolatedSourceRoot,
      routerLabel: "io.github.codex-router.cwd",
      trayLabel: "io.github.codex-router.cwd.tray",
      ports: { oauth: 6901, router: 6902, api: 6903, grokOauth: 6908, devinCli: 6910 },
    });
    const mockRoot = path.join(isolationRoot, "mock-tools");
    const contextPath = path.join(isolationRoot, "tray-context.json");
    writeTrayFixtureContext(contextPath, target, {
      tools: {
        uname: path.join(mockRoot, "uname"),
        swift: path.join(mockRoot, "swift"),
        codesign: path.join(mockRoot, "codesign"),
        plistBuddy: path.join(mockRoot, "PlistBuddy"),
      },
      buildOnly: true,
      dryRun: true,
    });
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "tray-build-plan.mjs"), "--fixture-field", contextPath, "appPath"],
      { cwd: outside, encoding: "utf8", env: process.env },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), target.appPath);
    const validated = spawnSync(
      process.execPath,
      [path.join(root, "src", "tray-build-plan.mjs"), "--fixture-validate-output", contextPath, target.appPath],
      { cwd: outside, encoding: "utf8", env: process.env },
    );
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(existsSync(target.appPath), false, "dry-run must not assemble even the isolated app");
    assert.equal(existsSync(target.trayPlistPath), false, "dry-run must not install a LaunchAgent");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(isolationRoot, { recursive: true, force: true });
  }
});

test("isolated tray replacement has no production kill or legacy cleanup path", () => {
  const source = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  assert.match(source, /context_mode=/);
  assert.match(source, /--fixture-context/);
  assert.match(source, /osascript -e.*tray_label.*\|\| true/);
  assert.match(source, /if \[ "\$context_mode" = "production" \]; then[\s\S]*killall\s+-QUIT\s+ModelRouterTray/);
  assert.match(source, /if \[ "\$context_mode" = "production" \]; then[\s\S]*legacy_bundle/);
  assert.doesNotMatch(source, /MODEL_ROUTER_(?:UNAME|CODESIGN|PLIST_BUDDY)_BIN/);
  assert.doesNotMatch(source, /MODEL_ROUTER_TRAY_BUILD_ONLY/);
});

test("real Router and Tray plist renderers consume the same isolated target", () => {
  const isolationRoot = path.join(os.tmpdir(), "codex-router-plist-target");
  const env = {
    ...process.env,
    CODEX_ROUTER_SERVICE_MODE: "acceptance",
    MODEL_ROUTER_ISOLATION_ROOT: isolationRoot,
    MODEL_ROUTER_SERVICE_LABEL: "io.github.codex-router.acceptance",
    MODEL_ROUTER_TRAY_SERVICE_LABEL: "io.github.codex-router.acceptance.tray",
    MODEL_ROUTER_OAUTH_PORT: "5201",
    MODEL_ROUTER_PORT: "5202",
    MODEL_ROUTER_API_PORT: "5203",
    MODEL_ROUTER_GROK_OAUTH_PORT: "5208",
    MODEL_ROUTER_DEVIN_CLI_PORT: "5210",
  };
  for (const script of ["service-macos.mjs", "tray-service-macos.mjs"]) {
    const result = spawnSync(process.execPath, [path.join(root, "src", script), "render"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /io\.github\.codex-router\.acceptance/);
    if (script === "service-macos.mjs") assert.match(result.stdout, /5202/);
    assert.match(result.stdout, new RegExp(isolationRoot.replaceAll("\\", "\\\\").replaceAll(".", "\\.")));
  }
});
