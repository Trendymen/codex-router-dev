// The companion, served by the router that is already running, so looking at
// it costs nothing to install. The tray and the Electron shell each need a
// binary to be built, published, downloaded and kept current; this needs a
// browser and the router you already started.
//
// It is the same apps/desktop/ui those shells render, reached through the same
// command table, so it is a third window onto one application rather than a
// third application.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { desktopCommandDefinitions, runDesktopCommand, sourceRoot, trustedProtectedContext } from "./desktop-commands.mjs";
import { buildCapabilityManifest } from "./capability-manifest.mjs";
import {
  canonicalArgumentsHash,
  createPanelSessionStore,
  EXPIRED_PANEL_SESSION_COOKIE,
  PANEL_SESSION_COOKIE,
  operationFingerprint,
  panelSecurityHeaders,
  parsePanelCookie,
  validatePanelRequest,
} from "./panel-sessions.mjs";
import { ERROR_DEFINITIONS, routerError } from "./public-error.mjs";

const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "desktop",
  "ui",
);

// Only what the UI is built from. A directory served wholesale would follow
// whatever else ever lands in it, and this route sits behind a capability that
// is worth more than the convenience.
const ASSETS = new Map([
  ["/panel/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/panel/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/panel/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/panel/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/panel/model.mjs", { file: "model.mjs", type: "text/javascript; charset=utf-8" }],
  ["/panel/i18n.mjs", { file: "i18n.mjs", type: "text/javascript; charset=utf-8" }],
  [
    "/panel/thinking-orb.mjs",
    { file: "thinking-orb.mjs", type: "text/javascript; charset=utf-8" },
  ],
]);

// app.js reaches its backend through window.__TAURI__.core.invoke and nothing
// else, so presenting that one function is the whole port. Injected rather
// than shipped as a file in apps/desktop/ui, because that directory belongs to
// the shells that load it from disk.
const PANEL_MANIFEST = buildCapabilityManifest();
const PANEL_MANIFEST_JSON = JSON.stringify(PANEL_MANIFEST).replaceAll("<", "\\u003c");
const BRIDGE = `<script>
window.__CODEX_ROUTER_PANEL__ = true;
window.__CODEX_ROUTER_MANIFEST__ = ${PANEL_MANIFEST_JSON};
let __panelCsrf;
const __panelResults = new Map();
const __panelInFlight = new Map();
const __panelCommandMetadata = new Map((window.__CODEX_ROUTER_MANIFEST__.commands || []).map((item) => [item.name, item]));
async function __panelCsrfToken() {
  if (!__panelCsrf) __panelCsrf = fetch("./session", { credentials: "same-origin" }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || "The panel session is unavailable.");
    if (typeof payload.csrfToken !== "string") throw new Error("The panel session is unavailable.");
    return payload.csrfToken;
  });
  return __panelCsrf;
}
function __panelRequestId() {
  if (!globalThis.crypto?.randomUUID) throw new Error("The browser does not provide request UUIDs.");
  return globalThis.crypto.randomUUID();
}
async function __panelJson(path, { requestId, confirmationToken, body } = {}) {
  const csrfToken = await __panelCsrfToken();
  const headers = {
    "content-type": "application/json",
    "x-csrf-token": csrfToken,
    "x-request-id": requestId,
  };
  if (confirmationToken) headers["x-confirmation-token"] = confirmationToken;
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "The router command failed.");
      return payload;
    } catch (error) {
      if (attempt++ >= 1) throw error;
      // A transport/timeout retry keeps the same request UUID, so the server
      // either completes once or returns its bounded replay result.
    }
  }
}
async function __panelInvoke(command, args, operation = {}) {
  const operationId = operation.operationId || __panelRequestId();
  const requestId = operation.requestId || operationId;
  if (__panelResults.has(operationId)) return __panelResults.get(operationId);
  if (__panelInFlight.has(operationId)) return __panelInFlight.get(operationId);
  const promise = (async () => {
    const metadata = __panelCommandMetadata.get(command);
    let confirmationToken;
    if (metadata?.confirmation) {
      const confirmation = await __panelJson("./confirmations", {
        requestId: operation.confirmationRequestId || __panelRequestId(),
        body: { command, args: args || {}, argumentsHash: operation.argumentsHash },
      });
      confirmationToken = confirmation.token;
    }
    const payload = await __panelJson("./invoke", {
      requestId,
      confirmationToken,
      body: { command, args: args || {} },
    });
    return payload.value;
  })();
  __panelInFlight.set(operationId, promise);
  try {
    const result = await promise;
    __panelResults.set(operationId, result);
    while (__panelResults.size > 64) __panelResults.delete(__panelResults.keys().next().value);
    return result;
  } finally {
    __panelInFlight.delete(operationId);
  }
}
window.__TAURI__ = {
  core: {
    invoke: __panelInvoke,
  },
};
</script>
`;
const BRIDGE_CSP_HASH = createHash("sha256").update(BRIDGE.slice(BRIDGE.indexOf("<script>") + 8, BRIDGE.lastIndexOf("</script>")), "utf8").digest("base64");

export function isPanelRoute(route) {
  return (
    route === "/panel" ||
    ASSETS.has(route) ||
    route === "/panel/invoke" ||
    route === "/panel/favicon.ico" ||
    route === "/panel/session" ||
    route === "/panel/logout" ||
    route === "/panel/confirmations" ||
    /^\/panel-bootstrap\/[A-Za-z0-9_-]+$/.test(route)
  );
}

// Commands the shells answer from their own process rather than the CLI. A
// browser tab has no window to show, hide or quit and cannot float an overlay
// above other applications, so those resolve to the honest answer instead of
// failing: the UI asks for them on load and would otherwise paint an error
// over a panel that is working.
const LOCAL = {
  platform_info: () => ({
    platform: process.platform,
    island: false,
    shell: "web",
    // The browser renders only this manifest. It never infers support from the
    // host name or keeps an allowlist of its own.
    capabilityManifest: PANEL_MANIFEST,
  }),
  desktop_settings: () => ({ islandEnabled: false, islandExpanded: false }),
  // The router is answering this request, so it is by definition reachable.
  router_health: () => ({ ok: true, service: "codex-router", status: "ok" }),
  set_island_enabled: () => ({ islandEnabled: false, islandExpanded: false }),
  set_island_expanded: () => ({ islandEnabled: false, islandExpanded: false }),
  show_panel: () => null,
  hide_panel: () => null,
  quit_app: () => null,
};

export function panelLocalCommand(command) {
  return Object.hasOwn(LOCAL, command) ? LOCAL[command] : undefined;
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("The panel request was too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const DEFAULT_SESSION_STORE = createPanelSessionStore();

function publicPanelError(error, fallback = "panel_auth_required") {
  const candidate = typeof error?.code === "string" ? error.code : fallback;
  const code = Object.hasOwn(ERROR_DEFINITIONS, candidate)
    ? candidate
    : candidate === "panel_confirmation_invalid" ? "panel_confirmation_required"
      : candidate === "panel_csrf_invalid" ? "panel_csrf_invalid"
        : "panel_auth_required";
  return routerError(code);
}

function applyHeaders(response, options = {}) {
  for (const [name, value] of Object.entries(panelSecurityHeaders(options))) response.setHeader(name, value);
}

function sendStoredResult(response, writeJson, result, { logout = false } = {}) {
  applyHeaders(response);
  if (logout) response.setHeader("set-cookie", EXPIRED_PANEL_SESSION_COOKIE);
  if (result.status === 204) {
    response.writeHead(204);
    response.end();
  } else {
    writeJson(response, result.status, result.payload);
  }
}

function commandResult(result) {
  if (result?.ok !== false) {
    const payload = { value: result?.ok === true ? result.value : result };
    if (result?.meta?.protected === true) payload.meta = result.meta;
    return { status: 200, payload };
  }
  const code = result?.error?.code;
  const safe = Object.hasOwn(ERROR_DEFINITIONS, code) ? routerError(code) : routerError("invalid_command_arguments");
  return { status: safe.status, payload: safe.body };
}

function mutationContext(request, policy, sessionStore) {
  const context = validatePanelRequest(request, { ...policy, mutation: true });
  const session = sessionStore.mutationSession(context.sessionId, context.csrfToken, context.requestId);
  if (!session.valid) {
    const invalid = new Error("The panel mutation proof is invalid.");
    invalid.code = sessionStore.getSession(context.sessionId).valid ? "panel_csrf_invalid" : "panel_auth_required";
    throw invalid;
  }
  return { ...context, tombstone: Boolean(session.tombstone) };
}

export async function handlePanelRequest(request, response, route, {
  writeJson,
  runCommand = runDesktopCommand,
  root = sourceRoot(),
  policy,
  sessionStore = DEFAULT_SESSION_STORE,
}) {
  const secured = Boolean(policy);
  const fail = (error) => {
    const result = publicPanelError(error);
    applyHeaders(response);
    writeJson(response, result.status, result.body);
    return true;
  };

  if (secured && !/^\/panel-bootstrap\//.test(route) && route !== "/panel-session" && route !== "/panel/session" && route !== "/panel/logout" && route !== "/panel/confirmations" && route !== "/panel/invoke") {
    try {
      validatePanelRequest(request, { ...policy, mutation: false, method: request.method === "HEAD" ? "HEAD" : "GET", requireRequestId: false });
      const sessionId = parsePanelCookie(request.headers?.cookie);
      if (!sessionStore.getSession(sessionId).valid) throw Object.assign(new Error("The panel write session is missing or expired."), { code: "panel_auth_required" });
    } catch (error) {
      return fail(error);
    }
  }

  if (secured && /^\/panel-bootstrap\//.test(route)) {
    try {
      const context = validatePanelRequest(request, { ...policy, mutation: false, method: "GET", requireRequestId: false });
      const nonce = route.slice("/panel-bootstrap/".length);
      const { sessionId } = sessionStore.consumeNonce(nonce);
      applyHeaders(response);
      response.setHeader("set-cookie", `panel_session=${sessionId}; ${PANEL_SESSION_COOKIE}`);
      response.writeHead(303, { location: "/panel/" });
      response.end();
      return true;
    } catch (error) {
      return fail(error);
    }
  }

  if (secured && route === "/panel/session") {
    try {
      const context = validatePanelRequest(request, { ...policy, mutation: false, method: "GET", requireRequestId: false });
      const sessionId = parsePanelCookie(request.headers?.cookie);
      const session = sessionStore.getSession(sessionId, { touch: true });
      if (!session.valid) throw Object.assign(new Error("The panel write session is missing or expired."), { code: "panel_auth_required" });
      applyHeaders(response);
      writeJson(response, 200, { csrfToken: session.session.csrfToken });
      return true;
    } catch (error) {
      return fail(error);
    }
  }

  if (secured && route === "/panel/logout") {
    try {
      const context = validatePanelRequest(request, { ...policy, mutation: true });
      const fingerprint = operationFingerprint({
        sessionId: context.sessionId,
        requestId: context.requestId,
        method: request.method,
        route,
        command: "panel.logout",
        argsHash: canonicalArgumentsHash({}),
      });
      const completed = sessionStore.revokeForLogout(
        context.sessionId,
        context.csrfToken,
        context.requestId,
        fingerprint,
      );
      if (completed.status !== "completed") {
        throw Object.assign(new Error("The panel write session is missing or expired."), { code: "panel_auth_required" });
      }
      sendStoredResult(response, writeJson, completed.result, { logout: true });
      return true;
    } catch (error) {
      return fail(error);
    }
  }

  if (secured && (route === "/panel/confirmations" || route === "/panel/invoke")) {
    let reservation;
    let commandPhase = false;
    try {
      const context = mutationContext(request, policy, sessionStore);
      commandPhase = true;
      let body;
      try {
        body = JSON.parse(await readBody(request) || "{}");
      } catch {
        throw Object.assign(new Error("The panel request was not valid JSON."), { code: "invalid_command_arguments" });
      }
      const operationCommand = body?.command;
      const computedArgumentsHash = canonicalArgumentsHash(body?.args ?? {});
      if (route === "/panel/confirmations" && body.argumentsHash !== undefined && body.argumentsHash !== computedArgumentsHash) {
        throw Object.assign(new Error("The confirmation argument hash does not match the supplied arguments."), { code: "panel_confirmation_invalid" });
      }
      const operationArgsHash = computedArgumentsHash;
      const fingerprint = operationFingerprint({
        sessionId: context.sessionId,
        requestId: context.requestId,
        method: request.method,
        route,
        command: operationCommand,
        argsHash: operationArgsHash,
      });
      reservation = sessionStore.reserve(context.sessionId, context.requestId, fingerprint);
      if (reservation.status === "completed") {
        sendStoredResult(response, writeJson, reservation.result);
        return true;
      }
      if (reservation.status === "in-flight") {
        sendStoredResult(response, writeJson, await reservation.promise);
        return true;
      }
      if (reservation.status === "mismatch") throw Object.assign(new Error("The request ID was already used for another operation."), { code: "panel_confirmation_required" });
      if (reservation.status !== "reserved") throw Object.assign(new Error("The panel write session is missing or expired."), { code: "panel_auth_required" });
      if (route === "/panel/confirmations") {
        const command = body?.command;
        const definition = desktopCommandDefinitions().get(command);
        if (!definition?.confirmation) throw Object.assign(new Error("confirmation required"), { code: "panel_confirmation_invalid" });
        const hash = computedArgumentsHash;
        if (!/^[A-Za-z0-9_-]{43}$/.test(hash)) throw Object.assign(new Error("invalid argument hash"), { code: "invalid_command_arguments" });
        const confirmation = sessionStore.mintConfirmation(context.sessionId, command, hash);
        const result = { status: 200, payload: confirmation };
        reservation.complete(result);
        sendStoredResult(response, writeJson, result);
        return true;
      }
      const { command, args } = body || {};
      const local = panelLocalCommand(command);
      if (local) {
        const result = { status: 200, payload: { value: local() } };
        reservation.complete(result);
        sendStoredResult(response, writeJson, result);
        return true;
      }
      const definition = desktopCommandDefinitions().get(command);
      const protectedInput = definition?.protectedInput && typeof args?.apiKey === "string" ? args.apiKey : undefined;
      const canonicalArgs = definition?.protectedInput
        ? { provider: args?.provider }
        : command === "usage.provider" && !args?.provider ? {} : args ?? {};
      if (definition?.confirmation) {
        const confirmation = request.headers?.["x-confirmation-token"];
        const hash = canonicalArgumentsHash(canonicalArgs);
        if (!sessionStore.consumeConfirmation(context.sessionId, confirmation, command, hash)) {
          throw Object.assign(new Error("confirmation required"), { code: "panel_confirmation_required" });
        }
      }
      const commandContext = definition?.protectedInput
        ? { root, protectedInput: async () => protectedInput }
        : definition?.resultKind === "protected-text" ? trustedProtectedContext({ root }) : { root };
      const result = definition ? await runCommand(command, canonicalArgs, commandContext) : await runDesktopCommand(command, canonicalArgs, {});
      const completed = commandResult(result);
      reservation.complete(completed);
      sendStoredResult(response, writeJson, completed);
      return true;
    } catch (error) {
      const safe = publicPanelError(error, commandPhase ? "invalid_command_arguments" : "panel_auth_required");
      const completed = { status: safe.status, payload: safe.body };
      if (reservation?.status === "reserved") reservation.complete(completed);
      sendStoredResult(response, writeJson, completed);
      return true;
    }
  }

  // index.html loads styles.css and app.js relatively. Served at "/panel" the
  // browser resolves those one level too high and the page renders empty, so
  // the directory form is the canonical one and the bare name redirects to it.
  if (route === "/panel") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(response, 405, { error: { type: "invalid_request", message: "Use GET." } });
      return true;
    }
    applyHeaders(response);
    response.writeHead(302, { location: "./panel/" });
    response.end();
    return true;
  }

  // Browsers ask for this unprompted; answering keeps a console clean enough
  // that a real error still stands out in it.
  if (route === "/panel/favicon.ico") {
    const icon = path.resolve(UI_DIR, "..", "src-tauri", "icons", "32x32.png");
    try {
      const body = await readFile(icon);
      applyHeaders(response, { staticAsset: true });
      response.setHeader("content-type", "image/png");
      response.writeHead(200);
      response.end(body);
    } catch {
      applyHeaders(response, { staticAsset: true });
      response.writeHead(204).end();
    }
    return true;
  }

  const asset = ASSETS.get(route);
  if (asset) {
    if (request.method !== "GET") {
      applyHeaders(response, { staticAsset: true });
      writeJson(response, 405, { error: { type: "invalid_request", message: "Use GET." } });
      return true;
    }
    let body = await readFile(path.join(UI_DIR, asset.file), "utf8");
    if (asset.file === "index.html") body = body.replace("<head>", `<head>\n${BRIDGE}`);
    applyHeaders(response, { staticAsset: true });
    response.setHeader("content-security-policy", `default-src 'self'; script-src 'self' 'sha256-${BRIDGE_CSP_HASH}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`);
    response.setHeader("content-type", asset.type);
    response.writeHead(200);
    response.end(body);
    return true;
  }

  // A panel invocation without a write-session policy is a configuration bug,
  // not a legacy compatibility path. The router always supplies `policy`.
  return false;
}
