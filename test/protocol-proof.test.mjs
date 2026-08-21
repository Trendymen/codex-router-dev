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

import { privateFileIsProtected } from "../src/file-security.mjs";

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
  provider: "qwen-plan",
  upstreamModel: "qwen3.7-max",
  transport: "openai-responses",
  toolDialect: "responses-functions",
  requestProfile: "qwen-plan",
  verdict: "passing",
  fingerprint: "registry-fingerprint",
  verifierVersion: 1,
  measuredFinalReasoningShape: "raw-content",
  verifiedAt: "2026-08-21T12:00:00.000Z",
});

function mode(target) {
  return statSync(target).mode & 0o777;
}

function assertPrivateFile(target) {
  assert.equal(privateFileIsProtected(target), true);
  // Windows protects private files with ACLs, not POSIX mode bits.
  if (process.platform !== "win32") assert.equal(mode(target), 0o600);
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

  assertPrivateFile(EXPERIMENTAL_MODELS_PATH);
  setExperimentalModel("qwen-plan/qwen3.7-max", false);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), false);
});

test("a corrupt canary file fails closed", () => {
  writeFileSync(EXPERIMENTAL_MODELS_PATH, "not json", { mode: 0o600 });
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), false);
  setExperimentalModel("qwen-plan/qwen3.7-max", true);
  assert.equal(experimentalModelEnabled("qwen-plan/qwen3.7-max"), true);
});

test("a canary file with any invalid model entry fails closed as a whole", () => {
  writeFileSync(
    EXPERIMENTAL_MODELS_PATH,
    JSON.stringify({ version: 1, models: [passingProof.slug, 17] }),
    { mode: 0o600 },
  );

  assert.equal(experimentalModelEnabled(passingProof.slug), false);
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

test("any invalid proof record makes the whole readable state empty", () => {
  const invalidRecords = [
    Object.fromEntries(Object.entries(passingProof).filter(([key]) => key !== "fingerprint")),
    Object.fromEntries(Object.entries(passingProof).filter(([key]) => key !== "verifierVersion")),
    { ...passingProof, fingerprint: "" },
    { ...passingProof, verifierVersion: "1" },
  ];

  for (const invalid of invalidRecords) {
    writeFileSync(
      PROTOCOL_PROOFS_PATH,
      JSON.stringify({ version: 1, proofs: { [passingProof.slug]: invalid } }),
      { mode: 0o600 },
    );
    assert.equal(readProtocolProof(passingProof.slug), null);
  }
});

test("an invalid sibling or mismatched proof key invalidates every proof", () => {
  const siblingSlug = "qwen-plan/qwen3.7-plus";
  const invalidSiblings = [
    { ...passingProof, slug: siblingSlug, fingerprint: "" },
    { ...passingProof, slug: "qwen-plan/different" },
  ];

  for (const sibling of invalidSiblings) {
    writeFileSync(
      PROTOCOL_PROOFS_PATH,
      JSON.stringify({
        version: 1,
        proofs: { [passingProof.slug]: passingProof, [siblingSlug]: sibling },
      }),
      { mode: 0o600 },
    );
    assert.equal(readProtocolProof(passingProof.slug), null);
  }
});

test("array-shaped proof state is discarded before the next passing write", () => {
  writeFileSync(
    PROTOCOL_PROOFS_PATH,
    JSON.stringify({ version: 1, proofs: [passingProof] }),
    { mode: 0o600 },
  );

  writePassingProtocolProof(passingProof);

  assert.deepEqual(
    JSON.parse(readFileSync(PROTOCOL_PROOFS_PATH, "utf8")),
    { version: 1, proofs: { [passingProof.slug]: passingProof } },
  );
});

test("proof writer rejects records missing any required field", () => {
  writePassingProtocolProof(passingProof);
  for (const field of [
    "slug",
    "provider",
    "upstreamModel",
    "transport",
    "toolDialect",
    "requestProfile",
    "fingerprint",
    "verifierVersion",
    "measuredFinalReasoningShape",
    "verifiedAt",
  ]) {
    const incomplete = { ...passingProof };
    delete incomplete[field];
    assert.throws(() => writePassingProtocolProof(incomplete), /require/);
  }
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
  assertPrivateFile(PROTOCOL_PROOFS_PATH);

  const replacement = { ...passingProof, verifiedAt: "2026-08-21T12:01:00.000Z" };
  if (process.platform === "win32") {
    // Windows refuses a replace while a reader keeps the target open, so it
    // cannot exercise the POSIX open-descriptor atomicity check below.
    writePassingProtocolProof(replacement);
    assert.deepEqual(readProtocolProof(passingProof.slug), replacement);
    assertPrivateFile(PROTOCOL_PROOFS_PATH);
  } else {
    const oldDescriptor = openSync(PROTOCOL_PROOFS_PATH, "r");
    try {
      writePassingProtocolProof(replacement);
      assert.deepEqual(readProtocolProof(passingProof.slug), replacement);
      assert.match(readFileSync(oldDescriptor, "utf8"), /12:00:00\.000Z/);
    } finally {
      closeSync(oldDescriptor);
    }
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
