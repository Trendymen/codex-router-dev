import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isUnsupportedPlatformError,
  requireMacOS,
  runMacOSMutation,
} from "../src/platform-gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("macOS is accepted and every other platform gets the public refusal", () => {
  assert.equal(requireMacOS("unit fixture", "darwin"), undefined);
  for (const platform of ["win32", "linux", "freebsd"]) {
    assert.throws(
      () => requireMacOS("unit fixture", platform),
      (error) => {
        assert.equal(error.code, "unsupported_platform");
        assert.equal(error.exitCode, 2);
        assert.equal(error.body.error.code, "unsupported_platform");
        assert.equal(error.privateDetails.operation, "unit fixture");
        return isUnsupportedPlatformError(error);
      },
    );
  }
});

test("the injected production mutation boundary refuses before its callback", () => {
  const calls = [];
  assert.throws(
    () => runMacOSMutation(
      "injected fixture",
      () => calls.push("mutation"),
      { platform: "win32" },
    ),
    (error) => error.code === "unsupported_platform" && error.exitCode === 2,
  );
  assert.deepEqual(calls, []);
});

function runNode(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, "src", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: path.join(env.TEST_ROOT || os.tmpdir(), "codex-home"),
      MODEL_ROUTER_STATE_DIR: path.join(env.TEST_ROOT || os.tmpdir(), "router-state"),
      ...env,
    },
  });
}

test("the service boundary refuses before spawning a platform supervisor", { skip: process.platform === "darwin" }, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "platform-gate-service-"));
  try {
    const result = runNode("service.mjs", ["status"], { TEST_ROOT: testRoot });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unsupported_platform/);
    assert.equal(existsSync(path.join(testRoot, "codex-home")), false);
    assert.equal(existsSync(path.join(testRoot, "router-state")), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("update, repair, setup, panel, and tray refuse before their first mutation", { skip: process.platform === "darwin" }, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "platform-gate-public-"));
  try {
    const cases = [
      ["update.mjs", ["update"]],
      ["doctor.mjs", ["--fix"]],
      ["setup.mjs", ["--selection-only", "--no-provider"]],
      ["panel.mjs", ["--print"]],
      ["tray-service.mjs", ["install"]],
    ];
    for (const [script, args] of cases) {
      const result = runNode(script, args, { TEST_ROOT: testRoot });
      assert.equal(result.status, 2, `${script} should reject on ${process.platform}`);
      assert.match(result.stderr, /unsupported_platform/, `${script} did not expose its public code`);
    }
    assert.equal(existsSync(path.join(testRoot, "codex-home")), false);
    assert.equal(existsSync(path.join(testRoot, "router-state")), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

function writeFakeGit(directory, trace) {
  if (process.platform === "win32") {
    const command = path.join(directory, "git.cmd");
    writeFileSync(command, [
      "@echo off",
      ">>\"%FAKE_GIT_TRACE%\" echo %*",
      "if \"%2\"==\"remote\" echo https://github.com/duolahypercho/codex-router.git",
      "if \"%2\"==\"rev-parse\" echo fake-revision",
      "exit /b 0",
    ].join("\r\n"));
    return command;
  }
  const command = path.join(directory, "git");
  writeFileSync(command, "#!/bin/sh\nprintf '%s\\n' \"$*\" >>\"$FAKE_GIT_TRACE\"\ncase \"$2\" in\n  remote) printf '%s\\n' https://github.com/duolahypercho/codex-router.git ;;\n  rev-parse) printf '%s\\n' fake-revision ;;\nesac\n");
  chmodSync(command, 0o700);
  return command;
}

test("update check refuses before fetch on non-macOS", { skip: process.platform === "darwin" }, () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "platform-gate-update-check-"));
  const trace = path.join(fixture, "git.trace");
  mkdirSync(path.join(fixture, ".git"));
  const fakeBin = path.join(fixture, "bin");
  mkdirSync(fakeBin);
  writeFakeGit(fakeBin, trace);
  try {
    const result = spawnSync(process.execPath, [path.join(root, "src", "update.mjs"), "check"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_ROUTER_SOURCE_ROOT: fixture,
        FAKE_GIT_TRACE: trace,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /unsupported_platform/);
    assert.equal(existsSync(trace), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("public POSIX wrappers use a trusted uname and gate before checkout inspection", { skip: process.platform === "darwin" }, () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "platform-gate-wrapper-"));
  const fakeBin = path.join(fixture, "bin");
  mkdirSync(fakeBin);
  writeFileSync(path.join(fakeBin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n");
  chmodSync(path.join(fakeBin, "uname"), 0o700);
  try {
    for (const script of ["bin/control", "bin/support-bundle"]) {
      const result = spawnSync("sh", [path.join(root, script)], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          CODEX_HOME: path.join(fixture, "codex"),
          MODEL_ROUTER_STATE_DIR: path.join(fixture, "state"),
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
        },
      });
      assert.equal(result.status, 2, script);
      assert.match(result.stderr, /unsupported_platform/, script);
    }
    const traySource = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
    assert.ok(traySource.indexOf("/usr/bin/uname") < traySource.indexOf("repo_dir="));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("production Tray scripts ignore fake tool overrides and build-only flags", { skip: process.platform === "darwin" }, () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "platform-gate-tray-production-"));
  const fakeDir = path.join(fixture, "fake-tools");
  const trace = path.join(fixture, "fake-tools.trace");
  mkdirSync(fakeDir);
  const fake = (name) => {
    const file = path.join(fakeDir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$0" >>"$FAKE_TRAY_TRACE"\nprintf 'Darwin\\n'\n`);
    chmodSync(file, 0o700);
    return file;
  };
  try {
    const env = {
      ...process.env,
      FAKE_TRAY_TRACE: trace,
      MODEL_ROUTER_SERVICE_MODE: "acceptance",
      MODEL_ROUTER_TRAY_BUILD_ONLY: "1",
      MODEL_ROUTER_UNAME_BIN: fake("uname"),
      MODEL_ROUTER_SWIFT_BIN: fake("swift"),
      MODEL_ROUTER_CODESIGN_BIN: fake("codesign"),
      MODEL_ROUTER_PLISTBUDDY_BIN: fake("PlistBuddy"),
      MODEL_ROUTER_ISOLATION_ROOT: path.join(fixture, "isolation"),
    };
    for (const script of ["bin/model-router-tray", "scripts/build-macos-tray-app.sh"]) {
      const result = spawnSync("sh", [path.join(root, script)], {
        cwd: root,
        encoding: "utf8",
        env,
      });
      assert.equal(result.status, 2, `${script}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /unsupported_platform/);
      const fakeContext = path.join(fixture, "forged-context.json");
      writeFileSync(fakeContext, JSON.stringify({ mode: "acceptance", buildOnly: true }));
      const fixtureResult = spawnSync(
        "sh",
        script === "bin/model-router-tray"
          ? [path.join(root, script), "--fixture-context", fakeContext]
          : [
              path.join(root, script),
              path.join(fixture, "isolation", "forged.app"),
              "--fixture-context",
              fakeContext,
            ],
        { cwd: root, encoding: "utf8", env },
      );
      assert.equal(fixtureResult.status, 2, `${script} fixture: ${fixtureResult.stdout}\n${fixtureResult.stderr}`);
      assert.match(fixtureResult.stderr, /unsupported_platform/);
    }
    assert.equal(existsSync(trace), false);
    assert.equal(existsSync(path.join(fixture, "isolation")), false);
    const traySource = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
    const builderSource = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
    for (const source of [traySource, builderSource]) {
      assert.doesNotMatch(source, /\$\{MODEL_ROUTER_(?:UNAME_BIN|SWIFT_BIN|CODESIGN_BIN|PLISTBUDDY_BIN)/);
      assert.doesNotMatch(source, /\$\{MODEL_ROUTER_TRAY_BUILD_ONLY/);
    }
    assert.match(traySource, /uname_bin=\/usr\/bin\/uname/);
    assert.match(builderSource, /uname_bin=\/usr\/bin\/uname/);
    assert.match(builderSource, /codesign_bin=\/usr\/bin\/codesign/);
    assert.match(builderSource, /plistbuddy_bin=\/usr\/libexec\/PlistBuddy/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the macOS plist renderer remains a read-only cross-platform fixture surface", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "platform-gate-render-"));
  try {
    const result = runNode("service-macos.mjs", ["render"], {
      TEST_ROOT: testRoot,
      CODEX_ROUTER_SERVICE_PLATFORM: "win32",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /<key>Label<\/key>/);
    assert.equal(existsSync(path.join(testRoot, "codex-home")), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the POSIX bootstrap refuses before clone or mkdir on non-macOS", { skip: process.platform === "darwin" }, () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "platform-gate-posix-"));
  try {
    const result = spawnSync("sh", [path.join(root, "install.sh"), "--prepare-only"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(testRoot, "home"),
        XDG_DATA_HOME: path.join(testRoot, "data"),
        CODEX_ROUTER_REPOSITORY_URL: "https://invalid.example/router.git",
      },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported_platform/);
    assert.equal(existsSync(path.join(testRoot, "home")), false);
    assert.equal(existsSync(path.join(testRoot, "data")), false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the PowerShell bootstrap is a deterministic non-macOS refusal", { skip: process.platform !== "win32" }, () => {
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "install.ps1"),
    "-CheckoutInstall",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported_platform/);
});
