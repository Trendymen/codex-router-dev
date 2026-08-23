import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { jcsBytes } from "../src/jcs.mjs";

import {
  createPanelSessionStore,
  canonicalArgumentsHash,
  validatePanelRequest,
} from "../src/panel-sessions.mjs";

function sequenceRandomBytes() {
  let value = 1;
  return (size) => Buffer.alloc(size, value++);
}

function request(overrides = {}) {
  return {
    method: "POST",
    headers: {
      host: "127.0.0.1:4202",
      origin: "http://127.0.0.1:4202",
      "content-type": "application/json",
      cookie: `panel_session=${"a".repeat(43)}`,
      "x-csrf-token": "b".repeat(43),
      "x-request-id": "11111111-1111-4111-8111-111111111111",
    },
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

test("bootstrap nonce is 256-bit, 30-second, atomically single use", async () => {
  let now = 1_000;
  const store = createPanelSessionStore({ clock: () => now, randomBytes: sequenceRandomBytes() });
  const minted = store.mintNonce();
  assert.equal(Buffer.from(minted.nonce, "base64url").length, 32);
  assert.equal(minted.expiresAt, now + 30_000);
  const results = await Promise.allSettled([
    Promise.resolve().then(() => store.consumeNonce(minted.nonce)),
    Promise.resolve().then(() => store.consumeNonce(minted.nonce)),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(Buffer.from(results.find((result) => result.status === "fulfilled").value.sessionId, "base64url").length, 32);
  assert.equal(Buffer.from(results.find((result) => result.status === "fulfilled").value.csrfToken, "base64url").length, 32);
  const expired = store.mintNonce();
  now += 30_001;
  assert.throws(() => store.consumeNonce(expired.nonce), /expired|invalid/i);
});

test("sessions enforce idle/absolute TTL, cap eviction, logout and restart revocation", () => {
  let now = 1_000;
  let sequence = 0;
  const store = createPanelSessionStore({
    clock: () => now,
    maxSessions: 2,
    randomBytes: (size) => Buffer.alloc(size, ++sequence),
  });
  const sessions = [store.consumeNonce(store.mintNonce().nonce), store.consumeNonce(store.mintNonce().nonce)];
  store.touchSession(sessions[0].sessionId);
  now += 1_000;
  store.touchSession(sessions[0].sessionId);
  const third = store.consumeNonce(store.mintNonce().nonce);
  assert.equal(store.getSession(sessions[0].sessionId).valid, true);
  assert.equal(store.getSession(sessions[1].sessionId).valid, false);
  assert.equal(store.getSession(third.sessionId).valid, true);
  now += 15 * 60_000 + 1;
  assert.equal(store.getSession(sessions[0].sessionId).valid, false);

  const fresh = store.consumeNonce(store.mintNonce().nonce);
  store.logout(fresh.sessionId);
  assert.equal(store.getSession(fresh.sessionId).valid, false);
  const restarted = store.consumeNonce(store.mintNonce().nonce);
  store.revokeAll();
  assert.equal(store.getSession(restarted.sessionId).valid, false);
});

test("request replay returns the previous result and never repeats mutation", () => {
  const store = createPanelSessionStore({ randomBytes: sequenceRandomBytes() });
  const session = store.consumeNonce(store.mintNonce().nonce);
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(store.replay(session.sessionId, id), undefined);
  const result = { ok: true, value: { changed: true } };
  store.remember(session.sessionId, id, result);
  assert.deepEqual(store.replay(session.sessionId, id), result);
});

test("confirmation is bound to session, exact command, canonical args hash and one use", () => {
  let now = 1_000;
  const store = createPanelSessionStore({ clock: () => now, randomBytes: sequenceRandomBytes() });
  const session = store.consumeNonce(store.mintNonce().nonce);
  const args = { z: 1, a: "x" };
  const hash = canonicalArgumentsHash(args);
  const minted = store.mintConfirmation(session.sessionId, "maintenance.update", hash);
  assert.equal(Buffer.from(minted.token, "base64url").length, 32);
  assert.equal(store.consumeConfirmation(session.sessionId, minted.token, "maintenance.update", hash), true);
  assert.equal(store.consumeConfirmation(session.sessionId, minted.token, "maintenance.update", hash), false);
  const mismatch = store.mintConfirmation(session.sessionId, "maintenance.update", hash);
  assert.equal(store.consumeConfirmation(session.sessionId, mismatch.token, "maintenance.rollback", hash), false);
  now += 60_001;
  assert.equal(store.consumeConfirmation(session.sessionId, mismatch.token, "maintenance.update", hash), false);
});

test("panel request validation checks peer, host, origin, method and JSON before session state", () => {
  const policy = { port: 4202, mutation: true };
  assert.deepEqual(validatePanelRequest(request(), policy).requestId, "11111111-1111-4111-8111-111111111111");
  assert.throws(() => validatePanelRequest(request({ socket: { remoteAddress: "192.0.2.1" } }), policy), /loopback/i);
  assert.throws(() => validatePanelRequest(request({ headers: { ...request().headers, host: "localhost:4202" } }), policy), /host/i);
  assert.throws(() => validatePanelRequest(request({ headers: { ...request().headers, origin: "http://localhost:4202" } }), policy), /origin/i);
  assert.throws(() => validatePanelRequest(request({ method: "GET" }), policy), /method/i);
  assert.throws(() => validatePanelRequest(request({ headers: { ...request().headers, "content-type": "text/plain" } }), policy), /json/i);
  assert.throws(() => validatePanelRequest(request({ headers: { ...request().headers, origin: undefined } }), policy), /origin/i);
});

test("concurrent reservation shares one in-flight result", async () => {
  const store = createPanelSessionStore({ randomBytes: sequenceRandomBytes() });
  const session = store.consumeNonce(store.mintNonce().nonce);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const first = store.reserve(session.sessionId, requestId);
  const second = store.reserve(session.sessionId, requestId);
  assert.equal(first.status, "reserved");
  assert.equal(second.status, "in-flight");
  const result = { status: 204, payload: {} };
  first.complete(result);
  assert.deepEqual(await second.promise, result);
  assert.deepEqual(store.reserve(session.sessionId, requestId).result, result);
});

test("confirmation hashing uses shared JCS and rejects hostile values", () => {
  const args = { z: 1, a: "x" };
  const expected = createHash("sha256").update(jcsBytes(args)).digest("base64url");
  assert.equal(canonicalArgumentsHash(args), expected);
  const hostile = {};
  Object.defineProperty(hostile, "secret", { enumerable: true, get() { throw new Error("getter"); } });
  assert.throws(() => canonicalArgumentsHash(hostile), /JCS|canonical/i);
  assert.throws(() => canonicalArgumentsHash("\ud800"), /JCS|surrogate/i);
});

test("logout keeps an idempotent tombstone for the completed request", () => {
  const store = createPanelSessionStore({ randomBytes: sequenceRandomBytes() });
  const session = store.consumeNonce(store.mintNonce().nonce);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const result = { status: 204, payload: {} };
  store.remember(session.sessionId, requestId, result);
  store.logout(session.sessionId, requestId);
  const replay = store.reserve(session.sessionId, requestId);
  assert.equal(replay.status, "completed");
  assert.deepEqual(replay.result, result);
});

test("random token collisions resample and fail closed without deterministic derivation", () => {
  let calls = 0;
  const store = createPanelSessionStore({ randomBytes: (size) => { calls += 1; return Buffer.alloc(size, 0x77); } });
  assert.throws(() => store.consumeNonce(store.mintNonce().nonce), /collision|allocate/i);
  assert.ok(calls >= 17);
});

test("logout tombstones expire and never replay after a long clock jump", () => {
  let now = 1_000;
  const store = createPanelSessionStore({ clock: () => now, randomBytes: sequenceRandomBytes() });
  const session = store.consumeNonce(store.mintNonce().nonce);
  const requestId = "55555555-5555-4555-8555-555555555555";
  store.remember(session.sessionId, requestId, { status: 204, payload: {} });
  store.logout(session.sessionId);
  now += 2 * 60 * 60_000;
  assert.equal(store.reserve(session.sessionId, requestId).status, "invalid");
});
