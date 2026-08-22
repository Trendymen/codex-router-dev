import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { jcsBytes, jcs } from "../src/jcs.mjs";
import { sealReasoningEnvelope, verifyReasoningEnvelope, reasoningTextHash } from "../src/reasoning-envelope.mjs";

const KEY = "task5-internal-key-with-enough-entropy";
const PAYLOAD = {
  v: 1,
  provider: "qwen-plan",
  model: "glm-5.2",
  transport: "anthropic-messages",
  responseId: "msg_\u00e9",
  itemId: "rsn_1",
  textSha256: reasoningTextHash(["a", "e\u0301"]),
  signature: "sig-opaque",
};

test("JCS golden semantics sort keys and preserve combining Unicode", () => {
  assert.equal(jcs({ b: 1, a: "x", nested: { z: true, y: null } }),
    '{"a":"x","b":1,"nested":{"y":null,"z":true}}');
  assert.equal(jcs({ control: "\\\"\n\r\t\u0000", text: "e\u0301" }),
    '{"control":"\\\\\\\"\\n\\r\\t\\u0000","text":"é"}');
  assert.equal(jcs({ n: -0, one: 1.5, big: 1e+21 }), '{"big":1e+21,"n":0,"one":1.5}');
  assert.equal(Buffer.isBuffer(jcsBytes(PAYLOAD)), true);
  assert.equal(Buffer.from(jcsBytes(PAYLOAD)).toString("utf8").includes("\\u00e9"), false);
});

test("envelope seal is a stable unpadded base64url golden vector", () => {
  const value = sealReasoningEnvelope(PAYLOAD, KEY);
  assert.match(value, /^cr\.reasoning\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(value.includes("="), false);
  assert.equal(value, sealReasoningEnvelope({ ...PAYLOAD }, KEY));
  assert.equal(verifyReasoningEnvelope(value, {
    provider: PAYLOAD.provider, model: PAYLOAD.model, transport: PAYLOAD.transport,
    responseId: PAYLOAD.responseId, itemId: PAYLOAD.itemId,
    summaryParts: ["a", "e\u0301"],
  }, KEY).status, "valid");
  const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/reasoning-envelope-v1.json", import.meta.url)), "utf8"));
  assert.equal(sealReasoningEnvelope(golden.payload, golden.key), golden.sealed);
});

test("envelope verification is fail-closed for tamper, foreign, unknown, and hostile values", () => {
  const value = sealReasoningEnvelope(PAYLOAD, KEY);
  const [encoded, mac] = value.slice("cr.reasoning.v1.".length).split(".");
  const tampered = `cr.reasoning.v1.${encoded.slice(0, -1)}${encoded.endsWith("A") ? "B" : "A"}.${mac}`;
  assert.equal(verifyReasoningEnvelope(tampered, PAYLOAD, KEY).status, "invalid");
  assert.equal(verifyReasoningEnvelope(value, { ...PAYLOAD, provider: "other" }, KEY).status, "foreign");
  assert.equal(verifyReasoningEnvelope("not-an-envelope", PAYLOAD, KEY).status, "unknown");
  assert.equal(verifyReasoningEnvelope(value, { provider: PAYLOAD.provider, model: PAYLOAD.model, transport: PAYLOAD.transport, responseId: PAYLOAD.responseId, itemId: PAYLOAD.itemId, summaryParts: ["different"] }, KEY).status, "invalid");
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => sealReasoningEnvelope(cyclic, KEY), TypeError);
  assert.throws(() => sealReasoningEnvelope({ x: 1n }, KEY), TypeError);
});

test("reasoning hash is JCS over exact ordered parts and does not normalize", () => {
  const direct = createHash("sha256").update(Buffer.from('["a","é"]', "utf8")).digest("base64url");
  assert.equal(reasoningTextHash(["a", "e\u0301"]), direct);
  assert.notEqual(reasoningTextHash(["a", "é"]), direct);
});
