import { experimentalModelForSlug } from "./experimental-models.mjs";
import {
  protocolProofRevision,
  registryFingerprint,
  writePassingProtocolProof,
} from "./protocol-proof.mjs";
import { dispatchProtocolProbe as dispatchNodeProtocolProbe } from "./provider-dispatch.mjs";

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

export const dispatchProtocolProbe = dispatchNodeProtocolProbe;

// Phase 1 deliberately accepts only an injected dispatcher. It establishes the
// quota gate and no-fallback contract without adding a live provider path.
export async function verifyProtocolProof(slug, options = {}) {
  if (options.confirmed !== true) throw publicError("quota_confirmation_required", 409);

  const model = experimentalModelForSlug(slug);
  // The probe intentionally runs before the commit lock so it never holds a
  // shared state transaction while quota work is in flight. Guard its later
  // candidate commit with this revision: an operator revoke during the probe
  // wins instead of being silently resurrected by stale evidence.
  const expectedRevision = protocolProofRevision(model.slug);
  const probe = options.dispatchProtocolProbe ?? ((candidate, probeOptions) =>
    dispatchNodeProtocolProbe(candidate, {
      ...probeOptions,
      ...(options.allowLive === undefined ? {} : { allowLive: options.allowLive === true }),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.credential ? { credential: options.credential } : {}),
      ...(options.internalKey ? { internalKey: options.internalKey } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      targetSlug: model.slug,
    }));
  const probeOptions = {
    retry: false,
    failover: false,
    checks: CHECKS,
    ...(options.dispatchProtocolProbe ? {} : { confirmed: options.confirmed === true }),
  };
  const evidence = await probe(model, probeOptions);
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : [];
  const byName = new Map(checks.map((check) => [check?.name, check]));
  const detailedChecksPass = checks.length === CHECKS.length && CHECKS.every((name) => {
    const check = byName.get(name);
    return check?.ok === true && check.observed && typeof check.observed === "object" && !Array.isArray(check.observed);
  });
  if (
    evidence?.model !== model.slug ||
    evidence?.verdict !== "passing" ||
    !VERIFIED_FINAL_SHAPES.has(evidence.measuredFinalReasoningShape) ||
    !detailedChecksPass
  ) {
    throw publicError("protocol_proof_verification_failed", 422);
  }
  const record = recordFor(model, evidence, options.clock);
  await writePassingProtocolProof(record, {
    expectedRevision,
    ...(options.transactionOptions || {}),
  });
  return record;
}
