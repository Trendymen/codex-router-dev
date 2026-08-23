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

import { secretEqual } from "./caller-auth.mjs";
import { desktopCommandDefinitions, runDesktopCommand, sourceRoot, trustedProtectedContext } from "./desktop-commands.mjs";
import {
  canonicalArgumentsHash,
  createPanelSessionStore,
  PANEL_SESSION_COOKIE,
  panelSecurityHeaders,
  parsePanelCookie,
  validatePanelRequest,
} from "./panel-sessions.mjs";

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

// Commands the panel may run. The mutating half of the table is deliberately
// absent: a browser tab is reachable by any page that learns the capability,
// and "save this API key" is not something to expose on that assumption. The
// tray and the Electron shell keep the full table because reaching them means
// already running code on the machine.
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

function panelError(error) {
  const code = typeof error?.code === "string" ? error.code : "panel_invalid_request";
  const safe = {
    panel_nonce_invalid: [404, "The panel bootstrap nonce is invalid."],
    panel_nonce_expired: [410, "The panel bootstrap nonce has expired."],
    panel_auth_required: [401, "The panel write session is missing or expired."],
    panel_csrf_invalid: [403, "The panel mutation proof is invalid."],
    panel_confirmation_required: [409, "Operation-bound confirmation is required."],
    panel_confirmation_invalid: [400, "The panel confirmation request is invalid."],
    panel_peer_invalid: [403, "The panel peer is not allowed."],
    panel_host_invalid: [421, "The panel Host is invalid."],
    panel_origin_invalid: [403, "The panel Origin is invalid."],
    panel_method_invalid: [405, "The panel method is not allowed."],
    panel_content_type_invalid: [415, "Panel mutations require application/json."],
    panel_request_id_invalid: [400, "The panel request ID is invalid."],
  }[code] || [400, "The panel request was invalid."];
  return { status: safe[0], payload: { error: { type: "router_error", code, message: safe[1], param: null } } };
}

function applyHeaders(response, options = {}) {
  for (const [name, value] of Object.entries(panelSecurityHeaders(options))) response.setHeader(name, value);
}

function rememberAndSend(response, writeJson, sessionStore, sessionId, requestId, status, payload) {
  const result = { status, payload };
  if (sessionId && requestId) sessionStore.remember(sessionId, requestId, result);
  writeJson(response, status, payload);
}

function mutationContext(request, policy, sessionStore) {
  const context = validatePanelRequest(request, { ...policy, mutation: true });
  const session = sessionStore.getSession(context.sessionId, { touch: true });
  if (!session.valid || !secretEqual(context.csrfToken, session.session.csrfToken)) {
    const invalid = new Error("The panel mutation proof is invalid.");
    invalid.code = "panel_csrf_invalid";
    throw invalid;
  }
  return context;
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
    const result = panelError(error);
    applyHeaders(response);
    writeJson(response, result.status, result.payload);
    return true;
  };

  if (secured && !/^\/panel-bootstrap\//.test(route) && route !== "/panel-session" && route !== "/panel/session" && route !== "/panel/logout" && route !== "/panel/confirmations" && route !== "/panel/invoke") {
    try {
      validatePanelRequest(request, { ...policy, mutation: false, method: request.method === "HEAD" ? "HEAD" : "GET", requireRequestId: false });
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
    try {
      const context = mutationContext(request, policy, sessionStore);
      const prior = sessionStore.replay(context.sessionId, context.requestId);
      if (prior) {
        applyHeaders(response);
        writeJson(response, prior.status, prior.payload);
        return true;
      }
      const body = JSON.parse(await readBody(request) || "{}");
      if (route === "/panel/logout") {
        sessionStore.remember(context.sessionId, context.requestId, { status: 204, payload: {} });
        sessionStore.logout(context.sessionId);
        applyHeaders(response);
        response.writeHead(204);
        response.end();
        return true;
      }
      if (route === "/panel/confirmations") {
        const command = body?.command;
        const definition = desktopCommandDefinitions().get(command);
        if (!definition?.confirmation) throw Object.assign(new Error("confirmation required"), { code: "panel_confirmation_invalid" });
        const hash = typeof body.argumentsHash === "string" ? body.argumentsHash : canonicalArgumentsHash(body.args ?? {});
        const confirmation = sessionStore.mintConfirmation(context.sessionId, command, hash);
        applyHeaders(response);
        rememberAndSend(response, writeJson, sessionStore, context.sessionId, context.requestId, 200, confirmation);
        return true;
      }
      const { command, args } = body || {};
      const local = panelLocalCommand(command);
      if (local) {
        applyHeaders(response);
        rememberAndSend(response, writeJson, sessionStore, context.sessionId, context.requestId, 200, { value: local() });
        return true;
      }
      if (!panelCommandAllowed(command, { readOnly: false })) {
        throw Object.assign(new Error("command unavailable"), { code: "panel_invalid_request" });
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
      const commandContext = definition.protectedInput
        ? { root, protectedInput: async () => protectedInput }
        : definition.resultKind === "protected-text" ? trustedProtectedContext({ root }) : { root };
      const result = await runCommand(command, canonicalArgs, commandContext);
      const payload = result?.ok === false ? { error: result.error } : { value: result?.ok === true ? result.value : result };
      const status = result?.ok === false ? 502 : 200;
      applyHeaders(response);
      rememberAndSend(response, writeJson, sessionStore, context.sessionId, context.requestId, status, payload);
      return true;
    } catch (error) {
      return fail(error);
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
