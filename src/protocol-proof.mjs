import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { PROTOCOL_PROOFS_PATH } from "./paths.mjs";

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

function readProtocolProofs() {
  if (!existsSync(PROTOCOL_PROOFS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(PROTOCOL_PROOFS_PATH, "utf8"));
    if (parsed?.version !== 1 || !parsed.proofs || typeof parsed.proofs !== "object") {
      return {};
    }
    return parsed.proofs;
  } catch {
    return {};
  }
}

export function readProtocolProof(slug) {
  const key = String(slug);
  const proof = readProtocolProofs()[key];
  return proof?.slug === key && proof.verdict === "passing" ? proof : null;
}

export function writePassingProtocolProof(record) {
  if (!record || record.verdict !== "passing") {
    throw new Error("Protocol proof writes require a passing verdict.");
  }
  const slug = String(record.slug || "");
  if (!slug) throw new Error("Protocol proof writes require a model slug.");
  const proofs = readProtocolProofs();
  writePrivateJson(
    PROTOCOL_PROOFS_PATH,
    { version: 1, proofs: { ...proofs, [slug]: record } },
    { directoryMode: 0o700 },
  );
}

export function revokeProtocolProof(slug) {
  const proofs = readProtocolProofs();
  const key = String(slug);
  if (!(key in proofs)) return;
  const next = { ...proofs };
  delete next[key];
  writePrivateJson(
    PROTOCOL_PROOFS_PATH,
    { version: 1, proofs: next },
    { directoryMode: 0o700 },
  );
}
