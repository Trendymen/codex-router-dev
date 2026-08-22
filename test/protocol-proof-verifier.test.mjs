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
const { readProtocolProof, registryFingerprint } = await import("../src/protocol-proof.mjs");
const { proofMatchesModel } = await import("../src/model-contract.mjs");

const slug = "qwen-plan/qwen3.7-max";
const model = MODEL_BY_SLUG.get(slug);

function passingEvidence(overrides = {}) {
  return {
    model: slug,
    verdict: "passing",
    measuredFinalReasoningShape: "hybrid-summary",
    checks: ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"].map((name) => ({ name, ok: true, observed: { fixture: true } })),
    ...overrides,
  };
}

function verifierOptions(overrides = {}) {
  return {
    confirmed: true,
    clock: () => new Date("2026-08-22T01:02:03.000Z"),
    dispatchProtocolProbe: async () => passingEvidence(),
    transactionOptions: { transaction: async ({ mutate }) => mutate() },
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
      dispatchProtocolProbe: async () => {
        calls += 1;
        throw new Error("must not dispatch without quota confirmation");
      },
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

test("a failed first verification fails closed and creates no proof", async () => {
  await assert.rejects(
    () => verifyProtocolProof(
      slug,
      verifierOptions({ dispatchProtocolProbe: async () => ({ verdict: "failed" }) }),
    ),
    { code: "protocol_proof_verification_failed" },
  );
  assert.equal(readProtocolProof(slug), null);
});

test("a claimed passing verdict without all five detailed successful checks fails closed", async () => {
  for (const evidence of [
    passingEvidence({ checks: passingEvidence().checks.slice(0, 4) }),
    passingEvidence({ checks: passingEvidence().checks.map((check) => check.name === "usage" ? { ...check, ok: false } : check) }),
    passingEvidence({ checks: passingEvidence().checks.map((check) => check.name === "usage" ? { name: check.name, ok: true } : check) }),
    passingEvidence({ model: "qwen-plan/substitute" }),
  ]) {
    await assert.rejects(
      () => verifyProtocolProof(slug, verifierOptions({ dispatchProtocolProbe: async () => evidence })),
      { code: "protocol_proof_verification_failed" },
    );
    assert.equal(readProtocolProof(slug), null);
  }
});

test("an illegal final shape fails closed on first verification", async () => {
  await assert.rejects(
    () => verifyProtocolProof(
      slug,
      verifierOptions({ dispatchProtocolProbe: async () => passingEvidence({ measuredFinalReasoningShape: "unverified" }) }),
    ),
    { code: "protocol_proof_verification_failed" },
  );
  assert.equal(readProtocolProof(slug), null);
});

test("an illegal final shape preserves the old passing proof on re-verification", async () => {
  const oldProof = await verifyProtocolProof(slug, verifierOptions());
  await assert.rejects(
    () => verifyProtocolProof(
      slug,
      verifierOptions({ dispatchProtocolProbe: async () => passingEvidence({ measuredFinalReasoningShape: "unverified" }) }),
    ),
    { code: "protocol_proof_verification_failed" },
  );
  assert.deepEqual(readProtocolProof(slug), oldProof);
});

test("a stale verifier version fingerprint is rejected while the current version passes the gate", async () => {
  const proof = await verifyProtocolProof(slug, verifierOptions());
  const staleVersion = PROTOCOL_PROOF_VERIFIER_VERSION + 1;
  const staleProof = {
    ...proof,
    verifierVersion: staleVersion,
    fingerprint: registryFingerprint(model, staleVersion),
  };

  assert.equal(proofMatchesModel(proof, model), true);
  assert.notEqual(staleProof.fingerprint, proof.fingerprint);
  assert.equal(proofMatchesModel(staleProof, model), false);
});

test("the Phase 1 dispatcher fails closed without a network seam", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("network must stay unreachable in Phase 1");
  };
  try {
    await assert.rejects(
      () => verifyProtocolProof(slug, { confirmed: true, allowLive: false }),
      { code: "protocol_probe_not_implemented" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("the production verifier seam forwards only the confirmed exact target runtime", async () => {
  let dispatched;
  const proof = await verifyProtocolProof(slug, {
    confirmed: true,
    dispatchProtocolProbe: async (candidate, options) => {
      dispatched = { candidate, options };
      return passingEvidence();
    },
    clock: () => new Date("2026-08-22T01:02:03.000Z"),
    transactionOptions: { transaction: async ({ mutate }) => mutate() },
  });
  assert.equal(dispatched.candidate.slug, slug);
  assert.deepEqual(dispatched.options, { retry: false, failover: false, checks: ["nonstream", "stream-reasoning", "auto-tool", "continuation", "usage"] });
  assert.equal(proof.verdict, "passing");
});
