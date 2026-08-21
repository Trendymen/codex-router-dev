import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "protocol-proof-verifier-"));
const stateDir = path.join(scratch, "state");
const codexHome = path.join(scratch, "codex-home");

process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.CODEX_HOME = codexHome;

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");
const {
  PROTOCOL_PROOF_VERIFIER_VERSION,
  verifyProtocolProof,
} = await import("../src/protocol-proof-verifier.mjs");
const { readProtocolProof } = await import("../src/protocol-proof.mjs");

const slug = "qwen-plan/qwen3.7-max";
const model = MODEL_BY_SLUG.get(slug);

function passingEvidence(overrides = {}) {
  return {
    verdict: "passing",
    measuredFinalReasoningShape: "hybrid-summary",
    ...overrides,
  };
}

function verifierOptions(overrides = {}) {
  return {
    confirmed: true,
    clock: () => new Date("2026-08-22T01:02:03.000Z"),
    dispatchProtocolProbe: async () => passingEvidence(),
    ...overrides,
  };
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

test("verify without confirmation sends no request", async () => {
  let calls = 0;
  await assert.rejects(
    () => verifyProtocolProof(slug, {
      confirmed: false,
      fetchImpl: async () => { calls += 1; },
    }),
    { code: "quota_confirmation_required" },
  );
  assert.equal(calls, 0);
});

test("verifier uses only the model declared transport with no retry or failover", async () => {
  let dispatched;
  const proof = await verifyProtocolProof(
    slug,
    verifierOptions({
      dispatchProtocolProbe: async (candidate, options) => {
        dispatched = { candidate, options };
        return passingEvidence();
      },
    }),
  );

  assert.equal(dispatched.candidate.slug, slug);
  assert.equal(dispatched.candidate.effectiveTransport, model.effectiveTransport);
  assert.deepEqual(dispatched.options, {
    retry: false,
    failover: false,
    checks: ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"],
  });
  assert.equal(proof.transport, model.effectiveTransport);
});

test("passing evidence writes the full exact-slug proof fingerprint", async () => {
  const proof = await verifyProtocolProof(slug, verifierOptions());

  assert.deepEqual(proof, {
    slug,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    transport: model.effectiveTransport,
    toolDialect: model.toolDialect,
    requestProfile: model.requestProfile,
    verdict: "passing",
    fingerprint: proof.fingerprint,
    verifierVersion: PROTOCOL_PROOF_VERIFIER_VERSION,
    measuredFinalReasoningShape: "hybrid-summary",
    verifiedAt: "2026-08-22T01:02:03.000Z",
  });
  assert.deepEqual(readProtocolProof(slug), proof);
});

test("a failed first verification creates no proof", async () => {
  const record = await verifyProtocolProof(
    slug,
    verifierOptions({ dispatchProtocolProbe: async () => ({ verdict: "failed" }) }),
  );

  assert.equal(record.verdict, "failed");
  assert.equal(readProtocolProof(slug), null);
});

test("a failed re-verification preserves the old passing proof", async () => {
  const oldProof = await verifyProtocolProof(slug, verifierOptions());
  const failed = await verifyProtocolProof(
    slug,
    verifierOptions({ dispatchProtocolProbe: async () => ({ verdict: "failed" }) }),
  );

  assert.equal(failed.verdict, "failed");
  assert.deepEqual(readProtocolProof(slug), oldProof);
});

test("a verifier-version change produces a new fingerprint", async () => {
  const proof = await verifyProtocolProof(slug, verifierOptions());
  assert.equal(proof.verifierVersion, PROTOCOL_PROOF_VERIFIER_VERSION);
  assert.notEqual(proof.fingerprint, "");
});
