import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import { jcsBytes } from "./jcs.mjs";

export const BOOTSTRAP_NONCE_TTL_MS = 30_000;
export const SESSION_IDLE_TTL_MS = 15 * 60_000;
export const SESSION_ABSOLUTE_TTL_MS = 60 * 60_000;
export const CONFIRMATION_TTL_MS = 60_000;
export const DEFAULT_MAX_SESSIONS = 8;
export const MAX_REPLAY_ENTRIES = 64;
export const TOMBSTONE_TTL_MS = BOOTSTRAP_NONCE_TTL_MS;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_BYTES = 32;

function nowFrom(clock) {
  if (typeof clock === "function") return clock();
  if (clock && typeof clock.now === "function") return clock.now();
  return Date.now();
}

function token(randomBytes) {
  const value = randomBytes(TOKEN_BYTES);
  if (!Buffer.isBuffer(value) || value.length !== TOKEN_BYTES) {
    throw new TypeError("panel security random source must return 32 bytes");
  }
  return value.toString("base64url");
}

function sameSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function canonicalArgumentsHash(args) {
  return createHash("sha256").update(jcsBytes(args)).digest("base64url");
}

export function operationFingerprint({ sessionId, requestId, method, route, command, argsHash }) {
  return createHash("sha256").update(jcsBytes({ sessionId, requestId, method, route, command, argsHash })).digest("base64url");
}

function error(code, message) {
  const result = new Error(message);
  result.code = code;
  return result;
}

function monotonicClock(clock) {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const current = Number(nowFrom(clock));
    const value = Number.isFinite(current) ? Math.max(last, current) : Math.max(last, Date.now());
    last = value;
    return value;
  };
}

function validToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value) && Buffer.from(value, "base64url").length === TOKEN_BYTES;
}

export function createPanelSessionStore({
  clock,
  randomBytes = cryptoRandomBytes,
  maxSessions = DEFAULT_MAX_SESSIONS,
} = {}) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64) {
    throw new RangeError("maxSessions must be between 1 and 64");
  }
  const now = monotonicClock(clock);
  const nonces = new Map();
  const sessions = new Map();
  const logoutTombstones = new Map();

  function uniqueToken(collection) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const value = token(randomBytes);
      if (!collection.has(value)) return value;
    }
    throw error("panel_entropy_collision", "could not allocate a unique panel security token");
  }

  function purgeExpired(at = now()) {
    for (const [value, entry] of nonces) if (entry.expiresAt <= at || entry.used) nonces.delete(value);
    for (const [id, session] of sessions) {
      if (session.revoked || session.lastUsedAt + SESSION_IDLE_TTL_MS <= at || session.createdAt + SESSION_ABSOLUTE_TTL_MS <= at) {
        sessions.delete(id);
      }
    }
    for (const [fingerprint, tombstone] of logoutTombstones) {
      if (tombstone.expiresAt <= at) logoutTombstones.delete(fingerprint);
    }
    while (logoutTombstones.size > 64) logoutTombstones.delete(logoutTombstones.keys().next().value);
  }

  function mintNonce() {
    const at = now();
    purgeExpired(at);
    const nonce = uniqueToken(nonces);
    nonces.set(nonce, { expiresAt: at + BOOTSTRAP_NONCE_TTL_MS, used: false });
    return { nonce, expiresAt: at + BOOTSTRAP_NONCE_TTL_MS };
  }

  function consumeNonce(nonce) {
    const at = now();
    const entry = nonces.get(nonce);
    if (!entry || entry.used) throw error("panel_nonce_invalid", "The panel bootstrap nonce is invalid or already used.");
    entry.used = true;
    nonces.delete(nonce);
    if (entry.expiresAt <= at) throw error("panel_nonce_expired", "The panel bootstrap nonce has expired.");
    purgeExpired(at);
    if (sessions.size >= maxSessions) {
      const oldest = [...sessions.entries()].sort(([, left], [, right]) =>
        left.lastUsedAt - right.lastUsedAt || left.createdAt - right.createdAt,
      )[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    const sessionId = uniqueToken(sessions);
    const csrfToken = uniqueToken(new Map([...sessions.keys(), sessionId].map((id) => [id, true])));
    sessions.set(sessionId, {
      sessionId,
      csrfToken,
      createdAt: at,
      lastUsedAt: at,
      replay: new Map(),
      inFlight: new Map(),
      confirmations: new Map(),
      revoked: false,
    });
    return { sessionId, csrfToken };
  }

  function getSession(sessionId, { touch = false } = {}) {
    const at = now();
    purgeExpired(at);
    const session = sessions.get(sessionId);
    if (!session || session.revoked) return { valid: false };
    if (touch) session.lastUsedAt = at;
    return { valid: true, session };
  }

  function touchSession(sessionId) {
    const result = getSession(sessionId, { touch: true });
    if (!result.valid) throw error("panel_auth_required", "The panel write session is missing or expired.");
    return result.session;
  }

  function logout(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.revoked = true;
    sessions.delete(sessionId);
  }

  function revokeForLogout(sessionId, csrfToken, requestId, fingerprint) {
    const at = now();
    purgeExpired(at);
    const active = sessions.get(sessionId);
    if (active) {
      if (!sameSecret(active.csrfToken, csrfToken)) return { status: "invalid" };
      active.revoked = true;
      sessions.delete(sessionId);
      const result = { status: 204, payload: {} };
      logoutTombstones.set(fingerprint, {
        sessionId,
        csrfToken: active.csrfToken,
        requestId,
        result,
        expiresAt: at + TOMBSTONE_TTL_MS,
      });
      while (logoutTombstones.size > 64) logoutTombstones.delete(logoutTombstones.keys().next().value);
      return { status: "completed", result };
    }
    const tombstone = logoutTombstones.get(fingerprint);
    return tombstone && tombstone.sessionId === sessionId && tombstone.requestId === requestId && sameSecret(tombstone.csrfToken, csrfToken)
      ? { status: "completed", result: tombstone.result }
      : { status: "invalid" };
  }

  function revokeAll() {
    sessions.clear();
    nonces.clear();
    logoutTombstones.clear();
  }

  function replay(sessionId, requestId) {
    const session = getSession(sessionId).session;
    const entry = session?.replay.get(requestId);
    return entry?.result ?? entry;
  }

  function remember(sessionId, requestId, result) {
    const session = touchSession(sessionId);
    session.replay.set(requestId, { result, fingerprint: undefined });
    while (session.replay.size > MAX_REPLAY_ENTRIES) session.replay.delete(session.replay.keys().next().value);
  }

  function reserve(sessionId, requestId, fingerprint) {
    const active = getSession(sessionId, { touch: true }).session;
    if (!active) return { status: "invalid" };
    const completed = active.replay.get(requestId);
    if (completed) return completed.fingerprint === fingerprint ? { status: "completed", result: completed.result } : { status: "mismatch" };
    const running = active.inFlight.get(requestId);
    if (running) return running.fingerprint === fingerprint ? { status: "in-flight", promise: running.promise } : { status: "mismatch" };
    let resolve;
    let settled = false;
    const promise = new Promise((done) => { resolve = done; });
    const reservation = {
      status: "reserved",
      promise,
      complete(result) {
        if (settled) return;
        settled = true;
        active.inFlight.delete(requestId);
        active.replay.set(requestId, { result, fingerprint });
        while (active.replay.size > MAX_REPLAY_ENTRIES) active.replay.delete(active.replay.keys().next().value);
        resolve(result);
      },
    };
    active.inFlight.set(requestId, { promise, reservation, fingerprint });
    return reservation;
  }

  function mutationSession(sessionId, csrfToken, requestId) {
    const active = getSession(sessionId, { touch: true }).session;
    if (active) return sameSecret(active.csrfToken, csrfToken) ? { valid: true, session: active } : { valid: false };
    return { valid: false };
  }

  function mintConfirmation(sessionId, command, argumentsHash) {
    const session = touchSession(sessionId);
    if (typeof command !== "string" || !command || typeof argumentsHash !== "string" || !argumentsHash) {
      throw error("panel_confirmation_invalid", "The confirmation request is invalid.");
    }
    const confirmation = uniqueToken(session.confirmations);
    const expiresAt = now() + CONFIRMATION_TTL_MS;
    session.confirmations.set(confirmation, { command, argumentsHash, expiresAt });
    return { token: confirmation, expiresAt };
  }

  function consumeConfirmation(sessionId, confirmation, command, argumentsHash) {
    const session = getSession(sessionId).session;
    if (!session || !validToken(confirmation)) return false;
    const entry = session.confirmations.get(confirmation);
    if (!entry) return false;
    session.confirmations.delete(confirmation);
    const valid = entry.expiresAt > now() && sameSecret(entry.command, command) && sameSecret(entry.argumentsHash, argumentsHash);
    return valid;
  }

  return Object.freeze({
    mintNonce,
    consumeNonce,
    getSession,
    touchSession,
    logout,
    revokeForLogout,
    revokeAll,
    replay,
    remember,
    reserve,
    mutationSession,
    mintConfirmation,
    consumeConfirmation,
  });
}

export function mintBootstrapNonce(store) {
  return store.mintNonce();
}

export function consumeBootstrapNonce(store, nonce) {
  return store.consumeNonce(nonce);
}

function header(request, name) {
  const headers = request?.headers || {};
  const key = name.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() === key) return Array.isArray(value) ? value.length === 1 ? value[0] : undefined : value;
  }
  return undefined;
}

export function parsePanelCookie(value) {
  if (typeof value !== "string") return undefined;
  const matches = value.split(";").map((part) => part.trim()).filter((part) => part.startsWith("panel_session="));
  if (matches.length !== 1) return undefined;
  const sessionId = matches[0].slice("panel_session=".length);
  return validToken(sessionId) ? sessionId : undefined;
}

function loopbackPeer(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function validatePanelRequest(request, { port, mutation = false, method, requireRequestId = mutation, json = mutation } = {}) {
  if (!loopbackPeer(request?.socket?.remoteAddress)) throw error("panel_peer_invalid", "The panel request must come from loopback.");
  const expectedHost = `127.0.0.1:${Number(port)}`;
  if (header(request, "host") !== expectedHost) throw error("panel_host_invalid", "The panel Host is invalid.");
  if (mutation && header(request, "origin") !== `http://${expectedHost}`) throw error("panel_origin_invalid", "The panel Origin is invalid.");
  const expectedMethod = method || (mutation ? "POST" : "GET");
  if (request?.method !== expectedMethod) throw error("panel_method_invalid", `The panel method must be ${expectedMethod}.`);
  if (json && String(header(request, "content-type") || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw error("panel_content_type_invalid", "Panel mutations require application/json.");
  }
  const sessionId = parsePanelCookie(header(request, "cookie"));
  if (mutation && !sessionId) throw error("panel_auth_required", "The panel write session is missing or expired.");
  const csrfToken = header(request, "x-csrf-token");
  if (mutation && (!validToken(csrfToken) || !sessionId)) throw error("panel_csrf_invalid", "The panel mutation proof is invalid.");
  const requestId = header(request, "x-request-id");
  if (requireRequestId && !UUID_V4.test(String(requestId || ""))) throw error("panel_request_id_invalid", "The panel request ID is invalid.");
  return { sessionId, csrfToken, requestId };
}

export function panelSecurityHeaders({ staticAsset = false } = {}) {
  return {
    "cache-control": staticAsset ? "no-cache" : "no-store",
    ...(staticAsset ? {} : { pragma: "no-cache" }),
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  };
}

export const PANEL_SESSION_COOKIE = "HttpOnly; SameSite=Strict; Path=/panel";
export const EXPIRED_PANEL_SESSION_COOKIE = "panel_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/panel";
