import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Electron credential.set crosses the trusted main bridge as protected input only", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "electron-credential-bridge-"));
  const fakeRoot = path.join(scratch, "source");
  const fakeControl = path.join(fakeRoot, "src", "control.mjs");
  const secret = "electron-bridge-decoy-8ac37f2b";
  mkdirSync(path.dirname(fakeControl), { recursive: true });
  writeFileSync(fakeControl, [
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    "process.stdout.write(JSON.stringify({",
    "  receivedProtectedInput: input === process.env.ELECTRON_BRIDGE_EXPECTED_SECRET,",
    "  argv: process.argv.slice(2),",
    "  snapshot: { configured: true },",
    "}));",
  ].join("\n"));

  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  const originalLoad = Module._load;
  const previousRoot = process.env.MODEL_ROUTER_SOURCE_ROOT;
  const previousSecret = process.env.ELECTRON_BRIDGE_EXPECTED_SECRET;
  process.env.MODEL_ROUTER_SOURCE_ROOT = fakeRoot;
  process.env.ELECTRON_BRIDGE_EXPECTED_SECRET = secret;
  Module._load = function loadElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { isPackaged: false },
        BrowserWindow: class {},
        Menu: {},
        Tray: class {},
        ipcMain: {},
        nativeImage: {},
        screen: {},
        shell: {},
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const mainPath = path.join(repoRoot, "apps", "electron", "main.js");
    delete require.cache[require.resolve(mainPath)];
    const { handleInvoke } = require(mainPath);
    const result = await handleInvoke("credential.set", {
      provider: "deepseek",
      apiKey: secret,
      unexpected: "must-not-cross",
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      receivedProtectedInput: true,
      argv: ["credential", "deepseek"],
      snapshot: { configured: true },
    });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(readFileSync(fakeControl, "utf8"), new RegExp(secret));
  } finally {
    Module._load = originalLoad;
    if (previousRoot === undefined) delete process.env.MODEL_ROUTER_SOURCE_ROOT;
    else process.env.MODEL_ROUTER_SOURCE_ROOT = previousRoot;
    if (previousSecret === undefined) delete process.env.ELECTRON_BRIDGE_EXPECTED_SECRET;
    else process.env.ELECTRON_BRIDGE_EXPECTED_SECRET = previousSecret;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the renderer sends apiKey only to Electron IPC and main strips it before canonical dispatch", () => {
  const app = readFileSync(path.join(repoRoot, "apps", "desktop", "ui", "app.js"), "utf8");
  const main = readFileSync(path.join(repoRoot, "apps", "electron", "main.js"), "utf8");
  assert.match(app, /call\("credential\.set", \{ provider, apiKey \}\)/);
  assert.match(main, /Object\.getOwnPropertyDescriptor\(commandArgs, "apiKey"\)/);
  assert.match(main, /commandArgs = \{ provider: commandArgs\?\.provider \}/);
  assert.match(main, /protectedInput = typeof secret === "string" \? async \(\) => secret/);
  assert.match(main, /runDesktopCommand\(command, commandArgs, context\)/);
});
