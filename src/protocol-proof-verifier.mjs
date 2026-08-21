import { experimentalModelForSlug } from "./experimental-models.mjs";
import { registryFingerprint, writePassingProtocolProof } from "./protocol-proof.mjs";

export const PROTOCOL_PROOF_VERIFIER_VERSION = 1;

const CHECKS = Object.freeze([
  "nonstream",
  "stream-reasoning",
  "auto-tool",
  "continuation",
  "usage",
]);

const VERIFIED_FINAL_SHAPES = new Set([
  "provider-summary",
  "raw-content",
  "hybrid-summary",
  "anthropic-thinking",
]);

function publicError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function verifiedAt(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error("Protocol proof clock returned an invalid timestamp.");
  return timestamp.toISOString();
}

function recordFor(model, evidence, clock) {
  return Object.freeze({
    slug: model.slug,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    transport: model.effectiveTransport,
    toolDialect: model.toolDialect,
    requestProfile: model.requestProfile,
    verdict: "passing",
    fingerprint: registryFingerprint(model, PROTOCOL_PROOF_VERIFIER_VERSION),
    verifierVersion: PROTOCOL_PROOF_VERIFIER_VERSION,
    measuredFinalReasoningShape: evidence?.measuredFinalReasoningShape ?? "unverified",
    verifiedAt: verifiedAt(clock),
  });
}

function unavailableDispatcher() {
  throw publicError("protocol_probe_not_implemented", 501);
}

// Phase 1 deliberately accepts only an injected dispatcher. It establishes the
// quota gate and no-fallback contract without adding a live provider path.
export async function verifyProtocolProof(slug, options = {}) {
  if (options.confirmed !== true) throw publicError("quota_confirmation_required", 409);

  const model = experimentalModelForSlug(slug);
  const dispatchProtocolProbe = options.dispatchProtocolProbe ?? unavailableDispatcher;
  const evidence = await dispatchProtocolProbe(model, {
    retry: false,
    failover: false,
    checks: CHECKS,
  });
  if (
    evidence?.verdict !== "passing" ||
    !VERIFIED_FINAL_SHAPES.has(evidence.measuredFinalReasoningShape)
  ) {
    throw publicError("protocol_proof_verification_failed", 422);
  }
  const record = recordFor(model, evidence, options.clock);
  writePassingProtocolProof(record);
  return record;
}
