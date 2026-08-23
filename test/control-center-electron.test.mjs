import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  assertMutationCompatibility,
  discoverSourceRoot,
  runControl,
  runControlJson,
  standardSourceRoots,
} from "../apps/control-center/electron/command-runner.mjs";

function processStillExists(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
  // A killed POSIX child can remain as a zombie until its parent reaps it;
  // kill(pid, 0) still succeeds for that state, which is not a live
  // descendant and should not make this bounded cleanup wait fail.
  if (process.platform !== "win32") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close !== -1 && stat.slice(close + 2, close + 3) === "Z") return false;
    } catch { /* /proc is unavailable or the process disappeared */ }
  }
  return true;
}

async function waitForProcessExit(pid, heartbeatFile, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 25;
  let lastHeartbeat;
  let heartbeatStableSince = Date.now();
  while (Date.now() < deadline && processStillExists(pid)) {
    try {
      const heartbeat = readFileSync(heartbeatFile, "utf8");
      if (heartbeat !== lastHeartbeat) {
        lastHeartbeat = heartbeat;
        heartbeatStableSince = Date.now();
      } else if (Date.now() - heartbeatStableSince >= 1_000) {
        // The original child stopped updating its identity marker. A reused
        // PID must not turn that successful tree termination into a failure.
        return;
      }
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(250, Math.ceil(delay * 1.5));
  }
  assert.equal(processStillExists(pid), false, `descendant process ${pid} survived command termination`);
}

async function makeProcessTreeControlRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "router-control-tree-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "bin"), { recursive: true });
  await writeFile(
    path.join(root, "src", "control.mjs"),
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const [pidFile, mode, heartbeatFile] = process.argv.slice(2);',
      'const descendant = spawn(process.execPath, ["-e", "const { writeFileSync } = require(\\"node:fs\\"); let tick = 0; const beat = () => writeFileSync(process.argv[1], String(++tick)); beat(); process.on(\\"SIGTERM\\", () => {}); setInterval(beat, 100);", heartbeatFile], { stdio: "ignore" });',
      'writeFileSync(pidFile, String(descendant.pid));',
      'if (mode === "overflow") process.stdout.write("x".repeat(4096));',
      'process.on("SIGTERM", () => {});',
      'setInterval(() => {}, 1000);',
      '',
    ].join("\n"),
    { mode: 0o700 },
  );
  await writeFile(path.join(root, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
  if (process.platform !== "win32") await chmod(path.join(root, "bin", "control"), 0o700);
  return root;
}

test("control center knows each installer's stable checkout location", () => {
  assert.deepEqual(
    standardSourceRoots({ platform: "win32", environment: { LOCALAPPDATA: "/local/appdata" }, home: "/home/test" }),
    [path.join("/local/appdata", "codex-router")],
  );
  assert.deepEqual(
    standardSourceRoots({ platform: "linux", environment: { XDG_DATA_HOME: "/xdg/data" }, home: "/home/test" }),
    [path.join("/xdg/data", "codex-router"), path.join("/home/test", ".local", "share", "codex-router")],
  );
});

test("control center resolves a trusted router source root", async () => {
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const priorModelState = process.env.MODEL_ROUTER_STATE_DIR;
  const priorState = process.env.CODEX_ROUTER_STATE_DIR;
  const priorKimiState = process.env.KIMI_CODEX_STATE_DIR;
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  delete process.env.CODEX_ROUTER_SOURCE_ROOT;
  delete process.env.MODEL_ROUTER_STATE_DIR;
  process.env.CODEX_ROUTER_STATE_DIR = state;
  delete process.env.KIMI_CODEX_STATE_DIR;
  const repositoryRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  try {
    assert.equal(discoverSourceRoot(), repositoryRoot);
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    if (priorModelState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = priorModelState;
    if (priorState === undefined) delete process.env.CODEX_ROUTER_STATE_DIR;
    else process.env.CODEX_ROUTER_STATE_DIR = priorState;
    if (priorKimiState === undefined) delete process.env.KIMI_CODEX_STATE_DIR;
    else process.env.KIMI_CODEX_STATE_DIR = priorKimiState;
    await rm(state, { recursive: true, force: true });
  }
});

test("control center follows the recorded router owner", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-owner-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const priorModelState = process.env.MODEL_ROUTER_STATE_DIR;
  const priorState = process.env.CODEX_ROUTER_STATE_DIR;
  const priorKimiState = process.env.KIMI_CODEX_STATE_DIR;
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(path.join(owner, "src", "control.mjs"), "", { mode: 0o700 });
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    await writeFile(
      path.join(state, "install-manifest.json"),
      JSON.stringify({ version: 1, current: { sourceRoot: owner } }),
      { mode: 0o600 },
    );
    delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    delete process.env.MODEL_ROUTER_STATE_DIR;
    process.env.CODEX_ROUTER_STATE_DIR = state;
    delete process.env.KIMI_CODEX_STATE_DIR;
    assert.equal(discoverSourceRoot(), realpathSync(owner));
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    if (priorModelState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
    else process.env.MODEL_ROUTER_STATE_DIR = priorModelState;
    if (priorState === undefined) delete process.env.CODEX_ROUTER_STATE_DIR;
    else process.env.CODEX_ROUTER_STATE_DIR = priorState;
    if (priorKimiState === undefined) delete process.env.KIMI_CODEX_STATE_DIR;
    else process.env.KIMI_CODEX_STATE_DIR = priorKimiState;
    await rm(owner, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("control center refuses mutations across app/control protocol skew", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-contract-"));
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(path.join(owner, "src", "control.mjs"), "", { mode: 0o700 });
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    assert.throws(() => assertMutationCompatibility(owner), /same build/);

    const bundled = JSON.parse(await readFile(new URL("../apps/control-center/package.json", import.meta.url), "utf8"));
    await mkdir(path.join(owner, "apps", "control-center"), { recursive: true });
    await writeFile(
      path.join(owner, "apps", "control-center", "package.json"),
      JSON.stringify({ version: bundled.version, controlProtocol: bundled.controlProtocol }),
      { mode: 0o600 },
    );
    assert.doesNotThrow(() => assertMutationCompatibility(owner));

    await writeFile(
      path.join(owner, "apps", "control-center", "package.json"),
      JSON.stringify({ version: "0.0.0", controlProtocol: bundled.controlProtocol }),
      { mode: 0o600 },
    );
    assert.throws(() => assertMutationCompatibility(owner), /same build/);
  } finally {
    await rm(owner, { recursive: true, force: true });
  }
});

test("trusted install provenance overrides contradictory package-manager environment", async () => {
  const owner = await mkdtemp(path.join(os.tmpdir(), "router-control-owner-"));
  const state = await mkdtemp(path.join(os.tmpdir(), "router-control-state-"));
  const environmentKeys = [
    "CODEX_ROUTER_SOURCE_ROOT",
    "MODEL_ROUTER_SOURCE_ROOT",
    "MODEL_ROUTER_STATE_DIR",
    "CODEX_ROUTER_STATE_DIR",
    "KIMI_CODEX_STATE_DIR",
    "CODEX_ROUTER_PACKAGE_MANAGER",
  ];
  const prior = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const writeManifest = (packageManager) => writeFile(
    path.join(state, "install-manifest.json"),
    JSON.stringify({ version: 1, current: { sourceRoot: owner, packageManager } }),
    { mode: 0o600 },
  );
  try {
    await mkdir(path.join(owner, "src"), { recursive: true });
    await mkdir(path.join(owner, "bin"), { recursive: true });
    await writeFile(
      path.join(owner, "src", "control.mjs"),
      "process.stdout.write(JSON.stringify({ packageManager: process.env.CODEX_ROUTER_PACKAGE_MANAGER ?? null }));\n",
      { mode: 0o700 },
    );
    await writeFile(path.join(owner, "bin", "control"), "#!/bin/sh\n", { mode: 0o700 });
    process.env.CODEX_ROUTER_SOURCE_ROOT = owner;
    delete process.env.MODEL_ROUTER_SOURCE_ROOT;
    process.env.MODEL_ROUTER_STATE_DIR = state;
    delete process.env.CODEX_ROUTER_STATE_DIR;
    delete process.env.KIMI_CODEX_STATE_DIR;
    process.env.CODEX_ROUTER_PACKAGE_MANAGER = "contradictory";

    await writeManifest("homebrew");
    assert.equal((await runControlJson()).packageManager, "homebrew");
    await writeManifest(null);
    assert.equal((await runControlJson()).packageManager, null);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(owner, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("electron boundary does not enable node integration or shell argv", async () => {
  const preload = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("routerControl"/);
  assert.match(preload, /require\("electron"\)/);
  assert.doesNotMatch(preload, /executeJavaScript|node:child_process|node:fs|node:path/);
  const main = await readFile(new URL("../apps/control-center/electron/main.mjs", import.meta.url), "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /frame:\s*process\.platform\s*!==\s*"darwin"/);
  assert.match(main, /titleBarStyle:\s*"hiddenInset"/);
  assert.match(main, /trafficLightPosition:\s*\{\s*x:\s*16,\s*y:\s*16\s*\}/);
  assert.match(main, /icon:\s*appIconPath\(\)/);
  assert.match(main, /app\.dock\?\.setIcon\(appIconPath\(\)\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /if \(app\.isPackaged \|\| !requested\)/);
  assert.match(main, /\["127\.0\.0\.1", "localhost", "\[::1\]"\]\.includes\(parsed\.hostname\)/);
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\("second-instance"/);
  assert.match(main, /mainWindow\.isDestroyed\(\)\) && app\.isReady\(\)\) createWindow\(\)/);
  assert.match(main, /app\.on\("before-quit"/);
  assert.match(main, /mutationLifecycle\.hasActiveMutations\(\)/);
  assert.match(main, /mutationLifecycle\.whenMutationsIdle\(\)/);
  assert.match(main, /script-src 'self' 'sha256-Z2\/iFzh9VMlVkEOar1f\/oSHWwQk3ve1qk\/C2WdsC4Xk='/);
  assert.doesNotMatch(main, /script-src[^;]*'unsafe-inline'/);
  const builder = await readFile(new URL("../apps/control-center/electron-builder.yml", import.meta.url), "utf8");
  assert.match(builder, /extraResources:[\s\S]*icon\.png/);
  assert.match(builder, /runAsNode:\s*true/);
  assert.match(builder, /enableEmbeddedAsarIntegrityValidation:\s*true/);
  assert.match(builder, /onlyLoadAppFromAsar:\s*true/);
  assert.match(builder, /mac:[\s\S]*target:\s*\[dmg, zip\]/);
  assert.match(builder, /linux:[\s\S]*executableName:\s*codex-router-control-center[\s\S]*target:\s*\[AppImage\]/);
  assert.match(builder, /win:[\s\S]*target:\s*\[nsis\]/);
  const compatibilityMain = await readFile(new URL("../apps/control-center/main.mjs", import.meta.url), "utf8");
  assert.match(compatibilityMain, /import "\.\/electron\/main\.mjs"/);
  assert.doesNotMatch(compatibilityMain, /BrowserWindow|ipcMain|registerIpcHandlers/);
  const renderer = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /WindowControls|traffic-lights|window-control/);
  assert.match(renderer, /native-titlebar/);
  const styles = await readFile(new URL("../apps/control-center/src/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(styles, /traffic-lights|window-control|window-close|window-minimize|window-maximize/);
  assert.match(styles, /native-titlebar/);
  assert.match(styles, /native-titlebar\.sidebar-collapsed \.titlebar[\s\S]*padding-left:\s*88px/);
  assert.doesNotMatch(renderer, /drag-region|no-drag/);
  assert.match(styles, /-webkit-app-region:\s*drag/);
  assert.match(styles, /-webkit-app-region:\s*no-drag/);
  for (const label of ["Close window", "Minimize window", "Maximize or restore window"]) {
    assert.doesNotMatch(renderer, new RegExp(`aria-label=\\"${label}\\"`));
  }
  const runner = await readFile(new URL("../apps/control-center/electron/command-runner.mjs", import.meta.url), "utf8");
  assert.match(runner, /shell:\s*false/);
  assert.doesNotMatch(runner, /shell:\s*true/);
  assert.match(runner, /detached:\s*process\.platform !== "win32"/);
  assert.match(runner, /process\.kill\(-child\.pid, "SIGKILL"\)/);
  assert.match(runner, /\["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
});

test("control center package version follows the router beta", async () => {
  const routerPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const appPackage = JSON.parse(await readFile(new URL("../apps/control-center/package.json", import.meta.url), "utf8"));
  const appLock = JSON.parse(await readFile(new URL("../apps/control-center/package-lock.json", import.meta.url), "utf8"));
  assert.equal(appPackage.version, routerPackage.version);
  assert.equal(appPackage.controlProtocol, 1);
  assert.equal(appLock.version, routerPackage.version);
  assert.equal(appLock.packages[""].version, routerPackage.version);
});

test("background usage polling is conservative while manual refresh stays immediate", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /usageTimer = window\.setInterval\(\(\) => void refreshUsage\(\), 5 \* 60_000\)/);
  assert.doesNotMatch(source, /usageTimer = window\.setInterval\(\(\) => void refreshUsage\(\), 30_000\)/);
  assert.match(source, /Promise\.allSettled\(\[refreshCore\(\), refreshUsage\(\)\]\)/);
  assert.match(source, /Promise\.allSettled\(\[[\s\S]*api\.getSnapshot\(\)[\s\S]*api\.getHealth\(\)/);
  assert.match(source, /downloadPollInFlight\.current/);
  assert.match(source, /localDownloadActive \? api\.getLocalModels\(\)/);
  assert.match(source, /visionDownloadActive \? api\.getVisionBridge\(\)/);
  assert.match(source, /downloadTimer = window\.setInterval\(\(\) => void refreshDownloadProgress\(\), 4_000\)/);
  assert.doesNotMatch(source, /downloadTimer = window\.setInterval\([\s\S]{0,160}refreshCore/);
});

test("preload exposes only the named control operations", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  for (const method of [
    "getSnapshot",
    "getHarnesses",
    "getContextSessions",
    "minimizeWindow",
    "toggleMaximizeWindow",
    "closeWindow",
    "setProviderEnabled",
    "connectProvider",
    "saveProviderCredential",
    "controlLocalRuntime",
    "setVisionBridgeEngine",
    "downloadVisionModel",
    "useLocalVisionModel",
    "benchmarkVisionModel",
    "setDefaultModel",
    "launchHarness",
    "installHarness",
    "openHarnessSession",
    "openExternal",
  ]) {
    assert.match(source, new RegExp(`${method}\\s*:`));
  }
  assert.doesNotMatch(source, /runCommand|exec|spawn|argv/);
  assert.doesNotMatch(source, /runMaintenance/);
  assert.doesNotMatch(source, /setLoginFree/);
  assert.doesNotMatch(source, /typeof\s+\w+\s*===\s*"object"/);
});

test("preload constructs exact positional IPC payloads", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/preload.cjs", import.meta.url), "utf8");
  const calls = [];
  let api;
  vm.runInNewContext(source, {
    process: { platform: "linux" },
    require(specifier) {
      assert.equal(specifier, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, "routerControl");
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (channel, input) => { calls.push([channel, input]); },
          on() {},
          removeListener() {},
        },
      };
    },
  });
  const cases = [
    ["setProviderEnabled", ["provider", false], { providerId: "provider", enabled: false }],
    ["connectProvider", ["provider"], { providerId: "provider" }],
    ["saveProviderCredential", ["provider", "credential"], { providerId: "provider", credential: "credential" }],
    ["removeProviderCredential", ["provider"], { providerId: "provider" }],
    ["setSubagentMode", ["proven"], { mode: "proven" }],
    ["setSubagentModel", ["model", true], { slug: "model", enabled: true }],
    ["setSubagentSelection", [false], { selectAll: false }],
    ["setPickerModel", ["model", false], { slug: "model", visible: false }],
    ["setPickerModels", [true], { showAll: true }],
    ["installLocalModel", ["model:latest", true], { tag: "model:latest", force: true, yes: true }],
    ["uninstallLocalModel", ["model:latest"], { tag: "model:latest" }],
    ["setLocalModelEnabled", ["model:latest", false], { tag: "model:latest", enabled: false }],
    ["benchmarkLocalModel", ["model:latest"], { tag: "model:latest" }],
    ["controlLocalRuntime", ["start"], { action: "start" }],
    ["setVisionBridgeEnabled", [true], { enabled: true }],
    ["setVisionBridgeEngine", ["auto", "high"], { engine: "auto", effort: "high" }],
    ["setVisionBridgeEffort", ["high"], { effort: "high" }],
    ["downloadVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["useLocalVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["benchmarkVisionModel", ["vision:latest"], { tag: "vision:latest" }],
    ["setToolResultAging", [true], { enabled: true }],
    ["setNativeToolResultAging", [false], { enabled: false }],
    ["setToolResultRetentionTtl", [7], { days: 7 }],
    ["setDefaultModel", ["model"], { slug: "model" }],
    ["setSignedRouting", [false], { enabled: false }],
    ["setPresence", ["always"], { mode: "always" }],
    ["controlService", ["start"], { action: "start" }],
    ["controlTray", ["status"], { action: "status" }],
    ["launchHarness", ["codex", "app"], { harnessId: "codex", surface: "app" }],
    ["installHarness", ["deepcode"], { harnessId: "deepcode" }],
    ["openHarnessSession", ["codex", "session", "terminal", "model"], { harnessId: "codex", sessionId: "session", surface: "terminal", model: "model" }],
    ["openExternal", ["https://example.com"], { url: "https://example.com" }],
  ];
  for (const [method, args, expected] of cases) {
    await api[method](...args);
    const actual = calls.shift();
    assert.deepEqual(
      JSON.parse(JSON.stringify(actual)),
      [`router-control:${method}`, expected],
      method,
    );
  }
  assert.equal(calls.length, 0);
});

test("control center sidebar keeps the requested product order", async () => {
  const source = await readFile(new URL("../apps/control-center/src/App.tsx", import.meta.url), "utf8");
  const navBlock = source.match(/const NAV_ITEMS:[\s\S]*?= \[([\s\S]*?)\n\];/)?.[1];
  assert.ok(navBlock, "NAV_ITEMS block should be readable");
  const ids = [...navBlock.matchAll(/id: "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["dashboard", "usage", "status", "providers", "models", "local", "harness", "context", "settings"]);
  assert.doesNotMatch(navBlock, /deferred|Soon/);

  const status = await readFile(new URL("../apps/control-center/src/pages/StatusPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(status, /doctor/i);

  const usage = await readFile(new URL("../apps/control-center/src/pages/UsagePage.tsx", import.meta.url), "utf8");
  assert.match(usage, /ChatGPT · measured by this router/);
  assert.match(usage, /ChatGPT account · reported by OpenAI/);
  assert.match(usage, /excludes account usage/);
  assert.match(usage, /This router total is the sum of every measured provider row/);
  assert.match(usage, /Account-reported · excluded from router total/);
  assert.match(usage, /regularInputTokens/);
  assert.match(usage, /cachedInputTokens/);
  assert.match(usage, /outputTokens/);
  assert.match(usage, /All retained/);
  assert.match(usage, /scopeLabel/);
  assert.match(usage, /is-regular/);
  assert.match(usage, /is-cached/);
  assert.match(usage, /is-output/);
  assert.match(usage, /ChartTooltip/);
  assert.match(usage, /aria-label=\{label\}/);
  assert.match(usage, /Regular input|regular input/);
  const usageStyles = await readFile(new URL("../apps/control-center/src/pages/usage-status.css", import.meta.url), "utf8");
  assert.match(usageStyles, /--token-regular/);
  assert.match(usageStyles, /--token-cached/);
  assert.match(usageStyles, /--token-output/);
  assert.match(usageStyles, /\.us-token-mix > div \{[\s\S]*border-right/);
  assert.doesNotMatch(usageStyles, /\.us-token-mix > div \{[^}]*border-radius/);
  assert.match(usageStyles, /\.us-chart-tooltip/);
  assert.match(usageStyles, /white-space: normal|text-transform: capitalize/);
  assert.match(usageStyles, /data-edge="start"|data-edge/);
  const dashboard = await readFile(new URL("../apps/control-center/src/pages/DashboardPage.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /db-trend-stack/);
  assert.match(dashboard, /TrafficTooltip/);
  assert.match(dashboard, /tabIndex=\{0\}/);
  const dashboardStyles = await readFile(new URL("../apps/control-center/src/pages/dashboard.css", import.meta.url), "utf8");
  assert.match(dashboardStyles, /--token-regular/);
  assert.match(dashboardStyles, /--token-cached/);
  assert.match(dashboardStyles, /--token-output/);
  assert.match(dashboardStyles, /\.db-trend-tooltip/);
  assert.match(dashboardStyles, /border-radius: 0/);
});

test("settings keeps model choice out and exposes durable app preferences", async () => {
  const settings = await readFile(new URL("../apps/control-center/src/pages/SettingsPage.tsx", import.meta.url), "utf8");
  // Default model selection belongs to the catalog page. Settings owns the
  // router switches and renderer-local preferences, so it must not grow a
  // second model-choice control as the catalog evolves.
  assert.doesNotMatch(settings, /setDefaultModel|default model/i);
  assert.match(settings, /settings\.language\.title/);
  assert.match(settings, /settings\.context\.enable\.title/);
  assert.match(settings, /settings\.vision\.title/);
  assert.match(settings, /setToolResultAging\(/);
  assert.match(settings, /setNativeToolResultAging\(/);
  assert.match(settings, /setToolResultRetentionTtl\(/);
  assert.match(settings, /setVisionBridgeEnabled\(/);
  assert.match(settings, /setVisionBridgeEngine\(/);
  assert.match(settings, /setVisionBridgeEffort\(/);
  assert.doesNotMatch(settings, /runMaintenance/);
  assert.doesNotMatch(settings, /setLoginFree/);
  assert.match(settings, /bin\/model-router codex doctor --fix/);
  assert.doesNotMatch(settings, /controlService\("(?:stop|restart)"\)/);

  const i18n = await readFile(new URL("../apps/control-center/src/i18n.ts", import.meta.url), "utf8");
  assert.match(i18n, /settings\.language\.title/);
  assert.match(i18n, /settings\.context\.enable\.title/);
  assert.match(i18n, /settings\.vision\.title/);
  assert.doesNotMatch(i18n, /settings\.routing\.modelNote/);
});

test("provider and model directories use accessible single-open accordions", async () => {
  const providers = await readFile(new URL("../apps/control-center/src/pages/ProvidersPage.tsx", import.meta.url), "utf8");
  const models = await readFile(new URL("../apps/control-center/src/pages/ModelsPage.tsx", import.meta.url), "utf8");
  for (const source of [providers, models]) {
    assert.match(source, /aria-expanded=\{expanded\}/);
    assert.match(source, /aria-controls=\{panelId\}/);
    assert.match(source, /hidden=\{!expanded\}/);
  }
  assert.match(providers, /setExpandedProviderId\(expanded \? null : provider\.id\)/);
  assert.match(models, /setExpandedProviderId\(expanded \? null : providerId\)/);

  const branding = await readFile(new URL("../apps/control-center/src/provider-branding.tsx", import.meta.url), "utf8");
  assert.match(branding, /assets\/providers\/commandcode\.svg/);
  assert.match(branding, /commandcode:[^\n]+logoMode: "artwork"/);
  const sources = await readFile(new URL("../apps/control-center/src/assets/providers/SOURCES.md", import.meta.url), "utf8");
  assert.match(sources, /commandcode\.ai\/brand/);
  assert.match(sources, /CommandCodeAI\/command-code[^\s|]+\/symbol\.svg/);
});

test("harness and context IPC remain fixed and session-scoped", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const HARNESS_IDS = \["codex", "deepcode"\]/);
  assert.match(source, /const HARNESS_SURFACES = \["app", "terminal"\]/);
  assert.match(source, /const SESSION_UUID = \/\^\[0-9a-f\]/);
  assert.match(source, /const DEEPCODE_PACKAGE = "@vegamo\/deepcode-cli"/);
  assert.match(source, /oneOf\(harnessId, HARNESS_IDS, "Harness"\)/);
  assert.match(source, /stringValue\(sessionId, "Session", SESSION_UUID\)/);
  assert.match(source, /codex:\/\/threads\/\$\{id\}/);
  assert.doesNotMatch(source, /readFileSync\(deepcodeSettings/);
});

test("credential input stays off argv and is delivered over stdin", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "router-control-center-"));
  const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
  const secret = "test-only-secret-value";
  try {
    await mkdir(path.join(temporaryRoot, "src"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "bin"), { recursive: true });
    await writeFile(
      path.join(temporaryRoot, "src", "control.mjs"),
      "let input = ''; for await (const chunk of process.stdin) input += chunk; process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));\n",
      { mode: 0o700 },
    );
    await writeFile(path.join(temporaryRoot, "bin", "control"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(path.join(temporaryRoot, "bin", "control"), 0o700);
    process.env.CODEX_ROUTER_SOURCE_ROOT = temporaryRoot;
    const result = await runControlJson(["credential", "demo"], { stdin: secret });
    assert.deepEqual(result.argv, ["credential", "demo"]);
    assert.equal(result.input, secret);
    assert.equal(result.argv.includes(secret), false);
  } finally {
    if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
    else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("provider writes republish all installed targets and roll selection back on apply failure", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /updateProviderSelection\(id, enabled/);
  const toggle = source.match(/async function updateProviderSelection[\s\S]*?\n}/)?.[0];
  assert.ok(toggle, "provider toggle helper should be readable");
  assert.match(toggle, /\["set-apply", id, enabled \? "on" : "off", "--targets", TARGET\]/);
  assert.match(toggle, /CATALOG_MUTATION_TIMEOUT_MS/);
  assert.doesNotMatch(toggle, /\["set"|\["apply"|before\.has/);
  assert.match(source, /runJson\(\["credential", id\], \{[\s\S]{0,80}stdin: credential/);
  const save = source.match(/handleAction\("saveProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(save, "credential-save handler should be readable");
  assert.doesNotMatch(save, /updateProviderSelection/);
  assert.match(save, /CATALOG_MUTATION_TIMEOUT_MS/);
  const removal = source.match(/handleAction\("removeProviderCredential"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(removal, "credential-removal handler should be readable");
  assert.doesNotMatch(removal, /updateProviderSelection/);
  assert.match(removal, /\["credential", id, "--remove"\]/);
  assert.match(removal, /CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /if \(requiresCompatibleRouter\) assertMutationCompatibility\(\)/);
  assert.doesNotMatch(source, /apply\s*=/);
  assert.doesNotMatch(source, /handleAction\("setLoginFree"/);
});

test("catalog-backed mutations outlive the publication-lock wait", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const CATALOG_MUTATION_TIMEOUT_MS = 330_000/);
  assert.match(source, /\["set-apply"[\s\S]{0,180}timeoutMs: CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSubagentMode"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setPickerModel"[\s\S]{0,320}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setVisionBridgeEnabled"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
  assert.match(source, /handleAction\("setSignedRouting"[\s\S]{0,280}CATALOG_MUTATION_TIMEOUT_MS/);
});

test("service IPC exposes only safe beta actions and start covers readiness", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /const SERVICE_COMMANDS = \["status", "start"\]/);
  assert.match(source, /value === "start" \? 330_000 : 120_000/);
  assert.match(source, /runControl\(\["service", value\], \{ timeoutMs \}\)/);
  const api = await readFile(new URL("../apps/control-center/electron/api.d.ts", import.meta.url), "utf8");
  assert.match(api, /type ServiceAction = "status" \| "start"/);
  assert.doesNotMatch(api, /type ServiceAction =[^;]*(?:stop|restart)/);
});

test("local model mutations cover service readiness and validate consent flags", async () => {
  const source = await readFile(new URL("../apps/control-center/electron/ipc.mjs", import.meta.url), "utf8");
  assert.match(source, /typeof yes !== "boolean"/);
  assert.match(source, /typeof force !== "boolean"/);
  assert.match(source, /local-models", "install"[\s\S]{0,260}timeoutMs: 330_000/);
  assert.match(source, /local-models", "uninstall"[\s\S]{0,180}timeoutMs: 330_000/);
  assert.match(source, /local-models", "set"[\s\S]{0,240}timeoutMs: 330_000/);
});

for (const mode of ["timeout", "overflow"]) {
  test(`command ${mode} terminates its full descendant process tree`, async () => {
    const root = await makeProcessTreeControlRoot();
    const pidFile = path.join(root, `${mode}.pid`);
    const heartbeatFile = path.join(root, `${mode}.heartbeat`);
    const priorRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
    let descendantPid;
    try {
      process.env.CODEX_ROUTER_SOURCE_ROOT = root;
      const command = runControl(
        [pidFile, mode, heartbeatFile],
        mode === "timeout" ? { timeoutMs: 250 } : { timeoutMs: 5_000, maxOutputBytes: 32 },
      );
      await assert.rejects(command, mode === "timeout" ? /timed out/ : /output exceeded/);
      descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      await waitForProcessExit(descendantPid, heartbeatFile);
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (priorRoot === undefined) delete process.env.CODEX_ROUTER_SOURCE_ROOT;
      else process.env.CODEX_ROUTER_SOURCE_ROOT = priorRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
}
