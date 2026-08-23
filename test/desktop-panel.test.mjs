import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";

import { desktopCommandDefinitions, runDesktopCommand } from "../src/desktop-commands.mjs";
import { writeJson } from "../src/http-utils.mjs";
import { createPanelSessionStore } from "../src/panel-sessions.mjs";
import {
  handlePanelRequest,
  isPanelRoute,
  panelLocalCommand,
} from "../src/desktop-panel.mjs";
import { browserCommandIds, renderCapabilitySurface } from "../apps/desktop/ui/model.mjs";
import fixture from "./fixtures/required-capabilities.json" with { type: "json" };

// The panel is served by the router, so these drive the real handler over a
// real socket rather than calling it in-process: the routing, the headers and
// the JSON contract are the parts a browser actually depends on.
function serve(handlerOptions = {}) {
  const options = { ...handlerOptions };
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (isPanelRoute(route)) {
      if (await handlePanelRequest(request, response, route, { writeJson, ...options })) return;
    }
    writeJson(response, 404, { error: { type: "not_found", message: "no route" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((done) => server.close(done)),
        sessionStore: options.sessionStore,
      });
      if (options.policy?.port === 0) options.policy = { ...options.policy, port };
    });
  });
}

test("panel routes are recognised, and nothing else is", () => {
  assert.equal(isPanelRoute("/panel"), true);
  assert.equal(isPanelRoute("/panel/app.js"), true);
  assert.equal(isPanelRoute("/panel/invoke"), true);
  assert.equal(isPanelRoute("/panel/../../etc/passwd"), false);
  assert.equal(isPanelRoute("/panel/secrets.json"), false);
  assert.equal(isPanelRoute("/v1/responses"), false);
});

test("the panel serves the shared UI with the bridge injected", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    // The same UI the shells load, plus the one function app.js calls.
    assert.match(body, /window\.__TAURI__/);
    assert.match(body, /fetch\(path/);
    assert.match(body, /__CODEX_ROUTER_MANIFEST__/);
    assert.match(body, /x-confirmation-token/);
    assert.match(body, /data-tab="connections"/);
    // Framing and sniffing are closed off even though the route is gated.
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await close();
  }
});

test("the panel serves each asset the UI loads", async () => {
  const { url, close } = await serve();
  try {
    for (const [asset, pattern] of [
      ["/panel/styles.css", /text\/css/],
      ["/panel/app.js", /javascript/],
      ["/panel/model.mjs", /javascript/],
      ["/panel/thinking-orb.mjs", /javascript/],
    ]) {
      const response = await fetch(url(asset));
      assert.equal(response.status, 200, `${asset} did not serve`);
      assert.match(response.headers.get("content-type"), pattern, asset);
    }
  } finally {
    await close();
  }
});

test("the browser panel publishes one manifest and no parked read-only branch", () => {
  const manifest = panelLocalCommand("platform_info")().capabilityManifest;
  assert.equal(manifest.capabilitySchemaVersion, fixture.capabilitySchemaVersion);
  assert.deepEqual(browserCommandIds(manifest).sort(), fixture.nodeCommands.sort());
  assert.doesNotMatch(readFileSync(new URL("../src/desktop-panel.mjs", import.meta.url), "utf8"), /CANONICAL_PANEL_COMMANDS|legacy direct handler/);
  for (const command of desktopCommandDefinitions().keys()) assert.equal(desktopCommandDefinitions().has(command), true, command);
  for (const command of fixture.forbiddenCommands) assert.equal(desktopCommandDefinitions().has(command), false, command);
  assert.equal(desktopCommandDefinitions().has("rm_minus_rf"), false);
  const markup = renderCapabilitySurface(manifest);
  for (const command of fixture.nodeCommands) assert.match(markup, new RegExp(`data-command="${command.replaceAll(".", "\\.")}"`));
});

async function openWriteSession(handlerOptions = {}) {
  const sessionStore = createPanelSessionStore();
  const served = await serve({ policy: { port: 0 }, sessionStore, ...handlerOptions });
  const minted = sessionStore.mintNonce();
  const bootstrap = await fetch(served.url(`/panel-bootstrap/${minted.nonce}`), { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const session = await fetch(served.url("/panel/session"), { headers: { cookie } });
  const csrfToken = (await session.json()).csrfToken;
  return { ...served, cookie, csrfToken };
}

function mutationHeaders(session, requestId = crypto.randomUUID(), extra = {}) {
  return {
    cookie: session.cookie,
    origin: new URL(session.url("/")).origin,
    "content-type": "application/json",
    "x-csrf-token": session.csrfToken,
    "x-request-id": requestId,
    ...extra,
  };
}

test("secured browser mutations use canonical commands and replay the stored result", async () => {
  let executions = 0;
  // The test server uses the current session port in its policy; command
  // execution is stubbed so this remains a unit/source contract test.
  const served = await openWriteSession({
    runCommand: async () => { executions += 1; return { ok: true, value: { mode: "always" } }; },
  });
  try {
    const requestId = crypto.randomUUID();
    const headers = mutationHeaders(served, requestId);
    const body = JSON.stringify({ command: "presence.mode", args: { mode: "always" } });
    const first = await fetch(served.url("/panel/invoke"), { method: "POST", headers, body });
    const second = await fetch(served.url("/panel/invoke"), { method: "POST", headers, body });
    assert.equal(first.status, 200);
    assert.deepEqual(await second.json(), await first.clone().json());
    assert.equal(executions, 1);
  } finally {
    await served.close();
  }
});

test("destructive browser actions obtain an operation-bound server confirmation", async () => {
  let executions = 0;
  const served = await openWriteSession({
    runCommand: async () => { executions += 1; return { ok: true, value: { stopped: true } }; },
  });
  try {
    const missing = await fetch(served.url("/panel/invoke"), { method: "POST", headers: mutationHeaders(served), body: JSON.stringify({ command: "lifecycle.stop", args: {} }) });
    assert.equal(missing.status, 409);
    const confirmation = await fetch(served.url("/panel/confirmations"), { method: "POST", headers: mutationHeaders(served), body: JSON.stringify({ command: "lifecycle.stop", args: {} }) });
    assert.equal(confirmation.status, 200);
    const token = (await confirmation.json()).token;
    const run = await fetch(served.url("/panel/invoke"), { method: "POST", headers: mutationHeaders(served, crypto.randomUUID(), { "x-confirmation-token": token }), body: JSON.stringify({ command: "lifecycle.stop", args: {} }) });
    assert.equal(run.status, 200);
    assert.equal(executions, 1);
  } finally {
    await served.close();
  }
});

test("protected snippet remains on the authorized output channel", async () => {
  const secret = "panel-copyable-caller-decoy-985fc7a6";
  const snippet = `model_provider = "custom"\nbase_url = "http://127.0.0.1:4202/_codex-router/${secret}/v1"\n`;
  const served = await openWriteSession({
    runCommand: (command, args, context) => runDesktopCommand(command, args, { ...context, execute: async () => snippet }),
  });
  try {
    const result = await fetch(served.url("/panel/invoke"), { method: "POST", headers: mutationHeaders(served), body: JSON.stringify({ command: "cc-switch.snippet", args: {} }) });
    const payload = await result.json();
    assert.equal(result.status, 200, JSON.stringify(payload));
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.match(payload.value, new RegExp(secret));
    assert.deepEqual(payload.meta, { protected: true, resultKind: "protected-text", cacheControl: "no-store" });
  } finally {
    await served.close();
  }
});

test("credential bytes cross the panel only through the protected input callback", async () => {
  const secret = "panel-credential-decoy-985fc7a6";
  let capturedArgs;
  let capturedProtected;
  const served = await openWriteSession({
    runCommand: async (command, args, context) => {
      capturedArgs = args;
      capturedProtected = await context.protectedInput();
      return { ok: true, value: { saved: true } };
    },
  });
  try {
    const result = await fetch(served.url("/panel/invoke"), {
      method: "POST",
      headers: mutationHeaders(served),
      body: JSON.stringify({ command: "credential.set", args: { provider: "deepseek", apiKey: secret } }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(capturedArgs, { provider: "deepseek" });
    assert.equal(capturedProtected, secret);
    assert.doesNotMatch(JSON.stringify(capturedArgs), new RegExp(secret));
  } finally {
    await served.close();
  }
});

test("the shipped browser UI binds canonical Node command IDs and omits setup/local-model aliases", () => {
  const app = readFileSync(new URL("../apps/desktop/ui/app.js", import.meta.url), "utf8");
  const markup = readFileSync(new URL("../apps/desktop/ui/index.html", import.meta.url), "utf8");
  const source = `${markup}\n${app}`;
  const forbiddenSource = [
    "login-free-switch",
    "signed-routing-switch",
    "local-model-summary",
    "local-model-operation",
    "local-download-status",
    "local-model-list",
    "local-model-form",
    "local-model-input",
    "local-quick-picks",
    "local-catalog",
    "local-runtime-actions",
    "lmstudio-section",
    "renderLoginFreeSetting",
    "renderSignedRouting",
    "renderLocalModels",
    "handleLoginFreeToggle",
    "handleSignedRoutingToggle",
    "handleLocalModelInstall",
    "handleLocalModelClick",
    "set_login_free",
    "set_signed_routing",
    "install_local_model",
    "set_local_model_enabled",
    "uninstall_local_model",
    "cancel_local_model",
    "update_local_ollama",
    "local_model_speed",
    "benchmark_vision_model",
    "use_local_vision_model",
    "set_lmstudio_model_enabled",
    "provider_setup",
    "local_models",
  ];
  for (const forbidden of forbiddenSource) {
    assert.equal(source.includes(forbidden), false, `forbidden shared UI source survived: ${forbidden}`);
  }
  assert.doesNotMatch(markup, /data-accordion="local"|Local LLMs|Use without OpenAI login|Use Router with ChatGPT/i);
  assert.match(markup, /id="vision-local-models"/);
  assert.match(app, /data-command="vision\.pull"/);

  const local = new Set(["router_health", "platform_info", "desktop_settings", "set_island_enabled", "set_island_expanded", "show_panel", "hide_panel", "quit_app"]);
  const advertised = [...source.matchAll(/data-command="([^"]+)"/g)].map(([, command]) => command).filter((command) => !command.includes("${"));
  for (const command of advertised) {
    assert.ok(desktopCommandDefinitions().has(command) || local.has(command), `${command} is not canonical or shell-local`);
  }
  const invoked = [...app.matchAll(/\bcall\("([^"]+)"/g)].map(([, command]) => command);
  for (const command of [
    "set_login_free",
    "set_signed_routing",
    "install_local_model",
    "set_local_model_enabled",
    "uninstall_local_model",
    "cancel_local_model",
    "update_local_ollama",
    "local_model_speed",
    "benchmark_vision_model",
    "use_local_vision_model",
    "set_lmstudio_model_enabled",
  ]) {
    assert.equal(invoked.includes(command), false, `${command} is a surviving forbidden call edge`);
  }
});

test("malformed JSON and wrong methods are answered, not crashed on", async () => {
  const secured = await openWriteSession({ runCommand: async () => ({ ok: true, value: {} }) });
  try {
    const bad = await fetch(secured.url("/panel/invoke"), {
      method: "POST",
      headers: mutationHeaders(secured),
      body: "{not json",
    });
    assert.equal(bad.status, 400);

    const wrongMethod = await fetch(secured.url("/panel/invoke"), { method: "GET", headers: mutationHeaders(secured) });
    assert.equal(wrongMethod.status, 401);

    const wrongAssetMethod = await fetch(secured.url("/panel"), { method: "POST" });
    assert.equal(wrongAssetMethod.status, 401);
  } finally {
    await secured.close();
  }
});

// Serving the files is not the same as the page working. This drives the panel
// in a real browser, because the two defects that got through here -- relative
// assets resolving one level too high at "/panel", and the UI's non-CLI
// commands being refused -- both served a 200 and rendered an empty panel.
const chromiumPath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browserSkip = !existsSync(chromiumPath)
  ? "no preinstalled chromium"
  : !existsSync(new URL("../apps/electron/node_modules/playwright", import.meta.url))
    ? "playwright is not installed (npm ci --prefix apps/electron)"
    : false;

test("the panel renders and answers in a real browser", { skip: browserSkip }, async () => {
  // Playwright's entry is CommonJS; imported from ESM the namespace may carry
  // the exports directly or behind `default` depending on the interop path.
  const loaded = await import("../apps/electron/node_modules/playwright/index.js");
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  assert.ok(chromium, "playwright did not expose chromium");
  const { url, close } = await serve();
  const browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
    const failures = [];
    page.on("pageerror", (error) => failures.push(String(error.message)));
    page.on("response", (response) => {
      const route = new URL(response.url()).pathname;
      // account_usage needs a Codex install, which a test machine need not
      // have; every other non-2xx is a real failure.
      if (response.status() >= 400 && response.status() !== 502) {
        failures.push(`${response.status()} ${route}`);
      }
    });

    await page.goto(url("/panel/"), { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    // The bridge is present and the UI painted real data through it.
    assert.equal(
      await page.evaluate(() => typeof window.__TAURI__?.core?.invoke),
      "function",
    );
    await page.click('button.tab[data-tab="connections"]');
    await page.waitForTimeout(600);
    const text = await page.locator("body").innerText();
    assert.match(text, /anthropic|cerebras|deepseek/i, "provider rows did not render");
    assert.equal(
      await page.evaluate(() => document.querySelector("button.tab.is-active")?.dataset.tab),
      "connections",
    );
    assert.deepEqual(failures, [], `browser reported: ${failures.join(", ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("the bare panel path redirects to the directory form", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel"), { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "./panel/");
  } finally {
    await close();
  }
});

test("secured panel bootstrap, CSRF and request replay are enforced before command execution", async () => {
  let randomValue = 0x55;
  const store = createPanelSessionStore({ randomBytes: (size) => Buffer.alloc(size, randomValue++) });
  const minted = store.mintNonce();
  let calls = 0;
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (isPanelRoute(route)) {
      await handlePanelRequest(request, response, route, {
        writeJson,
        policy: { port: server.address()?.port },
        sessionStore: store,
        runCommand: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { ok: true, value: { calls } };
        },
      });
      return;
    }
    writeJson(response, 404, { error: { type: "not_found" } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const bootstrap = await fetch(`${base}/panel-bootstrap/${minted.nonce}`, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get("location"), "/panel/");
    const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
    assert.match(bootstrap.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\/panel$/);

    const session = await fetch(`${base}/panel/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    const { csrfToken } = await session.json();
    const headers = {
      cookie,
      origin: base,
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      "x-request-id": "11111111-1111-4111-8111-111111111111",
    };
    const first = await fetch(`${base}/panel/invoke`, { method: "POST", headers, body: JSON.stringify({ command: "presence.mode", args: { mode: "always" } }) });
    assert.equal(first.status, 200, await first.text());
    const second = await fetch(`${base}/panel/invoke`, { method: "POST", headers, body: JSON.stringify({ command: "presence.mode", args: { mode: "always" } }) });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).value.calls, 1);
    assert.equal(calls, 1);

    const replayMismatch = await fetch(`${base}/panel/invoke`, { method: "POST", headers, body: JSON.stringify({ command: "presence.mode", args: { mode: "never" } }) });
    assert.equal(replayMismatch.status, 409);
    assert.equal((await replayMismatch.json()).error.code, "panel_confirmation_required");

    const concurrentHeaders = { ...headers, "x-request-id": "22222222-2222-4222-8222-222222222222" };
    const concurrent = await Promise.all([
      fetch(`${base}/panel/invoke`, { method: "POST", headers: concurrentHeaders, body: JSON.stringify({ command: "presence.mode", args: { mode: "always" } }) }),
      fetch(`${base}/panel/invoke`, { method: "POST", headers: concurrentHeaders, body: JSON.stringify({ command: "presence.mode", args: { mode: "always" } }) }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
    assert.equal(calls, 2);

    const unknown = await fetch(`${base}/panel/invoke`, { method: "POST", headers: { ...headers, "x-request-id": "33333333-3333-4333-8333-333333333333" }, body: JSON.stringify({ command: "does.not.exist", args: {} }) });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "command_not_supported");

    const badOrigin = await fetch(`${base}/panel/invoke`, { method: "POST", headers: { ...headers, origin: "http://localhost:" + port }, body: "{}" });
    assert.equal(badOrigin.status, 401);
    const badHost = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/panel/", headers: { host: `localhost:${port}` } }, resolve);
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHost.statusCode, 401);

    const logoutHeaders = { ...headers, "x-request-id": "44444444-4444-4444-8444-444444444444" };
    const logout = await fetch(`${base}/panel/logout`, { method: "POST", headers: logoutHeaders, body: "{}" });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0; HttpOnly; SameSite=Strict; Path=\/panel/);
    const logoutRetry = await fetch(`${base}/panel/logout`, { method: "POST", headers: logoutHeaders, body: "{}" });
    assert.equal(logoutRetry.status, 204);

    const secondNonce = store.mintNonce().nonce;
    const secondBootstrap = await fetch(`${base}/panel-bootstrap/${secondNonce}`, { redirect: "manual" });
    const secondCookie = secondBootstrap.headers.get("set-cookie").split(";", 1)[0];
    const secondSession = await fetch(`${base}/panel/session`, { headers: { cookie: secondCookie } });
    const secondCsrf = (await secondSession.json()).csrfToken;
    const shared = { cookie: secondCookie, origin: base, "content-type": "application/json", "x-csrf-token": secondCsrf, "x-request-id": "88888888-8888-4888-8888-888888888888" };
    const firstSecond = await fetch(`${base}/panel/invoke`, { method: "POST", headers: shared, body: JSON.stringify({ command: "presence.mode", args: { mode: "always" } }) });
    assert.equal(firstSecond.status, 200);
    const conflictingLogout = await fetch(`${base}/panel/logout`, {
      method: "POST",
      headers: shared,
      body: JSON.stringify({ command: "presence.mode", args: { mode: "never" } }),
    });
    assert.equal(conflictingLogout.status, 204);
    assert.match(conflictingLogout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await fetch(`${base}/panel/session`, { headers: { cookie: secondCookie } })).status, 401);
    const conflictingLogoutRetry = await fetch(`${base}/panel/logout`, {
      method: "POST",
      headers: shared,
      body: JSON.stringify({ args: { changed: true } }),
    });
    assert.equal(conflictingLogoutRetry.status, 204);
    assert.match(conflictingLogoutRetry.headers.get("set-cookie"), /Max-Age=0/);
    const crossRouteReplay = await fetch(`${base}/panel/invoke`, {
      method: "POST",
      headers: shared,
      body: JSON.stringify({ command: "presence.mode", args: { mode: "always" } }),
    });
    assert.equal(crossRouteReplay.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
