import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  authenticatedRoute,
  callerBaseUrl,
  panelPath,
  panelUrl,
  redactCallerUrl,
} from "../src/caller-auth.mjs";
import { isPanelRoute } from "../src/desktop-panel.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-caller-auth-capability-with-sufficient-length";

test("the panel URL is a route the router actually serves", () => {
  const url = panelUrl(4202, CALLER_KEY);
  assert.equal(url, `http://127.0.0.1:4202/_codex-router/${CALLER_KEY}/panel/`);

  // The whole point of the command: what it hands the browser has to survive
  // the capability check and then match a panel route. Asserting the string
  // alone would pass while the router answered 401 or 404.
  const route = authenticatedRoute(new URL(url).pathname, CALLER_KEY);
  assert.equal(route, "/panel/");
  assert.equal(isPanelRoute(route), true);
});

test("a panel URL is refused the same way an API URL is", () => {
  assert.throws(() => panelPath("too-short"), /caller key/i);
  assert.equal(
    authenticatedRoute(
      "/_codex-router/wrong-caller-capability-with-sufficient-length/panel/",
      CALLER_KEY,
    ),
    undefined,
  );
});

// Redaction is what keeps the caller key out of support bundles, doctor output
// and error messages. It matched only `/v1`, so the panel URL -- the same
// secret in the same position -- travelled through all of them verbatim.
test("redaction covers every leaf the capability guards", () => {
  assert.equal(
    redactCallerUrl(panelUrl(4202, CALLER_KEY)),
    "http://127.0.0.1:4202/_codex-router/[REDACTED]/panel/",
  );
  assert.equal(
    redactCallerUrl(callerBaseUrl(4202, CALLER_KEY)),
    "http://127.0.0.1:4202/_codex-router/[REDACTED]/v1",
  );
  for (const value of [
    panelUrl(4202, CALLER_KEY),
    callerBaseUrl(4202, CALLER_KEY),
    `POST ${panelUrl(4202, CALLER_KEY)}invoke failed`,
  ]) {
    assert.equal(
      redactCallerUrl(value).includes(CALLER_KEY),
      false,
      `the caller key survived redaction in: ${value.replace(CALLER_KEY, "…")}`,
    );
  }
});

test("both entry points expose the command", () => {
  const posix = readFileSync(path.join(root, "bin", "panel"), "utf8");
  assert.match(posix, /src\/panel\.mjs/);
  // Asserted against .gitattributes rather than the bytes on disk: a Windows
  // checkout with core.autocrlf=true rewrites the working copy, so reading it
  // would test the machine running the suite instead of what the repository
  // guarantees every checkout receives.
  assert.match(
    readFileSync(path.join(root, ".gitattributes"), "utf8"),
    /^bin\/\* text eol=lf$/m,
    "bin/ holds extensionless POSIX shell scripts and must be pinned to LF",
  );

  const dispatcher = readFileSync(path.join(root, "bin", "model-router"), "utf8");
  assert.match(dispatcher, /\|panel\|/, "model-router must dispatch panel");

  const windows = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  assert.match(windows, /"panel"/, "codex-router.ps1 must list panel");
  assert.match(windows, /src\\panel\.mjs/);
});

test("browser launcher mints a caller-authenticated nonce and opens only the clean bootstrap URL", () => {
  const source = readFileSync(path.join(root, "src", "panel.mjs"), "utf8");
  assert.match(source, /panelSessionUrl\(PORTS\.router, secret\)/);
  assert.match(source, /authorization: `Bearer \$\{secret\}`/);
  assert.match(source, /panelBootstrapUrl\(PORTS\.router, payload\.nonce\)/);
  assert.doesNotMatch(source, /openInBrowser\(panelUrl/);
  assert.match(source, /Opened the companion in a clean browser session/);
});

test("real router and launcher keep the caller key out of clean browser bootstrap", async () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "panel-round2-router-"));
  const caller = "panel-round2-caller-capability-with-sufficient-length";
  const internal = "panel-round2-internal-key-with-sufficient-length";
  const port = await openPort();
  const env = {
    ...process.env,
    MODEL_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_STATE_DIR: state,
    CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_CALLER_KEY: caller,
    CODEX_ROUTER_INTERNAL_KEY: internal,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_DIRECT_DISPATCH: "0",
  };
  writeFileSync(path.join(state, "caller-secret"), `${caller}\n`, { mode: 0o600 });
  const router = spawn(process.execPath, [path.join(root, "src", "router.mjs")], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
  let routerErrors = "";
  router.stderr.setEncoding("utf8");
  router.stderr.on("data", (chunk) => { routerErrors += chunk; });
  const stop = async () => {
    if (router.exitCode === null) {
      router.kill("SIGTERM");
      await new Promise((resolve) => router.once("exit", resolve));
    }
  };
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.status === 200 || health.status === 503) break;
      } catch {
        if (attempt === 99) throw new Error(`router did not listen: ${routerErrors}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const launcher = spawn(process.execPath, [path.join(root, "src", "panel.mjs"), "--print"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    launcher.stdout.setEncoding("utf8");
    launcher.stderr.setEncoding("utf8");
    launcher.stdout.on("data", (chunk) => { stdout += chunk; });
    launcher.stderr.on("data", (chunk) => { stderr += chunk; });
    const [exitCode] = await new Promise((resolve) => launcher.once("exit", (code) => resolve([code])));
    assert.equal(exitCode, 0, stderr);
    const cleanUrl = stdout.trim();
    assert.match(cleanUrl, new RegExp(`^http://127\\.0\\.0\\.1:${port}/panel-bootstrap/[A-Za-z0-9_-]{43}$`));
    assert.equal(cleanUrl.includes(caller), false);

    const bootstrap = await fetch(cleanUrl, { redirect: "manual" });
    assert.equal(bootstrap.status, 303);
    assert.equal(bootstrap.headers.get("location"), "/panel/");
    assert.match(bootstrap.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\/panel$/);
    const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
    const page = await fetch(`http://127.0.0.1:${port}/panel/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /window\.__TAURI__/);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(page.headers.get("cache-control"), "no-cache");
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.equal(html.includes(caller), false);
    const application = await fetch(`http://127.0.0.1:${port}/panel/app.js`, { headers: { cookie } });
    assert.equal(application.status, 200);
    assert.match(application.headers.get("content-type"), /^text\/javascript/);
    assert.equal((await application.text()).includes(caller), false);
    const session = await fetch(`http://127.0.0.1:${port}/panel/session`, { headers: { cookie } });
    assert.equal(session.status, 200);
    const { csrfToken } = await session.json();
    const invoke = await fetch(`http://127.0.0.1:${port}/panel/invoke`, {
      method: "POST",
      headers: { cookie, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-csrf-token": csrfToken, "x-request-id": "66666666-6666-4666-8666-666666666666" },
      body: JSON.stringify({ command: "does.not.exist", args: {} }),
    });
    assert.equal(invoke.status, 404);
    const logout = await fetch(`http://127.0.0.1:${port}/panel/logout`, {
      method: "POST",
      headers: { cookie, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-csrf-token": csrfToken, "x-request-id": "77777777-7777-4777-8777-777777777777" },
      body: "{}",
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0; HttpOnly; SameSite=Strict; Path=\/panel/);
  } finally {
    await stop();
    rmSync(state, { recursive: true, force: true });
  }
});
