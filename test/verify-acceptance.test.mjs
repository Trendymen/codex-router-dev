import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(root, "scripts", "verify-acceptance.mjs");
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

function run(args) { return spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: "utf8" }); }

test("package scripts 固定指向五份 Task1 验收契约与 acceptance build-root", () => {
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts["test:acceptance-contract"], "node --test test/acceptance-matrix.test.mjs test/acceptance-oracles.test.mjs test/prepare-acceptance-build.test.mjs test/verify-acceptance.test.mjs test/verify-task-scope.test.mjs");
  assert.equal(scripts["audit:node-only-build"], "node scripts/verify-node-only-build.mjs generated/acceptance/task1-build/build-root");
});

test("run 原子记录主题证据，保留命令退出状态且脱敏输出", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-evidence-"));
  try {
    const evidence = path.join(temp, "evidence.json");
    const artifact = path.join(temp, "command.log");
    const result = run(["run", "--profile", "task1-node-test", "--evidence", evidence, "--artifact", artifact, "--source-commit", commit, "--", process.execPath, "-e", "console.log('Bearer secret-value'); process.exit(7)"]);
    assert.equal(result.status, 7, result.stderr);
    assert.doesNotMatch(readFileSync(artifact, "utf8"), /secret-value/);
    const document = JSON.parse(readFileSync(evidence, "utf8"));
    assert.ok(document.entries.length > 1);
    for (const entry of document.entries) assert.deepEqual(Object.keys(entry).sort(), ["artifact", "generationId", "kind", "profile", "provider", "reason", "recordedAt", "requirementId", "sourceCommit", "state", "themeId"]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("run artifact 保留统一 redactor 的安全诊断，同时排除 Appendix I decoy", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-redacted-log-"));
  try {
    const artifact = path.join(temp, "command.log");
    const decoy = "Bearer private-token prompt=private-prompt";
    const result = run(["run", "--profile", "task1-node-test", "--evidence", path.join(temp, "evidence.json"), "--artifact", artifact, "--source-commit", commit, "--", process.execPath, "-e", `console.log("TAP version 13\\n# pass 1\\n${decoy}")`]);
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(artifact, "utf8");
    assert.match(output, /TAP version 13/);
    assert.match(output, /# pass 1/);
    assert.doesNotMatch(output, /private-token|private-prompt/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("final 只接受当前 generation 的 complete evidence 和允许的 NOT RUN", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-final-"));
  try {
    const evidence = path.join(temp, "evidence.json");
    assert.equal(run(["begin-final", "--evidence", evidence, "--source-commit", commit]).status, 0);
    const rejected = run(["verify", "--final", "--evidence", evidence, "--source-commit", commit]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout + rejected.stderr, /missing|pending/i);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("final CLI 以 requirementId/profile/provider/generationId 一对一绑定证据，并从统一脱敏器移除 Appendix I decoy", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-identity-"));
  try {
    const evidence = path.join(temp, "evidence.json");
    const matrix = JSON.parse(readFileSync(path.join(root, "test", "acceptance", "acceptance-matrix.json"), "utf8"));
    assert.equal(run(["begin-final", "--evidence", evidence, "--source-commit", commit]).status, 0);
    const generation = JSON.parse(readFileSync(evidence, "utf8")).finalGeneration;
    const entries = matrix.flatMap((theme) => theme.requiredEvidence.map((required) => ({
      themeId: theme.id,
      kind: required.kind,
      requirementId: required.requirementId,
      profile: required.profile,
      provider: required.provider,
      generationId: generation.generationId,
      recordedAt: new Date(Date.parse(generation.startedAt) + 1).toISOString(),
      state: required.kind === "live" ? "not_run" : "passed",
      reason: required.provider === "deepseek" ? "quota_approval_absent" : required.kind === "live" ? "out_of_current_provider_scope" : "completed",
      artifact: path.join(temp, "safe.log"),
      sourceCommit: commit,
    })));
    writeFileSync(evidence, `${JSON.stringify({ schemaVersion: 1, finalGeneration: generation, entries }, null, 2)}\n`);
    const accepted = run(["--matrix", path.join(root, "test", "acceptance", "acceptance-matrix.json"), "--evidence", evidence, "--source-commit", commit, "--final"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    entries[0].generationId = "stale-generation";
    writeFileSync(evidence, `${JSON.stringify({ schemaVersion: 1, finalGeneration: generation, entries }, null, 2)}\n`);
    assert.notEqual(run(["--matrix", path.join(root, "test", "acceptance", "acceptance-matrix.json"), "--evidence", evidence, "--source-commit", commit, "--final"]).status, 0);
    const artifact = path.join(temp, "appendix-i.log");
    const decoys = "Basic basic-decoy Bearer bearer-decoy X-API-Key: x-api-key-decoy http://user:pass@127.0.0.1:4202/_codex-router/capability-decoy/v1?token=query-decoy prompt=prompt-decoy reasoning=reasoning-decoy tool_args=tool-args-decoy response_body=response-body-decoy";
    assert.equal(run(["run", "--profile", "task1-node-test", "--evidence", path.join(temp, "log-evidence.json"), "--artifact", artifact, "--source-commit", commit, "--", process.execPath, "-e", `console.log(${JSON.stringify(decoys)})`]).status, 0);
    for (const decoy of ["basic-decoy", "bearer-decoy", "x-api-key-decoy", "capability-decoy", "query-decoy", "user:pass", "prompt-decoy", "reasoning-decoy", "tool-args-decoy", "response-body-decoy"]) assert.doesNotMatch(readFileSync(artifact, "utf8"), new RegExp(decoy));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
