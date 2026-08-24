import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAcceptanceOracle } from "../scripts/verify-node-only-build.mjs";
import { beginFinalEvidence, loadMatrix, verifyAcceptance } from "../scripts/verify-acceptance.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const expectedRows = Object.freeze({
  "reasoning.json": ["identity-state", "stream-final", "abort-nonstream", "errors"],
  "tool-glm.json": ["tool-names-conversion", "forced-tool-boundaries", "glm-messages-continuation"],
  "retry-failover.json": ["retry", "failover"],
  "ownership-catalog.json": ["ownership-writes", "catalog-lifecycle-atomicity"],
  "upgrade-platform.json": ["upgrade-preservation", "platform-removal"],
  "vision-allow.json": ["vision-allow"],
  "public-error.json": ["public-errors", "redaction-leaks"],
  "browser-security.json": ["write-sessions", "browser-security"],
  "testing-success.json": ["testing-unit", "testing-node-build", "testing-swift-build", "testing-runtime", "testing-live-provider", "success-node-router", "success-desktop-app", "success-browser-panel", "success-catalog", "success-upgrade", "success-platform", "success-vision", "success-public-errors", "success-testing-evidence"],
});

test("每个专项 oracle 的独立精确 row set 均被检查入库", () => {
  for (const [name, ids] of Object.entries(expectedRows)) {
    const oracle = loadAcceptanceOracle(path.join(root, "test", "acceptance", "oracles", name));
    assert.deepEqual(oracle.rows.map(({ id }) => id), ids, name);
  }
});

test("每个专项 oracle row 都携带可由消费者执行的独立行为契约", () => {
  for (const name of Object.keys(expectedRows)) {
    const oracle = loadAcceptanceOracle(path.join(root, "test", "acceptance", "oracles", name));
    for (const row of oracle.rows) {
      assert.equal(typeof row.contract, "object", `${name}:${row.id} contract`);
      assert.ok(row.contract && !Array.isArray(row.contract), `${name}:${row.id} contract object`);
      assert.ok(Object.hasOwn(row.contract, "fixture") || Object.hasOwn(row.contract, "input"), `${name}:${row.id} input or fixture`);
      assert.ok(Object.hasOwn(row.contract, "expected") || Object.hasOwn(row.contract, "boundary") || Object.hasOwn(row.contract, "error"), `${name}:${row.id} expected outcome`);
    }
  }
});

function dispatchTestingSuccessOracle(rows, { matrix = loadMatrix(), evidence, sourceCommit = "a".repeat(40) } = {}) {
  if (!evidence) throw new Error("testing-success consumer requires evidence path");
  beginFinalEvidence({ evidence, sourceCommit });
  for (const row of rows) {
    assert.equal(row.contract.input.themeId, row.id, row.id);
    const theme = matrix.find(({ id }) => id === row.contract.input.themeId);
    assert.ok(theme, `${row.id} theme`);
    if (row.contract.expected.outOfScopeProviders) {
      assert.deepEqual(
        theme.requiredEvidence.filter(({ initialState }) => initialState === "not_run").map(({ provider }) => provider),
        ["qwen-plan"],
        row.id,
      );
      assert.ok(row.contract.expected.outOfScopeProviders.includes("qwen-plan"), row.id);
    }
    const findings = verifyAcceptance({ matrix, evidence, sourceCommit, final: true });
    assert.ok(findings.some((finding) => finding.themeId === row.contract.input.themeId && finding.kind === row.contract.expected.finding), row.id);
  }
}

test("testing-success 的每一行都通过真实 matrix/evidence verifier 消费", () => {
  const oracle = loadAcceptanceOracle(path.join(root, "test", "acceptance", "oracles", "testing-success.json"));
  const matrix = loadMatrix();
  const evidence = path.join(mkdtempSync(path.join(os.tmpdir(), "acceptance-testing-success-")), "evidence.json");
  try {
    dispatchTestingSuccessOracle(oracle.rows, { matrix, evidence });
  } finally { rmSync(path.dirname(evidence), { recursive: true, force: true }); }
});

test("变异 testing-success oracle 后，同一真实 verifier consumer 必须失败", () => {
  const oracle = loadAcceptanceOracle(path.join(root, "test", "acceptance", "oracles", "testing-success.json"));
  const tampered = structuredClone(oracle.rows);
  tampered.find((row) => row.id === "testing-live-provider").contract.expected.finding = "pending";
  const evidence = path.join(mkdtempSync(path.join(os.tmpdir(), "acceptance-testing-success-mutated-")), "evidence.json");
  try { assert.throws(() => dispatchTestingSuccessOracle(tampered, { evidence }), /testing-live-provider/); }
  finally { rmSync(path.dirname(evidence), { recursive: true, force: true }); }
});

test("专项 oracle 拒绝重复 id 与非独立行为断言", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-oracle-schema-"));
  try {
    const fixture = path.join(temp, "oracle.json");
    writeFileSync(fixture, JSON.stringify({ version: 1, rows: [
      { id: "retry", assertion: "real-behavior" }, { id: "retry", assertion: "production-derived" },
    ] }));
    assert.throws(() => loadAcceptanceOracle(fixture), /duplicate|assertion|oracle/i);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
