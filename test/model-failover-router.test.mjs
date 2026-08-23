import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";
import { registryFingerprint } from "../src/protocol-proof.mjs";
import { PROTOCOL_PROOF_VERIFIER_VERSION } from "../src/protocol-proof-verifier.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";

// The model the turn asks for, and the one the router is told to move it to.
// The fallback is named explicitly rather than left to the ranking so the
// assertion does not depend on which providers the developer's own machine has
// credentials for.
const PRIMARY = { slug: "deepseek/deepseek-v4-pro", gatewayModel: "deepseek-v4-pro" };
const FALLBACK = { slug: "zai-api/glm-5.2", gatewayModel: "zai-api-glm-5-2" };

const TURN_BODY = { model: PRIMARY.slug, input: "hello", stream: true };

// Marker text is what proves whose bytes reached the client.
function contentSse(marker) {
  return [
    `data: ${JSON.stringify({ type: "response.created", response: { id: `r-${marker}` } })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: `answered-by-${marker}`,
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: `r-${marker}`,
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: marker }] },
        ],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

const QUOTA_BODY = JSON.stringify({
  error: {
    message:
      "litellm.RateLimitError: RateLimitError: OpenAIException - You have exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "429",
  },
});

const FREE_USAGE_BODY = JSON.stringify({
  error: {
    type: "FreeUsageLimitError",
    message: "Rate limit exceeded",
  },
});

const BAD_KEY_BODY = JSON.stringify({
  error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "401" },
});

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, port: server.address().port };
}

function gateway(handler) {
  return mockServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      const payload = Buffer.from(JSON.stringify({ ok: true }), "utf8");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    handler(request, response);
  });
}

function bodyJson(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
  });
}

function run(env, { chain = [FALLBACK.slug], enabled = true, cooldowns, nodeRoutes, protocolProofs, importFile } = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-failover-router-state-"));
  if (chain !== null) {
    writeFileSync(
      path.join(stateDir, "failover.json"),
      JSON.stringify({ version: 1, enabled, chain }),
      "utf8",
    );
  }
  if (cooldowns) {
    writeFileSync(
      path.join(stateDir, "provider-cooldowns.json"),
      JSON.stringify(cooldowns),
      "utf8",
    );
  }
  if (nodeRoutes) {
    writeFileSync(path.join(stateDir, "node-routes.json"), JSON.stringify({ version: 1, routes: nodeRoutes }), "utf8");
  }
  if (protocolProofs) {
    writeFileSync(path.join(stateDir, "protocol-proofs.json"), JSON.stringify({ version: 1, revision: 1, revisions: {}, proofs: protocolProofs }), "utf8");
  }
  // A candidate has to be one the operator could actually reach, and
  // `configuredProviderIds()` only counts a *persistent* credential -- an
  // environment variable deliberately does not qualify. Write the file the
  // provider's registry entry names, so the fallback is credentialed here and
  // nowhere else on the machine.
  writeFileSync(path.join(stateDir, "zai-api-key.secret"), "test-zai-platform-key\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // The responses-native provider used by the protocol-crossing cases. It is a
  // variant of opencode-go, so it authenticates with that family's credential.
  writeFileSync(path.join(stateDir, "opencode-go-api-key.secret"), "test-opencode-go-key\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const child = spawn(process.execPath, [...(importFile ? ["--import", pathToFileURL(importFile).href] : []), path.join(root, "src", "router.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MODEL_ROUTER_STATE_DIR: stateDir,
      CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
      CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
      KIMI_INTERNAL_KEY: INTERNAL_KEY,
      CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      // The failover log line must survive the flag a production LaunchAgent
      // hard-sets, so every test here runs with it on.
      CODEX_ROUTER_QUIET: "1",
      // Makes the fallback provider credentialed without touching a keychain.
      ZAI_PLATFORM_API_KEY: "test-zai-platform-key",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  child.stateDir = stateDir;
  return child;
}

function routerEnv(gatewayPort, routerPort, { legacyKillSwitch = true } = {}) {
  return {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health`,
    ...(legacyKillSwitch ? { CODEX_ROUTER_DIRECT_DISPATCH: "0" } : {}),
  };
}

function acceleratedForcedDeadlinePreload(delayMs = 200) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "task6-forced-deadline-"));
  const preload = path.join(directory, "preload.mjs");
  writeFileSync(preload, `
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 30_001 ? ${delayMs} : delay, ...args);
`, "utf8");
  return preload;
}

function usageEvents(stateDir) {
  const file = path.join(stateDir, "usage-events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForUsageEvents(stateDir, count, child) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const events = usageEvents(stateDir);
    if (events.length >= count) return events;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} usage events: ${child.testErrors()}`);
}

async function waitFor(url, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not bound yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

function readRouted(port, body, suffix = "/responses") {
  return new Promise((resolve, reject) => {
    const base = new URL(`${callerBaseUrl(port, CALLER_KEY)}${suffix}`);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: base.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer codex-caller-auth" },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        const done = () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text,
            complete: response.complete,
          });
        response.once("end", done);
        response.once("close", done);
        response.once("error", done);
      },
    );
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

function streamGateway() {
  const seen = [];
  return {
    seen,
    handler: async (request, response, decide) => {
      const body = await bodyJson(request);
      seen.push(body);
      decide(body, response);
    },
  };
}

test("a turn whose provider is out of usage is served by the next model", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);

    // Exactly two upstream attempts: the exhausted model, then the fallback.
    assert.equal(seen.length, 2);
    assert.equal(seen[0].model, PRIMARY.gatewayModel);
    assert.equal(seen[1].model, FALLBACK.gatewayModel);

    // The client saw one clean 200 carrying only the fallback's bytes. The
    // failed attempt must never appear in the stream.
    assert.equal(result.status, 200);
    assert.equal(result.complete, true);
    assert.match(result.body, /answered-by-fallback/);
    assert.doesNotMatch(result.body, /exceeded your current quota/);

    // Both attempts are metered, and the serving row names what was asked for.
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    const failed = events.find((event) => event.model === PRIMARY.slug);
    const served = events.find((event) => event.model === FALLBACK.slug);
    assert.equal(failed.status, 429);
    assert.equal(failed.failoverFrom, undefined);
    assert.equal(served.status, 200);
    assert.equal(served.failoverFrom, PRIMARY.slug);

    // The swap is never silent, even with the quiet flag a LaunchAgent sets.
    assert.match(child.testErrors(), /failover model=deepseek\/deepseek-v4-pro/);
    assert.match(child.testErrors(), /reason=out_of_usage/);
    assert.match(child.testErrors(), /-> zai-api\/glm-5\.2 outcome=200/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("the router fails over OpenCode FreeUsageLimitError without leaking the original error", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(FREE_USAGE_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("free-limit-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.deepEqual(seen.map((body) => body.model), [PRIMARY.gatewayModel, FALLBACK.gatewayModel]);
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-free-limit-fallback/);
    assert.doesNotMatch(result.body, /FreeUsageLimitError|Rate limit exceeded/);
    assert.match(child.testErrors(), /failover model=deepseek\/deepseek-v4-pro/);
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    assert.equal(events.find((event) => event.model === PRIMARY.slug).status, 429);
    assert.equal(events.find((event) => event.model === FALLBACK.slug).status, 200);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("translates an OpenCode FreeUsageLimitError when no fallback is eligible", async () => {
  const gw = await gateway(async (_request, response) => {
    const payload = Buffer.from(FREE_USAGE_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { chain: ["gone/removed-model"] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 429);
    const translated = JSON.parse(result.body);
    assert.equal(translated.error.type, "billing_error");
    assert.match(translated.error.message, /run out of usage/i);
    assert.doesNotMatch(result.body, /FreeUsageLimitError/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("the exhausted provider is skipped outright on the next turn", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      // Names when it will be back, which is what the router is allowed to
      // believe. Without this header the next turn must ask again.
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "1800",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    await readRouted(routerPort, TURN_BODY);
    assert.equal(seen.length, 2);

    const second = await readRouted(routerPort, TURN_BODY);
    // One attempt this time: the cooled-down provider is never contacted.
    assert.equal(seen.length, 3);
    assert.equal(seen[2].model, FALLBACK.gatewayModel);
    assert.equal(second.status, 200);
    assert.match(second.body, /answered-by-fallback/);
    assert.match(child.testErrors(), /reason=cooled_until_/);

    const cooldowns = JSON.parse(
      readFileSync(path.join(child.stateDir, "provider-cooldowns.json"), "utf8"),
    );
    assert.equal(cooldowns.deepseek.reason, "out_of_usage");
    assert.ok(Date.parse(cooldowns.deepseek.until) > Date.now());
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a rejected credential keeps its own error and is never swapped away", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    const payload = Buffer.from(BAD_KEY_BODY, "utf8");
    response.writeHead(401, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    // Exactly one attempt, and the operator still reads the real cause.
    assert.equal(seen.length, 1);
    assert.equal(result.status, 401);
    const payload = JSON.parse(result.body);
    assert.equal(payload.error.type, "authentication_error");
    assert.match(payload.error.message, /DeepSeek/i);
    assert.doesNotMatch(child.testErrors(), /failover/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("with nothing eligible the original failure is returned unchanged", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  // A chain naming only a model this build cannot route to leaves no candidate.
  const child = run(routerEnv(gw.port, routerPort), { chain: ["gone/removed-model"] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(seen.length, 1);
    assert.equal(result.status, 429);
    const payload = JSON.parse(result.body);
    assert.equal(payload.error.type, "billing_error");
    assert.match(payload.error.message, /run out of usage/i);
    // The turn still says out loud that it looked and found nothing.
    assert.match(child.testErrors(), /failover model=deepseek\/deepseek-v4-pro.*-> none outcome=no-candidate/s);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("default direct router covers summary/raw/compaction, exact Retry-After, trusted pipeline errors, native, legacy, and proven canary", async () => {
  const seen = [];
  let stalledBodyCancels = 0;
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push({ url: request.url, body });
    const input = JSON.stringify(body.input);
    if (request.url === "/direct/responses") {
      if (input.includes("RETRY_AFTER_17")) {
        response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "17" });
        response.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }));
        return;
      }
      if (input.includes("PIPELINE_413")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(`{"id":"oversize","output_text":"${"x".repeat(8 * 1024 * 1024)}"}`);
        return;
      }
      if (input.includes("FORCED_BODY_STALL")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.flushHeaders();
        response.write(`data: ${JSON.stringify({ type: "response.created", sequence_number: 1, response: { id: "resp_stalled", model: PRIMARY.slug, output: [] } })}\n\n`);
        response.once("close", () => { stalledBodyCancels += 1; });
        return;
      }
      if (input.includes("FORCED_A_REASONING_FAIL")) {
        const name = body.tools?.[0]?.name;
        const call = { type: "function_call", id: "fc_forced_a", call_id: "call_forced_a", name, arguments: "{}" };
        const events = [
          { type: "response.created", sequence_number: 1, response: { id: "resp_forced_a", model: PRIMARY.slug, output: [] } },
          { type: "response.output_item.added", sequence_number: 2, output_index: 0, item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.done", sequence_number: 3, output_index: 0, item_id: call.id, arguments: call.arguments },
          { type: "response.output_item.done", sequence_number: 4, output_index: 0, item: call },
          { type: "response.reasoning_summary_text.delta", sequence_number: 5, output_index: 1, item_id: "missing_reasoning_item", summary_index: 0, delta: "PRIVATE_REASONING_MUST_NOT_LEAK" },
          { type: "response.completed", sequence_number: 6, response: { id: "resp_forced_a", model: PRIMARY.slug, status: "completed", output: [call], usage: { input_tokens: 31, output_tokens: 7, total_tokens: 38 } } },
        ];
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
        return;
      }
      if (input.includes("FORCED_B_PREVALIDATION_FAIL")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "resp_forced_b", model: PRIMARY.slug, status: "completed", output: [], usage: { input_tokens: 19, output_tokens: 3, total_tokens: 22 } } }));
        return;
      }
      const isCompact = input.includes("Summarize the conversation") || input.includes("compact");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: isCompact ? "direct-compact" : "direct-normal",
        output: isCompact
          ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "DIRECT_COMPACT_SUMMARY" }] }]
          : [
              { type: "reasoning", id: "rs_direct", summary: [], content: [{ type: "reasoning_text", text: "private raw reasoning" }] },
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "DIRECT_OK" }] },
            ],
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      }));
      return;
    }
    if (request.url === "/qwen/responses") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "canary", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "CANARY_OK" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
      return;
    }
    if (request.url === "/native/responses") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "native", output: [{ type: "message", content: [{ type: "output_text", text: "NATIVE_OK" }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
      return;
    }
    response.writeHead(599, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: `unexpected path ${request.url}` } }));
  });
  const directRoutes = [
    { ...MODEL_BY_SLUG.get(PRIMARY.slug), effectiveTransport: "openai-responses", reasoningDisplayMode: "summary-compat", effectiveFinalReasoningShape: "raw-content", routable: true, visible: true },
    { ...MODEL_BY_SLUG.get("deepseek/deepseek-v4-flash"), effectiveTransport: "openai-responses", reasoningDisplayMode: "raw-preserve", effectiveFinalReasoningShape: "raw-content", routable: true, visible: true },
  ];
  const canaryModel = MODEL_BY_SLUG.get("qwen-plan/qwen3.7-max");
  const canaryRoute = { ...canaryModel, effectiveFinalReasoningShape: "hybrid-summary", routable: true, visible: true };
  directRoutes.push(canaryRoute);
  const proof = {
    slug: canaryModel.slug,
    provider: canaryModel.provider,
    upstreamModel: canaryModel.upstreamModel,
    transport: canaryModel.effectiveTransport,
    toolDialect: canaryModel.toolDialect,
    requestProfile: canaryModel.requestProfile,
    verdict: "passing",
    verifierVersion: PROTOCOL_PROOF_VERIFIER_VERSION,
    fingerprint: registryFingerprint(canaryModel, PROTOCOL_PROOF_VERIFIER_VERSION),
    measuredFinalReasoningShape: "hybrid-summary",
    verifiedAt: "2026-08-23T00:00:00.000Z",
  };
  const routerPort = await openPort();
  const forcedDeadlinePreload = acceleratedForcedDeadlinePreload();
  const child = run({
    ...routerEnv(gw.port, routerPort, { legacyKillSwitch: false }),
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${gw.port}/direct`,
    DEEPSEEK_API_KEY: "direct-deepseek-key",
    QWEN_PLAN_BASE_URL: `http://127.0.0.1:${gw.port}/qwen`,
    QWEN_PLAN_API_KEY: "direct-qwen-key",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${gw.port}/native`,
  }, { chain: [], nodeRoutes: directRoutes, protocolProofs: { [canaryModel.slug]: proof }, importFile: forcedDeadlinePreload });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);

    const summary = await readRouted(routerPort, { model: PRIMARY.slug, stream: false, input: "summary branch" });
    assert.equal(summary.status, 200, summary.body);
    assert.match(summary.body, /DIRECT_OK/);
    const summaryJson = JSON.parse(summary.body);
    assert.ok(summaryJson.output.find((item) => item.type === "reasoning")?.summary?.length > 0);

    const raw = await readRouted(routerPort, { model: "deepseek/deepseek-v4-flash", stream: false, input: "raw branch" });
    assert.equal(raw.status, 200, raw.body);
    assert.ok(JSON.parse(raw.body).output.find((item) => item.type === "reasoning")?.content?.length > 0);

    const compact = await readRouted(routerPort, { model: PRIMARY.slug, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact me" }] }] }, "/responses/compact");
    assert.equal(compact.status, 200, compact.body);
    assert.match(compact.body, /DIRECT_COMPACT_SUMMARY/);

    const retry = await readRouted(routerPort, { model: PRIMARY.slug, stream: false, input: "RETRY_AFTER_17" });
    assert.equal(retry.status, 429);
    assert.equal(retry.headers["retry-after"], "17");
    assert.match(JSON.parse(retry.body).error.message, /Retry in about 17s\./);

    const oversize = await readRouted(routerPort, { model: PRIMARY.slug, stream: false, input: "PIPELINE_413" });
    assert.equal(oversize.status, 413, oversize.body.slice(0, 300));
    assert.equal(JSON.parse(oversize.body).error.code, "forced_tool_buffer_limit");

    const forcedTool = [{ type: "function", name: "run", parameters: { type: "object", properties: {}, additionalProperties: false } }];
    const forcedA = await readRouted(routerPort, { model: PRIMARY.slug, stream: true, input: "FORCED_A_REASONING_FAIL", tools: forcedTool, tool_choice: "required" });
    assert.equal(forcedA.status, 200, forcedA.body);
    assert.equal((forcedA.body.match(/response\.failed/g) || []).length, 1);
    assert.equal((forcedA.body.match(/data: \[DONE\]/g) || []).length, 1);
    assert.doesNotMatch(forcedA.body, /PRIVATE_REASONING_MUST_NOT_LEAK|input_tokens|_codexRouter/);
    assert.equal(forcedA.headers["x-codex-router-usage-owner"], undefined);

    const forcedB = await readRouted(routerPort, { model: PRIMARY.slug, stream: true, input: "FORCED_B_PREVALIDATION_FAIL", tools: forcedTool, tool_choice: "required" });
    assert.equal(forcedB.status, 422, forcedB.body);
    assert.equal(JSON.parse(forcedB.body).error.code, "required_tool_not_called");
    assert.doesNotMatch(forcedB.body, /input_tokens|_codexRouter/);
    assert.equal(forcedB.headers["x-codex-router-usage-owner"], undefined);

    const stalled = await readRouted(routerPort, { model: PRIMARY.slug, stream: true, input: "FORCED_BODY_STALL", tools: forcedTool, tool_choice: "required" });
    assert.equal(stalled.status, 504, stalled.body);
    assert.equal((stalled.body.match(/response\.failed/g) || []).length, 1);
    assert.equal((stalled.body.match(/data: \[DONE\]/g) || []).length, 1);
    assert.match(stalled.body, /forced_tool_buffer_timeout/);
    assert.match(stalled.body, /Forced-tool validation exceeded time limit\./);
    assert.doesNotMatch(stalled.body, /resp_stalled|_codexRouter|input_tokens/);
    assert.equal(stalledBodyCancels, 1);

    const native = await readRouted(routerPort, { model: "gpt-native-fixture", stream: false, input: "native branch" });
    assert.equal(native.status, 200, native.body);
    assert.match(native.body, /NATIVE_OK/);

    const beforeLegacyRequests = seen.length;
    const legacy = await readRouted(routerPort, { model: "zai-api/glm-5.2", stream: false, input: "legacy branch" });
    assert.equal(legacy.status, 404, legacy.body);
    assert.equal(JSON.parse(legacy.body).error.code, "provider_not_available_in_node_build");
    assert.equal(seen.length, beforeLegacyRequests, "the absent Node snapshot reached the legacy gateway");

    const canary = await readRouted(routerPort, { model: canaryModel.slug, stream: false, input: "canary branch" });
    assert.equal(canary.status, 200, canary.body);
    assert.match(canary.body, /CANARY_OK/);

    const directPaths = seen.map((entry) => entry.url);
    assert.ok(directPaths.filter((url) => url === "/direct/responses").length >= 6);
    assert.ok(directPaths.includes("/qwen/responses"));
    assert.ok(directPaths.includes("/native/responses"));
    assert.equal(directPaths.includes("/v1/responses"), false, "a resolved direct route fell through to the legacy gateway");

    const events = await waitForUsageEvents(child.stateDir, 11, child);
    const forcedARows = events.filter((event) => event.model === PRIMARY.slug && event.inputTokens === 31 && event.outputTokens === 7);
    assert.equal(forcedARows.length, 1, "validated forced usage was not retained exactly once after reasoning failure");
    const forcedBRows = events.filter((event) => event.model === PRIMARY.slug && event.inputTokens === 19 && event.outputTokens === 3);
    assert.equal(forcedBRows.length, 1, "pre-validation forced usage was not recorded exactly once");
    assert.doesNotMatch(child.testErrors(), /PRIVATE_REASONING_MUST_NOT_LEAK|_codexRouterForcedTimeout|"input_tokens":31|"input_tokens":19/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("experimental authorization is proof-gated before the direct-dispatch transport switch", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push({ url: request.url, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "authorized-canary",
      output_text: "AUTHORIZED_CANARY_OK",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "AUTHORIZED_CANARY_OK" }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }));
  });
  const canary = MODEL_BY_SLUG.get("qwen-plan/qwen3.7-max");
  const resolved = { ...canary, effectiveFinalReasoningShape: "hybrid-summary", routable: true, visible: true };
  const validProof = {
    slug: canary.slug,
    provider: canary.provider,
    upstreamModel: canary.upstreamModel,
    transport: canary.effectiveTransport,
    toolDialect: canary.toolDialect,
    requestProfile: canary.requestProfile,
    verdict: "passing",
    verifierVersion: PROTOCOL_PROOF_VERIFIER_VERSION,
    fingerprint: registryFingerprint(canary, PROTOCOL_PROOF_VERIFIER_VERSION),
    measuredFinalReasoningShape: "hybrid-summary",
    verifiedAt: "2026-08-23T00:00:00.000Z",
  };
  const mismatchedProof = { ...validProof, transport: "anthropic-messages" };

  const exercise = async ({ name, legacyKillSwitch, nodeRoutes, protocolProofs, expectedStatus, expectedPath }) => {
    const before = seen.length;
    const routerPort = await openPort();
    const child = run({
      ...routerEnv(gw.port, routerPort, { legacyKillSwitch }),
      QWEN_PLAN_BASE_URL: `http://127.0.0.1:${gw.port}/qwen`,
      QWEN_PLAN_API_KEY: "direct-qwen-key",
    }, { chain: [], nodeRoutes, protocolProofs });
    try {
      await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
      for (const [suffix, input] of [
        ["/responses", "authorization ordinary"],
        ["/responses/compact", [{ type: "message", role: "user", content: [{ type: "input_text", text: "authorization compact" }] }]],
      ]) {
        const result = await readRouted(routerPort, { model: canary.slug, stream: false, input }, suffix);
        assert.equal(result.status, expectedStatus, `${name} ${suffix}: ${result.body}`);
        if (expectedStatus === 404) assert.equal(JSON.parse(result.body).error.code, "model_not_enabled", `${name} ${suffix}`);
      }
      const requests = seen.slice(before);
      if (expectedPath === undefined) assert.deepEqual(requests, [], `${name} contacted an upstream`);
      else assert.deepEqual(requests.map((entry) => entry.url), [expectedPath, expectedPath], name);
    } finally {
      await stopChild(child);
    }
  };

  try {
    await exercise({
      name: "kill switch with no resolved route or proof",
      legacyKillSwitch: true,
      nodeRoutes: [],
      expectedStatus: 404,
    });
    await exercise({
      name: "kill switch with stale route and mismatched proof",
      legacyKillSwitch: true,
      nodeRoutes: [resolved],
      protocolProofs: { [canary.slug]: mismatchedProof },
      expectedStatus: 404,
    });
    await exercise({
      name: "default transport with stale route and mismatched proof",
      legacyKillSwitch: false,
      nodeRoutes: [resolved],
      protocolProofs: { [canary.slug]: mismatchedProof },
      expectedStatus: 404,
    });
    await exercise({
      name: "default transport with an authorized route",
      legacyKillSwitch: false,
      nodeRoutes: [resolved],
      protocolProofs: { [canary.slug]: validProof },
      expectedStatus: 200,
      expectedPath: "/qwen/responses",
    });
    await exercise({
      name: "kill switch with an authorized route",
      legacyKillSwitch: true,
      nodeRoutes: [resolved],
      protocolProofs: { [canary.slug]: validProof },
      expectedStatus: 200,
      expectedPath: "/v1/responses",
    });
  } finally {
    await closeServer(gw.server);
  }
});

test("ordinary direct GLM continuation derives trusted provenance from its first-turn envelope", async () => {
  const requests = [];
  let continuationAttempts = 0;
  const messagesSse = (id, content) => {
    const events = [{ type: "message_start", message: { id, model: "glm-5.2", usage: { input_tokens: 4 } } }];
    for (const [index, block] of content.entries()) {
      events.push({ type: "content_block_start", index, content_block: { type: block.type, ...(block.type === "tool_use" ? { id: block.id, name: block.name, input: block.input } : {}) } });
      if (block.type === "thinking") {
        events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
        events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
      } else if (block.type === "text") {
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      }
      events.push({ type: "content_block_stop", index });
    }
    events.push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
    events.push({ type: "message_stop" });
    return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  };
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    requests.push({ url: request.url, body });
    assert.equal(request.url, "/qwen/messages");
    const text = JSON.stringify(body.messages);
    if (text.includes("GLM_FIRST_TURN")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(messagesSse("msg_glm_first", [
        { type: "thinking", thinking: "trusted private thought", signature: "provider-signature" },
        { type: "text", text: "FIRST_OK" },
      ]));
      return;
    }
    const thinking = body.messages.flatMap((message) => message.content || []).find((block) => block.type === "thinking");
    assert.deepEqual(thinking, { type: "thinking", thinking: "trusted private thought", signature: "provider-signature" });
    if (text.includes("CONTEXT CHECKPOINT COMPACTION")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(messagesSse("msg_glm_compact", [{ type: "text", text: "GLM_COMPACT_OK" }]));
      return;
    }
    if (text.includes("GLM_CONTINUE_TURN")) {
      continuationAttempts += 1;
      if (continuationAttempts === 1) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { type: "overloaded_error" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(messagesSse("msg_glm_second", [{ type: "text", text: "SECOND_OK" }]));
      return;
    }
    assert.fail(`unexpected GLM request: ${text}`);
  });
  const glm = MODEL_BY_SLUG.get("qwen-plan/glm-5.2");
  const resolved = { ...glm, effectiveFinalReasoningShape: "anthropic-thinking", routable: true, visible: true };
  const routerPort = await openPort();
  const child = run({
    ...routerEnv(gw.port, routerPort, { legacyKillSwitch: false }),
    QWEN_PLAN_BASE_URL: `http://127.0.0.1:${gw.port}/qwen`,
    QWEN_PLAN_API_KEY: "direct-qwen-key",
  }, { chain: [], nodeRoutes: [resolved] });
  const responseEvents = (body) => body.split(/\r\n\r\n|\n\n|\r\r/).flatMap((block) => {
    const data = block.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return [];
    return [JSON.parse(data)];
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const first = await readRouted(routerPort, { model: glm.slug, stream: true, input: "GLM_FIRST_TURN" });
    assert.equal(first.status, 200, first.body);
    const completed = responseEvents(first.body).find((event) => event.type === "response.completed");
    const reasoning = completed?.response?.output?.find((item) => item.type === "reasoning");
    assert.ok(reasoning, first.body);
    assert.match(reasoning.encrypted_content, /^cr\.reasoning\.v1\./);

    const continuationInput = [
      reasoning,
      { role: "user", content: [{ type: "input_text", text: "GLM_CONTINUE_TURN" }] },
    ];
    const second = await readRouted(routerPort, { model: glm.slug, stream: true, input: continuationInput });
    assert.equal(second.status, 200, second.body);
    assert.match(second.body, /SECOND_OK/);
    assert.equal(continuationAttempts, 2, "the signed continuation was not preserved across retry");

    const compact = await readRouted(routerPort, { model: glm.slug, stream: false, input: continuationInput }, "/responses/compact");
    assert.equal(compact.status, 200, compact.body);
    assert.match(compact.body, /GLM_COMPACT_OK/);
    assert.equal(requests.length, 4);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("an operator who turned failover off keeps the plain error", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { enabled: false, chain: [] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(seen.length, 1);
    assert.equal(result.status, 429);
    assert.doesNotMatch(child.testErrors(), /failover/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a provider that answers again clears the cooldown this router recorded", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("primary"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    // A stale window recorded earlier, for a provider that is in fact fine.
    // With nothing eligible to move to, the turn stays on the operator's own
    // model -- and its success is what retires the window. (A cooldown with a
    // candidate behind it is never probed; it expires on its own clock.)
    chain: ["gone/removed-model"],
    cooldowns: {
      deepseek: {
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        reason: "out_of_usage",
      },
    },
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-primary/);
    await waitForUsageEvents(child.stateDir, 1, child);
    const cooldowns = JSON.parse(
      readFileSync(path.join(child.stateDir, "provider-cooldowns.json"), "utf8"),
    );
    assert.equal(cooldowns.deepseek, undefined);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a fallback rebuild carries the full request, not a model swap", async () => {
  // The routed body is rebuilt for the fallback from the pristine payload.
  // The regression this guards is a second build over already-flattened tools,
  // which yields a plausible tool list with an empty namespace map.
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    await readRouted(routerPort, {
      ...TURN_BODY,
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Spawn a child agent.",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        },
      ],
    });
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    // Both attempts flattened the namespace the same way, from the same source.
    const names = (body) => (body.tools || []).map((tool) => tool.name).sort();
    assert.deepEqual(names(second), names(first));
    assert.ok(names(second).includes("collaboration__spawn_agent"));
    // A bare string is as legal an `input` as an array, and the rebuild must
    // hand the fallback the same prompt -- not the same prompt spread into its
    // own letters, which reaches the provider and still reads as a 200.
    assert.equal(first.input, "hello");
    assert.equal(second.input, "hello");
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

// -- crossing the protocol line ----------------------------------------------
//
// The rebuild trap in AGENTS.md, exercised. A chat-completions provider needs
// every namespace flattened into ordinary functions; a responses-native one
// needs the namespace shape kept. A failover that crosses that line has to
// rebuild for the *destination*, not reship the first build's tools -- and a
// second pass over an already-flattened list would return an empty namespace
// map, shipping plausible tools the response transform can no longer map back.

const RESPONSES_MODEL = {
  slug: "opencode-go-responses/gpt-5.6-luna",
  gatewayModel: "opencode-go-responses-gpt-5-6-luna",
};

const NAMESPACE_TOOLS = [
  {
    type: "namespace",
    name: "collaboration",
    tools: [
      {
        type: "function",
        name: "spawn_agent",
        description: "Spawn a child agent.",
        parameters: {
          type: "object",
          properties: { task: { type: "string" } },
          required: ["task"],
          additionalProperties: false,
        },
      },
    ],
  },
];

function toolNames(body) {
  return (body.tools || []).map((tool) => `${tool.type}:${tool.name}`).sort();
}

test("a chat-completions turn failing over to a responses provider keeps the namespace", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("responses-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { chain: [RESPONSES_MODEL.slug] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, { ...TURN_BODY, tools: NAMESPACE_TOOLS });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    assert.equal(first.model, PRIMARY.gatewayModel);
    assert.equal(second.model, RESPONSES_MODEL.gatewayModel);

    // The chat-completions attempt flattened the namespace into plain functions
    // (alongside the merged codex_app toolset, which only that branch adds).
    assert.ok(toolNames(first).includes("function:collaboration__spawn_agent"));
    assert.ok(!toolNames(first).some((name) => name.startsWith("namespace:")));
    // The responses-native attempt must have been rebuilt from the pristine
    // payload and kept the namespace intact. A flattened name here is the exact
    // regression this guards: the second build reusing the first's rewritten
    // tool list, which also yields an empty namespace map.
    assert.deepEqual(toolNames(second), ["namespace:collaboration"]);
    assert.equal(second.tools[0].tools[0].name, "spawn_agent");
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a responses turn failing over to a chat-completions provider flattens it", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === RESPONSES_MODEL.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(contentSse("chat-fallback"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), { chain: [FALLBACK.slug] });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, {
      model: RESPONSES_MODEL.slug,
      input: "hello",
      stream: true,
      tools: NAMESPACE_TOOLS,
    });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    assert.deepEqual(toolNames(first), ["namespace:collaboration"]);
    // Rebuilt for a chat-completions destination: the namespace is gone and the
    // call is an ordinary function the provider can actually invoke.
    assert.ok(toolNames(second).includes("function:collaboration__spawn_agent"));
    assert.ok(!toolNames(second).some((name) => name.startsWith("namespace:")));
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

// A fallback that answers with a flattened tool call. The response transform has
// to map it back to the client's namespace shape using the *fallback's* map and
// slug -- the ones adopted during the swap, not the exhausted model's.
function toolCallSse(name) {
  const args = JSON.stringify({ task: "audit the map" });
  const events = [
    { type: "response.created", response: { id: "r-tool" } },
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", name, arguments: "" },
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: args },
    { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: args },
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_1", name, arguments: args },
    },
    {
      type: "response.completed",
      response: {
        id: "r-tool",
        output: [{ type: "function_call", id: "fc_1", name, arguments: args }],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    },
  ];
  return `${events
    .map((entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

test("a tool call from the fallback is mapped back to the client's namespace", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(toolCallSse("collaboration__spawn_agent"));
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, { ...TURN_BODY, tools: NAMESPACE_TOOLS });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    // Restored to the namespaced shape Codex registered, not the flattened name
    // the provider was given. Without the swap adopting the fallback's namespace
    // map, the call would reach the client as `collaboration__spawn_agent` and
    // Codex would reject a tool it never registered.
    assert.match(result.body, /"namespace":"collaboration"/);
    assert.match(result.body, /"name":"spawn_agent"/);
    assert.doesNotMatch(result.body, /"name":"collaboration__spawn_agent"/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("failover walks past a candidate that is also out of usage", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body.model);
    if (body.model === RESPONSES_MODEL.gatewayModel) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(contentSse("second-candidate"));
      return;
    }
    // Both the asked-for model and the first candidate report empty.
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [FALLBACK.slug, RESPONSES_MODEL.slug],
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    assert.equal(result.status, 200);
    assert.match(result.body, /answered-by-second-candidate/);
    // Asked model, first candidate, second candidate -- and no further, because
    // the hop bound stops there.
    assert.deepEqual(seen, [
      PRIMARY.gatewayModel,
      FALLBACK.gatewayModel,
      RESPONSES_MODEL.gatewayModel,
    ]);
    // The candidate that also reported empty is cooled down on its own account.
    const events = await waitForUsageEvents(child.stateDir, 2, child);
    assert.equal(events.at(-1).failoverFrom, PRIMARY.slug);
    assert.equal(events.at(-1).model, RESPONSES_MODEL.slug);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("the hop bound stops after two candidates rather than walking the catalog", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body.model);
    const payload = Buffer.from(QUOTA_BODY, "utf8");
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort), {
    chain: [FALLBACK.slug, RESPONSES_MODEL.slug, "kimi-api/kimi-k3"],
  });
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, TURN_BODY);
    // Everything failed, so the operator reads the failure their own model gave.
    assert.equal(result.status, 429);
    assert.equal(JSON.parse(result.body).error.type, "billing_error");
    // One asked-for attempt plus at most MAX_FAILOVER_HOPS candidates.
    assert.equal(seen.length, 3);
    assert.equal(seen[0], PRIMARY.gatewayModel);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a non-streaming turn fails over the same way", async () => {
  const seen = [];
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    seen.push(body);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    const payload = Buffer.from(
      JSON.stringify({
        id: "r-json",
        object: "response",
        model: body.model,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answered-by-json-fallback" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }),
      "utf8",
    );
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const result = await readRouted(routerPort, { ...TURN_BODY, stream: false });
    assert.equal(result.status, 200);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].model, FALLBACK.gatewayModel);
    assert.match(result.body, /answered-by-json-fallback/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});

test("a client that leaves mid-failover does not hang or crash the router", async () => {
  let fallbackStarted = 0;
  // Resolved the instant the fallback hop reaches the gateway. The abort has to
  // land *during* that hop, and the only honest way to know the hop is in
  // flight is to be told by the end that received it. A wall-clock delay only
  // guesses at it: on a loaded machine the router had not finished the 429 and
  // reopened against the fallback before the guess expired, so the caller left
  // before there was a failover to leave, and the run failed on
  // `fallbackStarted >= 1` roughly one time in five.
  let announceFallback;
  const fallbackInFlight = new Promise((resolve) => {
    announceFallback = resolve;
  });
  const gw = await gateway(async (request, response) => {
    const body = await bodyJson(request);
    if (body.model === PRIMARY.gatewayModel) {
      const payload = Buffer.from(QUOTA_BODY, "utf8");
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Content-Length": String(payload.length),
      });
      response.end(payload);
      return;
    }
    // The fallback is slow, so the abort lands while the hop is in flight --
    // the window the failover loop has to notice the caller is gone. The hold
    // is far longer than the abort needs, so the abort is inside it whatever
    // the machine is doing.
    fallbackStarted += 1;
    announceFallback();
    setTimeout(() => {
      if (response.writableEnded) return;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(contentSse("late"));
    }, 3_000);
  });
  const routerPort = await openPort();
  const child = run(routerEnv(gw.port, routerPort));
  try {
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    const base = new URL(`${callerBaseUrl(routerPort, CALLER_KEY)}/responses`);
    let leave;
    const aborted = new Promise((resolve) => {
      const outbound = http.request(
        {
          host: "127.0.0.1",
          port: routerPort,
          path: base.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
        },
        (response) => response.resume(),
      );
      outbound.on("error", () => resolve());
      outbound.end(JSON.stringify(TURN_BODY));
      leave = () => {
        outbound.destroy();
        resolve();
      };
    });
    // Leave as soon as the fallback hop is on the gateway's floor. The deadline
    // is only there so a router that never gets that far fails on the assertion
    // below rather than hanging the run.
    let deadline;
    await Promise.race([
      fallbackInFlight,
      new Promise((resolve) => {
        deadline = setTimeout(resolve, 20_000);
      }),
    ]);
    clearTimeout(deadline);
    leave();
    await aborted;

    // The router must still be serving, and a later turn must behave normally.
    await waitFor(`http://127.0.0.1:${routerPort}/health`, child);
    assert.equal(child.exitCode, null, `router exited: ${child.testErrors()}`);
    assert.ok(fallbackStarted >= 1, "the failover hop should have been attempted");
    // A departed caller meters as 0 rather than as a committed success.
    const events = await waitForUsageEvents(child.stateDir, 1, child);
    assert.ok(events.length >= 1);
    assert.doesNotMatch(child.testErrors(), /UnhandledPromiseRejection|FATAL/);
  } finally {
    await stopChild(child);
    await closeServer(gw.server);
  }
});
