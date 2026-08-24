import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(root, "scripts", "verify-task-scope.mjs");

test("范围校验将工作区和 index 的改动集合与精确允许清单比较", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "acceptance-scope-"));
  try {
    for (const args of [["init"], ["config", "user.email", "acceptance@example.test"], ["config", "user.name", "Acceptance"]]) assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
    writeFileSync(path.join(repo, "allowed.txt"), "base\n");
    assert.equal(spawnSync("git", ["add", "allowed.txt"], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "base"], { cwd: repo }).status, 0);
    writeFileSync(path.join(repo, "allowed.txt"), "changed\n");
    writeFileSync(path.join(repo, "extra.txt"), "extra\n");
    const allow = path.join(repo, "allowlist.txt");
    writeFileSync(allow, "allowed.txt\nmissing.txt\n");
    const failed = spawnSync(process.execPath, [tool, "worktree", "--allow-file", allow], { cwd: repo, encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout + failed.stderr, /extra\.txt/);
    assert.match(failed.stdout + failed.stderr, /missing\.txt/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

function createRepository() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "acceptance-scope-baseline-"));
  for (const args of [["init"], ["config", "user.email", "acceptance@example.test"], ["config", "user.name", "Acceptance"]]) assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
  writeFileSync(path.join(repo, "tracked.txt"), "tracked\n");
  assert.equal(spawnSync("git", ["add", "tracked.txt"], { cwd: repo }).status, 0);
  assert.equal(spawnSync("git", ["commit", "-m", "base"], { cwd: repo }).status, 0);
  return repo;
}

test("HEAD 已跟踪的 normative 删除必须在 index 中显示 staged deletion", () => {
  const repo = createRepository();
  const allowDir = mkdtempSync(path.join(os.tmpdir(), "acceptance-scope-allow-"));
  try {
    const allow = path.join(allowDir, "allowlist.txt");
    const retired = path.join(repo, "test", "acceptance", "normative-requirements.json");
    mkdirSync(path.dirname(retired), { recursive: true });
    writeFileSync(retired, "obsolete\n");
    assert.equal(spawnSync("git", ["add", "."], { cwd: repo }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "track retired manifest"], { cwd: repo }).status, 0);
    writeFileSync(allow, "test/acceptance/normative-requirements.json\n");
    assert.equal(spawnSync("git", ["rm", "test/acceptance/normative-requirements.json"], { cwd: repo }).status, 0);
    const result = spawnSync(process.execPath, [tool, "index", "--allow-file", allow], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(allowDir, { recursive: true, force: true }); }
});

test("HEAD 从未跟踪且仍缺失的 normative 删除满足范围，但重新出现会失败", () => {
  const repo = createRepository();
  const allowDir = mkdtempSync(path.join(os.tmpdir(), "acceptance-scope-allow-"));
  try {
    const allow = path.join(allowDir, "allowlist.txt");
    writeFileSync(allow, "test/acceptance/normative-requirements.json\n");
    const absent = spawnSync(process.execPath, [tool, "worktree", "--allow-file", allow], { cwd: repo, encoding: "utf8" });
    assert.equal(absent.status, 0, absent.stderr);
    assert.doesNotMatch(absent.stderr, /fatal:/i);
    mkdirSync(path.join(repo, "test", "acceptance"), { recursive: true });
    writeFileSync(path.join(repo, "test", "acceptance", "normative-requirements.json"), "should stay absent\n");
    const returned = spawnSync(process.execPath, [tool, "worktree", "--allow-file", allow], { cwd: repo, encoding: "utf8" });
    assert.notEqual(returned.status, 0);
    assert.match(returned.stdout + returned.stderr, /reappeared|normative-requirements\.json/);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(allowDir, { recursive: true, force: true }); }
});
