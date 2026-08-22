const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|secret|token|password|credential|caller(?:[_-]?(?:url|capability|key|secret))?|capability|prompt|reasoning|arguments?|provider[_-]?body|response[_-]?body|cause|stack|snapshot|temp(?:orary)?|support|log|error|detail|message|exception)/i;
const URL_CAPABILITY = /(\/_codex-router\/)[^/?#\s"']+/gi;
const BEARER_VALUE = /(\bbearer\s+)[^\s"',;]+/gi;
const ASSIGNMENT_VALUE = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential|prompt|reasoning|arguments?|provider[_-]?body|response[_-]?body)\s*[=:]\s*["']?)[^\s"',}\]]+/gi;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const REDACTED = "[REDACTED]";

function redactText(value, redactWholeValue = false) {
  if (redactWholeValue) return REDACTED;
  return value
    .replace(URL_CAPABILITY, "$1[REDACTED]")
    .replace(BEARER_VALUE, `$1${REDACTED}`)
    .replace(ASSIGNMENT_VALUE, `$1${REDACTED}`)
    .replace(OPENAI_KEY, REDACTED);
}

function redactValue(value, context, seen) {
  if (typeof value === "string") return redactText(value, Boolean(context.sensitive));
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, context, seen));
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = redactValue(entry, { ...context, sensitive: context.sensitive || SENSITIVE_KEY.test(key) }, seen);
  }
  return result;
}

// This is the only redaction boundary for diagnostics. Context can mark an
// unstructured value (such as a log line or caught exception) as sensitive.
export function redactSensitive(value, context = {}) {
  return redactValue(value, { sensitive: Boolean(context.sensitive) }, new WeakSet());
}
