import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { PROTOCOL_PROOFS_PATH } from "./paths.mjs";
import { transactNodeStateMutation } from "./catalog-rebuild.mjs";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function registryFingerprint(model, verifierVersion) {
  return createHash("sha256").update(canonicalJson({
    verifierVersion,
    slug: model.slug,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    effectiveTransport: model.effectiveTransport,
    toolDialect: model.toolDialect,
    requestProfile: model.requestProfile,
  })).digest("base64url");
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function validProtocolProof(record, slug = record?.slug) {
  return (
    objectRecord(record) &&
    typeof record.slug === "string" &&
    record.slug.length > 0 &&
    record.slug === slug &&
    typeof record.provider === "string" &&
    record.provider.length > 0 &&
    typeof record.upstreamModel === "string" &&
    record.upstreamModel.length > 0 &&
    typeof record.transport === "string" &&
    record.transport.length > 0 &&
    typeof record.toolDialect === "string" &&
    record.toolDialect.length > 0 &&
    typeof record.requestProfile === "string" &&
    record.requestProfile.length > 0 &&
    record.verdict === "passing" &&
    typeof record.fingerprint === "string" &&
    record.fingerprint.length > 0 &&
    Number.isInteger(record.verifierVersion) &&
    record.verifierVersion > 0 &&
    typeof record.measuredFinalReasoningShape === "string" &&
    ["provider-summary", "raw-content", "hybrid-summary", "anthropic-thinking"].includes(
      record.measuredFinalReasoningShape,
    ) &&
    typeof record.verifiedAt === "string" &&
    record.verifiedAt.length > 0
  );
}

function readProtocolProofState() {
  if (!existsSync(PROTOCOL_PROOFS_PATH)) return { revision: 0, revisions: {}, proofs: {} };
  try {
    const parsed = JSON.parse(readFileSync(PROTOCOL_PROOFS_PATH, "utf8"));
    if (
      !objectRecord(parsed) ||
      parsed.version !== 1 ||
      (parsed.revision !== undefined && (!Number.isInteger(parsed.revision) || parsed.revision < 0)) ||
      (parsed.revisions !== undefined && (!objectRecord(parsed.revisions) ||
        !Object.entries(parsed.revisions).every(([slug, revision]) =>
          typeof slug === "string" && Number.isInteger(revision) && revision >= 0))) ||
      !objectRecord(parsed.proofs) ||
      !Object.entries(parsed.proofs).every(([slug, proof]) => validProtocolProof(proof, slug))
    ) {
      return { revision: 0, revisions: {}, proofs: {} };
    }
    return { revision: parsed.revision ?? 0, revisions: parsed.revisions ?? {}, proofs: parsed.proofs };
  } catch {
    return { revision: 0, revisions: {}, proofs: {} };
  }
}

function readProtocolProofs() {
  return readProtocolProofState().proofs;
}

export function protocolProofRevision(slug) {
  const state = readProtocolProofState();
  return slug === undefined ? state.revision : state.revisions[String(slug)] ?? 0;
}

function writeProtocolProofState(proofs, revision, revisions) {
  writePrivateJson(
    PROTOCOL_PROOFS_PATH,
    { version: 1, revision, revisions, proofs },
    { directoryMode: 0o700 },
  );
}

export function readProtocolProof(slug) {
  const key = String(slug);
  const proof = readProtocolProofs()[key];
  return proof?.slug === key && proof.verdict === "passing" ? proof : null;
}

export function protocolProofSnapshot() {
  return Object.freeze(
    Object.values(readProtocolProofs())
      .filter((proof) => proof.verdict === "passing")
      .sort((left, right) => left.slug.localeCompare(right.slug)),
  );
}

export async function writePassingProtocolProof(record, options = {}) {
  if (!validProtocolProof(record)) {
    throw new Error("Protocol proof writes require a complete passing record.");
  }
  const { expectedRevision, transaction = transactNodeStateMutation, ...transactionOptions } = options;
  return transaction({
    files: [PROTOCOL_PROOFS_PATH],
    reason: `protocol-proof:verify:${record.slug}`,
    mutate: () => {
      const state = readProtocolProofState();
      const currentSlugRevision = state.revisions[record.slug] ?? 0;
      if (expectedRevision !== undefined && currentSlugRevision !== expectedRevision) {
        const error = new Error("Protocol proof state changed while verification was running.");
        error.code = "protocol_proof_state_changed";
        throw error;
      }
      writeProtocolProofState(
        { ...state.proofs, [record.slug]: record },
        state.revision + 1,
        { ...state.revisions, [record.slug]: currentSlugRevision + 1 },
      );
    },
    ...transactionOptions,
  });
}

export async function revokeProtocolProof(slug, options = {}) {
  const key = String(slug);
  const { transaction = transactNodeStateMutation, ...transactionOptions } = options;
  return transaction({
    files: [PROTOCOL_PROOFS_PATH],
    reason: `protocol-proof:revoke:${key}`,
    mutate: () => {
      const state = readProtocolProofState();
      const next = { ...state.proofs };
      delete next[key];
      // A no-op revoke still advances the guarded revision. A verification
      // candidate that started first must never resurrect a proof after the
      // operator has explicitly revoked it.
      writeProtocolProofState(
        next,
        state.revision + 1,
        { ...state.revisions, [key]: (state.revisions[key] ?? 0) + 1 },
      );
    },
    ...transactionOptions,
  });
}

function recordMatchesModel(record, model) {
  return record?.slug === model?.slug &&
    record.provider === model.provider &&
    record.upstreamModel === model.upstreamModel &&
    record.transport === model.effectiveTransport &&
    record.toolDialect === model.toolDialect &&
    record.requestProfile === model.requestProfile &&
    record.fingerprint === registryFingerprint(model, record.verifierVersion);
}

/** Transaction-safe seam for registry/update completion (Task 4C wiring). */
export async function invalidateProtocolProofForModel(model, options = {}) {
  const slug = String(model?.slug || "");
  if (!slug) throw new Error("Protocol proof invalidation requires a model slug.");
  const { transaction = transactNodeStateMutation, ...transactionOptions } = options;
  return transaction({
    files: [PROTOCOL_PROOFS_PATH],
    reason: `protocol-proof:invalidate:${slug}`,
    mutate: () => {
      const state = readProtocolProofState();
      const record = state.proofs[slug];
      if (!record || recordMatchesModel(record, model)) return;
      const next = { ...state.proofs };
      delete next[slug];
      writeProtocolProofState(
        next,
        state.revision + 1,
        { ...state.revisions, [slug]: (state.revisions[slug] ?? 0) + 1 },
      );
    },
    ...transactionOptions,
  });
}
