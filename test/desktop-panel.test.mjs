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
  panelCommandAllowed,
  panelLocalCommand,
} from "../src/desktop-panel.mjs";
import { commandRefused, readOnlyCapabilities } from "../apps/desktop/ui/model.mjs";

// The panel is served by the router, so these drive the real handler over a
// real socket rather than calling it in-process: the routing, the headers and
// the JSON contract are the parts a browser actually depends on.
function serve(handlerOptions = {}) {
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (isPanelRoute(route)) {
      if (await handlePanelRequest(request, response, route, { writeJson, ...handlerOptions })) return;
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
      });
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
    assert.match(body, /fetch\("\.\/invoke"/);
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

// A browser tab is reachable by anything that learns the capability, so the
// panel deliberately carries only the reading half of the command table.
test("the panel refuses the commands that change credentials or state", async () => {
  const { url, close } = await serve();
  try {
    for (const command of [
      "save_api_key",
      "remove_api_key",
      "set_provider_enabled",
      "connect_oauth",
      // The toggle the UI used to render live: the panel refused it silently
      // and the click came back as a generic failure.
      "set_tool_result_aging",
    ]) {
      const response = await fetch(url("/panel/invoke"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args: { provider: "deepseek", apiKey: "x" } }),
      });
      assert.equal(response.status, 403, `${command} was not refused`);
      const payload = await response.json();
      assert.match(payload.error.message, /not available from the browser panel/);
    }
    assert.equal(panelCommandAllowed("save_api_key"), false);
    assert.equal(panelCommandAllowed("control_snapshot"), false);
    assert.equal(panelCommandAllowed("lifecycle.status"), true);
    // The full canonical table is still reachable for a shell that asks for it.
    assert.equal(panelCommandAllowed("credential.set", { readOnly: false }), true);
  } finally {
    await close();
  }
});

// The refusal is correct; the UI not knowing about it is what turned a
// deliberate posture into a broken-looking switch. platform_info is the one
// call the UI already makes on load, so the panel says so there.
test("the panel tells the UI it is read-only over the same command bridge", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "platform_info", args: {} }),
    });
    assert.equal(response.status, 200);
    const { value } = await response.json();
    assert.equal(value.capabilities.readOnly, true);
    assert.equal(readOnlyCapabilities(value)?.readOnly, true);
    // What a shell that carries the full table sends: no capabilities block,
    // so nothing is refused and the tray and Electron window are unaffected.
    assert.equal(readOnlyCapabilities({ os: "darwin", islandSupported: true }), null);
  } finally {
    await close();
  }
});

// Two lists that describe one policy drift. This asserts they cannot: what the
// panel advertises has to agree with what the gate actually permits, for every
// command in the shared table.
test("the advertised allowed commands are canonical, gated, and backed by production definitions", () => {
  const { capabilities } = panelLocalCommand("platform_info")();
  assert.deepEqual(
    [...capabilities.allowedCommands].sort(),
    ["lifecycle.status", "native.account-usage", "usage.provider", "credential.status", "catalog.render-snippet", "cc-switch.snippet"].sort(),
  );
  for (const command of capabilities.allowedCommands) {
    assert.equal(commandRefused(capabilities, command), false, command);
    assert.equal(panelCommandAllowed(command), true, command);
    assert.equal(desktopCommandDefinitions().has(command), true, command);
  }
  for (const command of ["control_snapshot", "account_usage", "provider_usage", "provider_setup", "local_models"]) {
    assert.equal(panelCommandAllowed(command), false, command);
  }
  // Commands the panel answers from its own process are not refusals: the UI
  // must keep offering Close and the activity pill, which do work here.
  for (const command of capabilities.localCommands) {
    assert.equal(commandRefused(capabilities, command), false, command);
  }
  assert.equal(commandRefused(capabilities, "set_tool_result_aging"), true);
  assert.equal(commandRefused(capabilities, "lifecycle.status"), false);
});

// The two halves joined: the commands the shipped markup declares, answered by
// the capabilities the panel actually sends. Asserting each side separately
// would still pass if a control named a command nobody gates.
test("the panel's own answer gates every canonical command in the shipped markup", () => {
  const { capabilities } = panelLocalCommand("platform_info")();
  const markup = readFileSync(new URL("../apps/desktop/ui/index.html", import.meta.url), "utf8");
  const declared = new Set([...markup.matchAll(/data-command="([a-z0-9._-]+)"/g)].map(([, name]) => name));
  assert.ok(declared.size >= 10, `only ${declared.size} controls declare a command`);
  for (const command of declared) {
    assert.ok(
      desktopCommandDefinitions().has(command) || capabilities.localCommands.includes(command),
      `${command} is not a command any surface answers`,
    );
  }
  // The switch this whole change is about, plus the two the panel does answer.
  assert.equal(declared.has("tool-result-aging.on"), true);
  assert.equal(commandRefused(capabilities, "tool-result-aging.on"), true);
  assert.equal(commandRefused(capabilities, "set_island_enabled"), false);
});

// Reaching the tray or the Electron window means already running code on this
// machine, so neither is narrowed by any of the above.
test("a shell that is not the browser panel still carries the full canonical table", () => {
  for (const command of desktopCommandDefinitions().keys()) {
    assert.equal(panelCommandAllowed(command, { readOnly: false }), true, command);
  }
  assert.equal(panelCommandAllowed("rm_minus_rf", { readOnly: false }), false);
  // The Electron shell runs the table directly rather than through the panel's
  // gate, which is what keeps the read-only posture local to the browser.
  const electron = readFileSync(new URL("../apps/electron/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(electron, /panelCommandAllowed/);
  assert.match(electron, /runDesktopCommand\(command, commandArgs, context\)/);
});

test("an unknown command is refused rather than shelled out", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "rm_minus_rf", args: {} }),
    });
    assert.equal(response.status, 403);
    assert.equal(panelCommandAllowed("rm_minus_rf"), false);
  } finally {
    await close();
  }
});

test("a read command answers with the router's own data", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "lifecycle.status", args: {} }),
    });
    // Read once: the failure message and the assertion cannot both consume it.
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const payload = JSON.parse(raw);
    assert.equal(typeof payload.value, "object");
    // The overview the tray renders, produced by the same control CLI.
    assert.ok(payload.value.targets, "expected the control overview shape");
  } finally {
    await close();
  }
});

test("panel canonical reads dispatch directly and never return undefined", async () => {
  const { url, close } = await serve();
  try {
    for (const command of ["lifecycle.status", "native.account-usage", "usage.provider"]) {
      const response = await fetch(url("/panel/invoke"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args: {} }),
      });
      const raw = await response.text();
      assert.equal(response.status, 200, `${command}: ${raw}`);
      const payload = JSON.parse(raw);
      assert.equal(typeof payload.value, "object", command);
      assert.notEqual(payload.value, undefined, command);
    }
  } finally {
    await close();
  }
});

test("caller-capability panel returns a copyable protected snippet with no-store metadata", async () => {
  const secret = "panel-copyable-caller-decoy-985fc7a6";
  const snippet = `model_provider = "custom"\nbase_url = "http://127.0.0.1:4202/_codex-router/${secret}/v1"\n`;
  const { url, close } = await serve({
    runCommand: (command, args, context) => runDesktopCommand(command, args, {
      ...context,
      execute: async () => snippet,
    }),
  });
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "cc-switch.snippet", args: { protectedChannel: "forged" } }),
    });
    const payload = await response.json();
    assert.equal(response.status, 502, JSON.stringify(payload));

    const allowed = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "cc-switch.snippet", args: {} }),
    });
    const result = await allowed.json();
    assert.equal(allowed.status, 200, JSON.stringify(result));
    assert.equal(allowed.headers.get("cache-control"), "no-store");
    assert.match(result.value, new RegExp(secret));
    assert.deepEqual(result.meta, { protected: true, resultKind: "protected-text", cacheControl: "no-store" });
  } finally {
    await close();
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
  const { url, close } = await serve();
  try {
    const bad = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);

    const wrongMethod = await fetch(url("/panel/invoke"), { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    const wrongAssetMethod = await fetch(url("/panel"), { method: "POST" });
    assert.equal(wrongAssetMethod.status, 405);
  } finally {
    await close();
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
    const crossRouteMismatch = await fetch(`${base}/panel/logout`, { method: "POST", headers, body: "{}" });
    assert.equal(crossRouteMismatch.status, 409);

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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
