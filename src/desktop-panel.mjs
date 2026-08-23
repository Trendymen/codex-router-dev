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
  [
    "/panel/thinking-orb.mjs",
    { file: "thinking-orb.mjs", type: "text/javascript; charset=utf-8" },
  ],
]);

// app.js reaches its backend through window.__TAURI__.core.invoke and nothing
// else, so presenting that one function is the whole port. Injected rather
// than shipped as a file in apps/desktop/ui, because that directory belongs to
// the shells that load it from disk.
const BRIDGE = `<script>
let __panelCsrf;
async function __panelCsrfToken() {
  if (!__panelCsrf) __panelCsrf = fetch("./session", { credentials: "same-origin" }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || "The panel session is unavailable.");
    return payload.csrfToken;
  });
  return __panelCsrf;
}
window.__TAURI__ = {
  core: {
    invoke: async (command, args) => {
      const csrfToken = await __panelCsrfToken();
      const response = await fetch("./invoke", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken, "x-request-id": crypto.randomUUID() },
        body: JSON.stringify({ command, args: args || {} }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "The router command failed.");
      return payload.value;
    },
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

// Read commands remain available to the legacy direct handler used by the
// embedded shell tests. A browser request routed through the session gate uses
// the full canonical table only after cookie, CSRF, replay, and confirmation
// validation have completed.
const CANONICAL_PANEL_COMMANDS = new Set([
  "lifecycle.status",
  "native.account-usage",
  "usage.provider",
  "credential.status",
  "catalog.render-snippet",
  "cc-switch.snippet",
]);

export function panelCommandAllowed(command, { readOnly = true } = {}) {
  if (readOnly) return CANONICAL_PANEL_COMMANDS.has(command);
  return desktopCommandDefinitions().has(command);
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
    // What this surface will and will not run, said out loud. The UI could
    // infer it from `shell`, but then two places would encode the same policy
    // and only one of them is the gate. Both lists are the real ones -- a
    // command in neither is precisely what /panel/invoke answers 403 for -- so
    // a control the UI leaves live cannot disagree with what the panel permits.
    // The tray and the Electron shell advertise nothing here and keep the full
    // table, which is why this field is additive rather than a mode switch.
    capabilities: {
      readOnly: true,
      allowedCommands: [...CANONICAL_PANEL_COMMANDS],
      localCommands: Object.keys(LOCAL),
    },
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
  if (result?.ok !== false) return { status: 200, payload: { value: result?.ok === true ? result.value : result } };
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

  if (secured && (route === "/panel/logout" || route === "/panel/confirmations" || route === "/panel/invoke")) {
    let reservation;
    let commandPhase = false;
    let logoutSessionId;
    try {
      const context = mutationContext(request, policy, sessionStore);
      logoutSessionId = route === "/panel/logout" ? context.sessionId : undefined;
      commandPhase = true;
      let body;
      try {
        body = JSON.parse(await readBody(request) || "{}");
      } catch {
        throw Object.assign(new Error("The panel request was not valid JSON."), { code: "invalid_command_arguments" });
      }
      const operationCommand = route === "/panel/logout" ? "panel.logout" : body?.command;
      const operationArgsHash = route === "/panel/confirmations"
        ? (typeof body.argumentsHash === "string" ? body.argumentsHash : canonicalArgumentsHash(body.args ?? {}))
        : canonicalArgumentsHash(body?.args ?? {});
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
        sendStoredResult(response, writeJson, reservation.result, { logout: route === "/panel/logout" });
        return true;
      }
      if (reservation.status === "in-flight") {
        sendStoredResult(response, writeJson, await reservation.promise, { logout: route === "/panel/logout" });
        return true;
      }
      if (reservation.status === "mismatch") throw Object.assign(new Error("The request ID was already used for another operation."), { code: "panel_confirmation_required" });
      if (reservation.status !== "reserved") throw Object.assign(new Error("The panel write session is missing or expired."), { code: "panel_auth_required" });
      if (route === "/panel/logout") {
        const result = { status: 204, payload: {} };
        sessionStore.logout(context.sessionId, context.requestId);
        reservation.complete(result);
        sendStoredResult(response, writeJson, result, { logout: true });
        return true;
      }
      if (route === "/panel/confirmations") {
        const command = body?.command;
        const definition = desktopCommandDefinitions().get(command);
        if (!definition?.confirmation) throw Object.assign(new Error("confirmation required"), { code: "panel_confirmation_invalid" });
        const hash = typeof body.argumentsHash === "string" ? body.argumentsHash : canonicalArgumentsHash(body.args ?? {});
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
      if (logoutSessionId && reservation?.status !== "mismatch") sessionStore.logout(logoutSessionId, undefined);
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

  if (route !== "/panel/invoke") return false;
  if (request.method !== "POST") {
    applyHeaders(response);
    writeJson(response, 405, { error: { type: "invalid_request", message: "Use POST." } });
    return true;
  }

  let command;
  let args;
  try {
    ({ command, args } = JSON.parse(await readBody(request)) || {});
  } catch {
    applyHeaders(response);
    writeJson(response, 400, {
      error: { type: "invalid_request", message: "The panel request was not valid JSON." },
    });
    return true;
  }

  const local = panelLocalCommand(command);
  if (local) {
    writeJson(response, 200, { value: local() });
    return true;
  }

  if (!panelCommandAllowed(command)) {
    applyHeaders(response);
    writeJson(response, 403, {
      error: {
        type: "invalid_request",
        message: `${command} is not available from the browser panel.`,
      },
    });
    return true;
  }

  try {
    const canonicalArgs = command === "usage.provider" && !args?.provider ? {} : args ?? {};
    const definition = desktopCommandDefinitions().get(command);
    if (!definition) {
      applyHeaders(response);
      writeJson(response, 403, { error: { type: "invalid_request", message: `${command} is not available from the browser panel.` } });
      return true;
    }
    // This handler is reached only after router.mjs has stripped and verified
    // the caller-capability path.  The trusted Symbol is constructed here;
    // `args` can never select or forge the protected channel.
    const context = definition.resultKind === "protected-text"
      ? trustedProtectedContext({ root })
      : { root };
    const result = await runCommand(command, canonicalArgs, context);
    if (result?.ok === false) {
      applyHeaders(response);
      writeJson(response, 502, { error: result.error });
      return true;
    }
    applyHeaders(response);
    writeJson(response, 200, {
      value: result?.ok === true ? result.value : result,
      ...(result?.meta?.protected ? { meta: result.meta } : {}),
    });
  } catch (error) {
    applyHeaders(response);
    writeJson(response, 502, {
      error: { type: "upstream_error", message: error?.message || "The router command failed." },
    });
  }
  return true;
}
