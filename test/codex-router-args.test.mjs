import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "codex-router.ps1");

// The PowerShell entry point is retained as a deterministic refusal wrapper:
// this product is macOS-only, so Windows cannot reach command argument parsing.
const skip =
  process.platform === "win32" ? false : "the PowerShell entry point runs on Windows only";

function runCli(...cliArgs) {
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...cliArgs],
    { encoding: "utf8", cwd: root },
  );
}

// PowerShell enumerates a statement's output into an assignment, so
// `$Arguments = if (...) { @(...) }` collapsed a one-element array to the
// element itself. $Arguments[0] then indexed a String and returned its first
// character, so every single-argument subcommand died on a one-letter action:
// tray status/start/stop/restart/uninstall were all unreachable.
test("the Windows entry point refuses before parsing a subcommand", { skip }, () => {
  const result = runCli("tray", "frobnicate");
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 2);
  assert.match(output, /unsupported_platform/);
});

// Deliberately invalid actions: the validator echoes what it received, which
// is the whole assertion, and nothing runs. Testing the real verbs here would
// mean stopping and unregistering the companion of whoever ran the suite.
test("unsupported Windows commands never reach mutation dispatch", { skip }, () => {
  for (const action of ["st", "status-typo", "uninstall-typo"]) {
    const result = runCli("companion", action);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 2);
    assert.match(output, /unsupported_platform/);
  }
});

test("panel invocation also refuses before child dispatch", { skip }, () => {
  const result = runCli("panel", "--help");
  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /unsupported_platform/);
});
