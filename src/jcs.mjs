import { types as utilTypes } from "node:util";

// A small, fail-closed RFC 8785 JSON Canonicalization Scheme implementation.
// JSON values crossing a provenance boundary are intentionally narrower than
// JavaScript values: no getters, proxies, cycles, sparse arrays, or host types.
const MAX_DEPTH = 64;
const MAX_WORK = 65536;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function fail(message) { throw new TypeError(`JCS value is not canonicalizable: ${message}`); }

function assertUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("unpaired UTF-16 surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("unpaired UTF-16 surrogate");
  }
}

function quote(value, state) {
  assertUnicode(value);
  const result = JSON.stringify(value);
  if (typeof result !== "string") fail("invalid string");
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes > MAX_STRING_BYTES || (state.bytes += bytes) > MAX_TOTAL_BYTES) fail("string is too large");
  return result;
}

function ownDataKeys(value, allowLength = false) {
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { fail("unreadable object"); }
  if (allowLength) keys = keys.filter((key) => key !== "length");
  for (const key of keys) {
    if (typeof key !== "string") fail("symbol key");
    if (allowLength && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("accessor property");
    if (!descriptor.enumerable) fail("non-enumerable property");
  }
  return keys.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function encode(value, state, depth) {
  if (utilTypes.isProxy(value)) fail("proxy value");
  if (++state.work > MAX_WORK || depth > MAX_DEPTH) fail("value is too deep or broad");
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return quote(value, state);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) fail("non-finite number");
      // JSON.stringify implements the ECMAScript shortest decimal form used
      // by RFC 8785; it also correctly turns -0 into 0.
      return JSON.stringify(value);
    case "object": break;
    default: fail(`unsupported ${typeof value}`);
  }
  if (state.seen.has(value)) fail("cycle");
  state.seen.add(value);
  try {
  if (Array.isArray(value)) {
      if (value.length > MAX_WORK) fail("array is too large");
      const parts = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) fail("sparse or accessor array");
        parts.push(encode(descriptor.value, state, depth + 1));
      }
      // Extra enumerable properties are not JSON array members and therefore
      // are rejected instead of silently dropping hostile input.
      for (const key of ownDataKeys(value, true)) {
        if (!/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= value.length) fail("noncanonical array property");
      }
      return `[${parts.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("unsupported prototype");
    const keys = ownDataKeys(value);
    return `{${keys.map((key) => `${quote(key, state)}:${encode(Object.getOwnPropertyDescriptor(value, key).value, state, depth + 1)}`).join(",")}}`;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("JCS value")) throw error;
    fail("unreadable object");
  } finally { state.seen.delete(value); }
}

export function jcs(value) { return encode(value, { seen: new Set(), work: 0, bytes: 0 }, 0); }
export function jcsBytes(value) { return Buffer.from(jcs(value), "utf8"); }
export const canonicalize = jcs;
