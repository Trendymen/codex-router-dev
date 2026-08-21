import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "protocol-proof-"));
const stateDir = path.join(scratch, "state");
const codexHome = path.join(scratch, "codex-home");

process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;

const { EXPERIMENTAL_MODELS_PATH, PROTOCOL_PROOFS_PATH } = await import("../src/paths.mjs");
const { experimentalModelEnabled, setExperimentalModel } = await import("../src/experimental-models.mjs");
const {
  readProtocolProof,
  registryFingerprint,
  revokeProtocolProof,
  writePassingProtocolProof,
} = await import("../src/protocol-proof.mjs");

const passingProof = Object.freeze({
  slug: "qwen-plan/qwen3.7-max",
  verdict: "passing",
  fingerprint: "registry-fingerprint",
  verifierVersion: 1,
  verifiedAt: "2026-08-21T12:00:00.000Z",
});

function mode(target) {
  return statSync(target).mode & 0o777;
}

beforeEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(codexHome, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("canary defaults off and is exact-slug scoped", () => {
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), false);
  setExperimentalModel("qwen-plan/qwen3.7-max", true);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), true);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-plus"), false);

  assert.equal(mode(EXPERIMENTAL_MODELS_PATH), 0o600);
  setExperimentalModel("qwen-plan/qwen3.7-max", false);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), false);
});

test("a corrupt canary file fails closed", () => {
  writeFileSync(EXPERIMENTAL_MODELS_PATH, "not json", { mode: 0o600 });
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), false);
  setExperimentalModel("qwen-plan/qwen3.7-max", true);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), true);
});

test("registry fingerprint covers only the canonical model contract", () => {
  const model = {
    ignored: "not part of the contract",
    slug: "qwen-plan/qwen3.7-max",
    provider: "qwen-plan",
    upstreamModel: "qwen3.7-max",
    effectiveTransport: "openai-responses",
    toolDialect: "openai",
    requestProfile: { zeta: true, alpha: { two: 2, one: 1 } },
  };
  const reordered = {
    ...model,
    requestProfile: { alpha: { one: 1, two: 2 }, zeta: true },
  };

  assert.equal(
    registryFingerprint(model, 3),
    "MdckViQwcpOuqDHog-79fcPi7x9MS2jAB7qU88HbhMc",
  );
  assert.equal(registryFingerprint(reordered, 3), registryFingerprint(model, 3));
  assert.notEqual(registryFingerprint(model, 4), registryFingerprint(model, 3));
});

test("failed verification never replaces a passing proof", () => {
  writePassingProtocolProof(passingProof);
  assert.throws(
    () => writePassingProtocolProof({ ...passingProof, verdict: "failed" }),
    /passing/,
  );
  assert.deepEqual(readProtocolProof(passingProof.slug), passingProof);
});

test("proof state fails closed when corrupt and revoke is exact-slug scoped", () => {
  writeFileSync(PROTOCOL_PROOFS_PATH, "not json", { mode: 0o600 });
  assert.equal(readProtocolProof(passingProof.slug), null);

  const other = { ...passingProof, slug: "qwen-plan/qwen3.7-plus" };
  writePassingProtocolProof(passingProof);
  writePassingProtocolProof(other);
  revokeProtocolProof(passingProof.slug);

  assert.equal(readProtocolProof(passingProof.slug), null);
  assert.deepEqual(readProtocolProof(other.slug), other);
});

test("proof writes are owner-only atomic replacements", () => {
  writePassingProtocolProof(passingProof);
  assert.equal(mode(PROTOCOL_PROOFS_PATH), 0o600);

  const oldDescriptor = openSync(PROTOCOL_PROOFS_PATH, "r");
  const replacement = { ...passingProof, verifiedAt: "2026-08-21T12:01:00.000Z" };
  try {
    writePassingProtocolProof(replacement);
    assert.deepEqual(readProtocolProof(passingProof.slug), replacement);
    assert.match(readFileSync(oldDescriptor, "utf8"), /12:00:00\.000Z/);
  } finally {
    closeSync(oldDescriptor);
  }
  assert.equal(
    readdirSync(stateDir).some((entry) => entry.startsWith("protocol-proofs.json.tmp.")),
    false,
  );
});

test("isolated state never writes through CODEX_HOME", () => {
  const marker = path.join(codexHome, "operator-state");
  writeFileSync(marker, "untouched");

  assert.equal(EXPERIMENTAL_MODELS_PATH, path.join(stateDir, "experimental-models.json"));
  assert.equal(PROTOCOL_PROOFS_PATH, path.join(stateDir, "protocol-proofs.json"));
  setExperimentalModel(passingProof.slug, true);
  writePassingProtocolProof(passingProof);

  assert.equal(readFileSync(marker, "utf8"), "untouched");
  assert.deepEqual(readdirSync(codexHome), ["operator-state"]);
  assert.equal(existsSync(path.join(codexHome, "codex-router")), false);
});
