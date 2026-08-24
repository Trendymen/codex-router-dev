import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  dependencyRepairHint,
  isHomebrewManaged,
} from "../src/dependency-repair.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function homebrewDoctorEnv(testRoot) {
  return {
    ...process.env,
    CODEX_HOME: path.join(testRoot, "codex-home"),
    CODEX_ROUTER_PACKAGE_MANAGER: "homebrew",
    CODEX_ROUTER_SOURCE_ROOT: testRoot,
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
  };
}

function linkRegistry(testRoot) {
  symlinkSync(path.join(root, "config"), path.join(testRoot, "config"), "dir");
}

test("Homebrew repair stays with the package manager", () => {
  assert.equal(isHomebrewManaged("homebrew"), true);
  assert.match(
    dependencyRepairHint({ packageManager: "homebrew", platform: "darwin" }),
    /^Run `brew reinstall codex-router`/,
  );
});

test("checkout repair names the platform-native force path", () => {
  assert.equal(isHomebrewManaged(undefined), false);
  assert.match(
    dependencyRepairHint({ packageManager: undefined, platform: "linux" }),
    /\.\/bin\/doctor --fix.*\.\/bin\/install --force-deps/,
  );
  assert.match(
    dependencyRepairHint({ packageManager: undefined, platform: "win32" }),
    /codex-router\.ps1 doctor --fix.*install\.ps1 -CheckoutInstall -ForceDeps/,
  );
});

test(
  "Homebrew doctor invokes the Node installer without force-deps when node_modules is absent",
  { skip: process.platform !== "darwin" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-homebrew-doctor-healthy-"));
    const binDir = path.join(testRoot, "bin");
    const installLog = path.join(testRoot, "install-args.log");
    mkdirSync(binDir, { recursive: true });
    try {
      linkRegistry(testRoot);
      writeFileSync(
        path.join(binDir, "install"),
        '#!/bin/sh\nprintf "%s\\n" "$*" > "$CODEX_ROUTER_TEST_INSTALL_ARGS"\nexit 23\n',
      );
      chmodSync(path.join(binDir, "install"), 0o755);

      const result = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--fix"], {
        encoding: "utf8",
        env: { ...homebrewDoctorEnv(testRoot), CODEX_ROUTER_TEST_INSTALL_ARGS: installLog },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Repair installer exited with 23/);
      assert.equal(existsSync(path.join(testRoot, "node_modules")), false);
      assert.equal(readFileSync(installLog, "utf8").trim(), "");
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
