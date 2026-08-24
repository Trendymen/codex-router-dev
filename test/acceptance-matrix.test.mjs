import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAcceptanceMatrix, verifyNodeOnlyBuild } from "../scripts/verify-node-only-build.mjs";

const APPENDICES = Array.from({ length: 10 }, (_, index) => `Appendix ${String.fromCharCode(65 + index)}`);
const TESTING_CATEGORIES = ["15.1", "15.2", "15.3", "15.4", "15.5"];
const SUCCESS_CRITERIA = Array.from({ length: 9 }, (_, index) => `17.${index + 1}`);

function fixtureRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "node-only-build-audit-"));
  for (const relative of [
    "src/router.mjs",
    "src/node-runtime.mjs",
    "apps/desktop/ui/index.html",
    "apps/desktop/ui/app.js",
    "apps/macos/ModelRouterTray/ModelRouterTray.app/Contents/MacOS/ModelRouterTray",
    "config/deepseek/deepseek.json",
    "config/qwen/plan/qwen3.8-max.json",
  ]) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "node native artifact\n");
  }
  return root;
}

test("acceptance matrix independently covers every required specification locus", () => {
  const requirements = loadAcceptanceMatrix();
  assert.ok(requirements.length >= APPENDICES.length + TESTING_CATEGORIES.length + SUCCESS_CRITERIA.length);
  const loci = new Set(requirements.flatMap(({ specLoci }) => specLoci));
  for (const locus of [...APPENDICES, ...TESTING_CATEGORIES, ...SUCCESS_CRITERIA]) assert.ok(loci.has(locus), `missing ${locus}`);
  for (const requirement of requirements) {
    assert.match(requirement.id, /^NM-(?:APP|TEST|SUCCESS)-[A-Z0-9.-]+$/);
    assert.equal(typeof requirement.owner, "string");
    assert.ok(requirement.owner.length > 0, `${requirement.id} needs an implementation owner`);
    assert.ok(Array.isArray(requirement.evidence) && requirement.evidence.length > 0, `${requirement.id} needs evidence`);
    for (const row of requirement.evidence) {
      assert.match(row.type, /^(?:unit|build|runtime|ui|visual|isolated-install|live)$/);
      assert.equal(typeof row.artifact, "string");
      assert.ok(row.artifact.length > 0, `${requirement.id} evidence needs an artifact path`);
      if (row.type === "visual") {
        assert.match(row.source, /^(?:screenshot|human-inspection)$/);
        assert.doesNotMatch(row.source, /http|test|build/i);
      }
    }
  }
});

test("node-only build audit accepts required artifacts and reports removed runtimes", () => {
  const root = fixtureRoot();
  try {
    assert.deepEqual(verifyNodeOnlyBuild(root), []);
    const forbidden = path.join(root, "scripts", "legacy-build.sh");
    mkdirSync(path.dirname(forbidden), { recursive: true });
    writeFileSync(forbidden, "python3 -m pip install litellm\ncargo build --release\n");
    assert.deepEqual(
      verifyNodeOnlyBuild(root).map(({ kind, path: relative }) => ({ kind, path: relative })),
      [
        { kind: "litellm-runtime", path: "scripts/legacy-build.sh" },
        { kind: "python-runtime", path: "scripts/legacy-build.sh" },
        { kind: "rust-tauri-runtime", path: "scripts/legacy-build.sh" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node-only build audit rejects a release root missing its Node router entrypoint", () => {
  const root = fixtureRoot();
  try {
    unlinkSync(path.join(root, "src", "router.mjs"));
    assert.deepEqual(verifyNodeOnlyBuild(root), [
      { kind: "required-artifact-missing", path: "src/router.mjs", detail: "required Node-native release artifact is absent" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
