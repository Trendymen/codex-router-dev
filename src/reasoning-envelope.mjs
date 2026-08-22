import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { jcsBytes } from "./jcs.mjs";

const PREFIX = "cr.reasoning.v1.";
const DOMAIN = Buffer.from("codex-router.reasoning-envelope.v1\0", "ascii");
const FIELDS = ["v", "provider", "model", "transport", "responseId", "itemId", "textSha256", "signature"];

function hashBytes(value) { return createHash("sha256").update(value).digest("base64url"); }
export function reasoningItemId(responseId, outputIndex) {
  if (typeof responseId !== "string" || !responseId || !Number.isSafeInteger(outputIndex) || outputIndex < 0) throw new TypeError("reasoning identity is invalid");
  return `rsn_${createHash("sha256").update(`${responseId}:${outputIndex}`, "utf8").digest("base64url").slice(0, 24)}`;
}
export function reasoningTextHash(summaryParts) {
  if (!Array.isArray(summaryParts) || summaryParts.some((part) => typeof part !== "string")) throw new TypeError("summaryParts must be strings");
  return hashBytes(jcsBytes(summaryParts));
}

function payloadShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("reasoning envelope payload must be an object");
  const keys = Object.keys(payload).sort();
  if (keys.length !== FIELDS.length || keys.some((key, index) => key !== [...FIELDS].sort()[index])) throw new TypeError("reasoning envelope payload has invalid fields");
  if (payload.v !== 1 || !["provider", "model", "transport", "responseId", "itemId", "textSha256"].every((key) => typeof payload[key] === "string" && payload[key])) throw new TypeError("reasoning envelope payload has invalid provenance");
  if (payload.signature !== null && typeof payload.signature !== "string") throw new TypeError("reasoning envelope payload has invalid signature");
  return payload;
}

export function sealReasoningEnvelope(payload, internalKey) {
  if (typeof internalKey !== "string" || !internalKey) throw new TypeError("internal key is required");
  const checked = payloadShape(payload);
  const bytes = jcsBytes(checked);
  const mac = createHmac("sha256", internalKey).update(DOMAIN).update(bytes).digest("base64url");
  return `${PREFIX}${bytes.toString("base64url")}.${mac}`;
}

function verdict(status, extra = {}) { return Object.freeze({ status, ok: status === "valid", ...extra }); }
function expectedMatches(payload, expected) {
  if (!expected || typeof expected !== "object") return { status: "unknown" };
  const identity = ["provider", "model", "transport", "responseId", "itemId"];
  if (identity.some((field) => typeof expected[field] !== "string" || !expected[field])
    || (expected.textSha256 === undefined && expected.summaryParts === undefined)) return { status: "unknown" };
  if (["provider", "model", "transport"].some((field) => payload[field] !== expected[field])) return { status: "foreign" };
  if (["responseId", "itemId"].some((field) => payload[field] !== expected[field])) return { status: "invalid" };
  const expectedHash = expected.textSha256 !== undefined ? expected.textSha256 : reasoningTextHash(expected.summaryParts);
  return { status: payload.textSha256 === expectedHash ? "valid" : "invalid" };
}

export function verifyReasoningEnvelope(value, expected, internalKey) {
  if (typeof value !== "string" || typeof internalKey !== "string" || !internalKey) return verdict("unknown", { code: "thinking_provenance_unknown" });
  if (!value.startsWith("cr.reasoning.")) return verdict("unknown", { code: "thinking_provenance_unknown" });
  if (!value.startsWith(PREFIX)) return verdict("invalid", { code: "thinking_signature_invalid" });
  const encoded = value.slice(PREFIX.length).split(".");
  if (encoded.length !== 2 || !encoded[0] || !encoded[1] || encoded.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return verdict("invalid", { code: "thinking_signature_invalid" });
  let bytes;
  try { bytes = Buffer.from(encoded[0], "base64url"); if (bytes.toString("base64url") !== encoded[0]) return verdict("invalid", { code: "thinking_signature_invalid" }); const payload = JSON.parse(bytes.toString("utf8")); payloadShape(payload); if (!jcsBytes(payload).equals(bytes)) return verdict("invalid", { code: "thinking_signature_invalid" }); const provided = Buffer.from(encoded[1], "base64url"); if (provided.toString("base64url") !== encoded[1] || provided.length !== 32) return verdict("invalid", { code: "thinking_signature_invalid" });
    const actual = createHmac("sha256", internalKey).update(DOMAIN).update(bytes).digest();
    if (!timingSafeEqual(actual, provided)) return verdict("invalid", { code: "thinking_signature_invalid" });
    const match = expectedMatches(payload, expected);
    if (match.status === "unknown") return verdict("unknown", { code: "thinking_provenance_unknown" });
    if (match.status === "foreign") return verdict("foreign", { code: "thinking_provenance_foreign", payload });
    if (match.status === "invalid") return verdict("invalid", { code: "thinking_signature_invalid", payload });
    return verdict("valid", { payload });
  } catch { return verdict("invalid", { code: "thinking_signature_invalid" }); }
}

export const REASONING_ENVELOPE_DOMAIN = DOMAIN;
