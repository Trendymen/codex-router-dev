const REDACTED = "[REDACTED]";
const SAFE_FIELDS = new Set([
  "status",
  "code",
  "type",
  "requestId",
  "request_id",
  "retryAfter",
  "retry_after",
]);
const SAFE_HEADER = /^(?:x-)?request-id$|^(?:x-)?rate-limit(?:-|_).*|^ratelimit(?:-|_).*|^retry-after$/i;
const SAFE_CODE = /^[a-z0-9_.-]{1,128}$/i;
const SAFE_REQUEST_ID = /^[a-z0-9_.:-]{1,256}$/i;

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeCode(value) {
  return typeof value === "string" && SAFE_CODE.test(value) ? value : undefined;
}

function safeRequestId(value) {
  return typeof value === "string" && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

function safeRateLimit(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && /^(?:\d+(?:\.\d+)?|[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT)$/.test(value)
    ? value
    : undefined;
}

function safeField(key, value) {
  if (key === "status") return safeStatus(value);
  if (key === "code" || key === "type") return safeCode(value);
  if (key === "requestId" || key === "request_id") return safeRequestId(value);
  if (key === "retryAfter" || key === "retry_after") return safeRateLimit(value);
  return undefined;
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  const safe = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SAFE_HEADER.test(key)) continue;
    const allowed = /request-id$/i.test(key) ? safeRequestId(value) : safeRateLimit(value);
    if (allowed !== undefined) safe[key.toLowerCase()] = allowed;
  }
  return Object.keys(safe).length ? safe : undefined;
}

function redactDiagnostic(value, seen) {
  if (value === null || typeof value !== "object") return REDACTED;
  if (value instanceof Error) return { type: "error" };
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnostic(entry, seen));

  const safe = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "headers") {
      const headers = redactHeaders(entry);
      if (headers) safe.headers = headers;
      continue;
    }
    if (!SAFE_FIELDS.has(key)) continue;
    const allowed = safeField(key, entry);
    if (allowed !== undefined) safe[key] = allowed;
  }
  return safe;
}

function supportRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = {};
  for (const key of ["platform", "architecture", "node", "packageVersion", "gitCommit"]) {
    const entry = value[key];
    if (typeof entry === "string" && /^[a-z0-9._+-]{1,128}$/i.test(entry)) safe[key] = entry;
  }
  return safe;
}

function redactSupportBundle(value, seen) {
  if (!value || typeof value !== "object" || Array.isArray(value) || seen.has(value)) return {};
  seen.add(value);
  const safe = { schemaVersion: 1 };
  if (typeof value.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)) {
    safe.createdAt = value.createdAt;
  }
  if (value.privacy === "Credential values, prompts, response bodies, and log contents are excluded." ||
      value.privacy === "Includes only a redacted log-tail marker; log content is excluded.") {
    safe.privacy = value.privacy;
  }
  const runtime = supportRuntime(value.runtime);
  if (Object.keys(runtime).length) safe.runtime = runtime;
  for (const key of ["doctor", "config", "service", "selection"]) {
    safe[key] = redactDiagnostic(value[key], seen);
  }
  if (Number.isInteger(value.configuredProviderCount) && value.configuredProviderCount >= 0) {
    safe.configuredProviderCount = value.configuredProviderCount;
  }
  if (typeof value.installed === "boolean") safe.installed = value.installed;
  if (value.files && typeof value.files === "object") {
    safe.files = {
      configExists: Boolean(value.files.configExists),
      logExists: Boolean(value.files.logExists),
    };
  }
  if (value.redactedLogTail) safe.redactedLogTail = REDACTED;
  return safe;
}

// This is the only redaction boundary for diagnostics. The default profile is
// a closed protocol allowlist; support bundles use their separately closed
// structural profile before serialization.
export function redactSensitive(value, context = {}) {
  const seen = new WeakSet();
  return context.profile === "support-bundle"
    ? redactSupportBundle(value, seen)
    : redactDiagnostic(value, seen);
}
