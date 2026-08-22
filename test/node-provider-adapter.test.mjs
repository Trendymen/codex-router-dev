import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  adaptOpenAIResponses,
  buildOpenAIResponsesRequest,
  createResponsesRelayContext,
  restoreOpenAIResponsesEvent,
} from "../src/openai-responses-adapter.mjs";
import { providerEndpoint } from "../src/provider-endpoint.mjs";
import { createForcedDispatchDeadline } from "../src/forced-dispatch-deadline.mjs";
import { openPort } from "./port-pool.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL_KEY = "task4-direct-responses-internal-key";

const deepseek = Object.freeze({
  slug: "deepseek/deepseek-v4-flash",
  upstreamModel: "deepseek-v4-flash",
  effectiveTransport: "openai-responses",
  toolDialect: "responses-functions",
  reasoningDisplayMode: "summary-compat",
  effectiveFinalReasoningShape: "raw-content",
  requestProfile: "deepseek-thinking",
  baseUrl: "https://api.deepseek.com",
});

const qwen = Object.freeze({
  slug: "qwen-plan/qwen3.8-max",
  upstreamModel: "qwen3.8-max",
  effectiveTransport: "openai-responses",
  toolDialect: "responses-functions",
  reasoningDisplayMode: "summary-compat",
  effectiveFinalReasoningShape: "hybrid-summary",
  requestProfile: "qwen-plan",
  baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
});

const input = Object.freeze([
  { role: "user", content: [{ type: "input_text", text: "hello" }] },
]);

async function through(transforms, chunks) {
  const output = [];
  await pipeline(
    Readable.from(chunks),
    ...transforms,
    new Writable({ write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } }),
  );
  return Buffer.concat(output).toString("utf8");
}

async function directServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: server.address().port };
}
function directForwarder(port, base, { env = {}, importFile } = {}) {
  const child = spawn(process.execPath, [...(importFile ? ["--import", pathToFileURL(importFile).href] : []), path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: { ...process.env, ...env, MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "task4-direct-")), CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY, CODEX_ROUTER_API_PORT: String(port), DEEPSEEK_API_BASE_URL: base, DEEPSEEK_API_KEY: "DIRECT_SECRET_MUST_NOT_LEAK", CODEX_ROUTER_QUIET: "1" },
    stdio: "ignore",
  });
  return child;
}

function abortTracePreload({ accelerateDeadline = false } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "task4-abort-trace-"));
  const trace = path.join(directory, "trace.jsonl");
  const preload = path.join(directory, "preload.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import http from "node:http";
const trace = ${JSON.stringify(trace)};
const NativeAbortController = globalThis.AbortController;
globalThis.AbortController = class extends NativeAbortController {
  constructor() { super(); this.traceOwner = new Error().stack?.split("\\n")[2]?.includes("handleRequest") === true; }
  abort(reason) { if (this.traceOwner) appendFileSync(trace, JSON.stringify({ type: "abort", reason }) + "\\n"); return super.abort(reason); }
};
const nativeEnd = http.ServerResponse.prototype.end;
http.ServerResponse.prototype.end = function (...args) {
  if (this._codexRouterRequestTelemetry?.forcedUsage) appendFileSync(trace, JSON.stringify({ type: "usage", frozen: Object.isFrozen(this._codexRouterRequestTelemetry.forcedUsage) && Object.isFrozen(this._codexRouterRequestTelemetry.forcedUsage.input_tokens_details), value: this._codexRouterRequestTelemetry.forcedUsage }) + "\\n");
  return nativeEnd.apply(this, args);
};
${accelerateDeadline ? `const nativeSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (fn, delay, ...args) => nativeSetTimeout(fn, delay === 30_001 ? 20 : delay, ...args);` : ""}
`, "utf8");
  return { preload, trace, events() { try { return readFileSync(trace, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } } };
}
async function waitForwarder(port) {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${INTERNAL_KEY}` } })).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("api forwarder did not start");
}
async function stop(child, server) {
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)); }
  await new Promise((resolve) => server.close(resolve));
}

test("provider endpoints append /responses without discarding provider base paths", () => {
  assert.equal(
    providerEndpoint("https://api.deepseek.com", "responses").href,
    "https://api.deepseek.com/responses",
  );
  assert.equal(
    providerEndpoint("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "responses").href,
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses",
  );
  assert.equal(
    providerEndpoint("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/", "/responses").href,
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses",
  );
  for (const leaf of ["https://evil.example/responses", "//evil.example/responses", "responses?x=1", "responses#x", "a\\b", "../responses", "./responses"]) {
    assert.throws(() => providerEndpoint("https://api.deepseek.com/v1", leaf), TypeError, leaf);
  }
});

test("injected dispatch deadline admits 30000 and aborts once at 30001 without waiting", () => {
  let callback;
  let delay;
  let cancels = 0;
  let reason;
  const controller = new AbortController();
  const deadline = createForcedDispatchDeadline({
    signal: controller.signal,
    onTimeout: (nextReason) => { cancels += 1; reason = nextReason; controller.abort(nextReason); },
    timers: { setTimeout(fn, value) { callback = fn; delay = value; return 1; }, clearTimeout() {} },
  });
  assert.equal(delay, 30_001);
  assert.equal(controller.signal.aborted, false);
  callback(); callback();
  assert.equal(controller.signal.aborted, true);
  assert.equal(deadline.fired, true);
  assert.equal(cancels, 1);
  assert.equal(reason, "forced_tool_buffer_timeout");
});

test("DeepSeek Responses preserves nested reasoning and never emits chat-only thinking fields", () => {
  const built = buildOpenAIResponsesRequest({
    model: deepseek,
    credential: { value: "DEEPSEEK_TEST_KEY" },
    payload: {
      model: "responses/deepseek-v4-flash",
      input,
      reasoning: { effort: "max", summary: "auto" },
      thinking: { type: "enabled" },
      think: { type: "enabled" },
      reasoning_effort: "max",
      tool_choice: "required",
    },
  });
  assert.equal(built.url.href, "https://api.deepseek.com/responses");
  assert.equal(built.headers.Authorization, "Bearer DEEPSEEK_TEST_KEY");
  assert.deepEqual(built.json.reasoning, { effort: "max", summary: "auto" });
  assert.equal(built.json.thinking, undefined);
  assert.equal(built.json.think, undefined);
  assert.equal(built.json.reasoning_effort, undefined);
  assert.equal(built.json.tool_choice, "auto");
  assert.equal(built.json.model, "deepseek-v4-flash");
});

test("Qwen Responses forces store false, lowers forced choices, and removes reasoning only for the GLM compatibility slug", () => {
  const normal = buildOpenAIResponsesRequest({
    model: qwen,
    credential: { value: "QWEN_TEST_KEY" },
    payload: {
      input,
      reasoning: { effort: "high" },
      think: { type: "enabled" },
      store: true,
      tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: "run" },
    },
  });
  assert.equal(normal.url.href, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses");
  assert.equal(normal.json.store, false);
  assert.deepEqual(normal.json.reasoning, { effort: "high" });
  assert.equal(normal.json.think, undefined);
  assert.equal(normal.json.tool_choice, "auto");

  const glm = buildOpenAIResponsesRequest({
    model: { ...qwen, slug: "qwen-plan-responses/glm-5.2", upstreamModel: "glm-5.2" },
    credential: { value: "QWEN_TEST_KEY" },
    payload: { input, reasoning: { effort: "high" }, max_output_tokens: 1234 },
  });
  assert.equal("reasoning" in glm.json, false);
  assert.equal(glm.json.max_output_tokens, 1234);
});

test("GLM Responses maps tools while preserving required/named choice semantics", () => {
  const tool = { type: "function", name: "run", strict: true, parameters: { type: "object", properties: {} } };
  const glm = buildOpenAIResponsesRequest({
    model: { ...qwen, slug: "qwen-plan-responses/glm-5.2", upstreamModel: "glm-5.2" },
    credential: { value: "QWEN_TEST_KEY" },
    payload: { input, tools: [tool], tool_choice: { type: "function", name: "run" }, reasoning: { effort: "high" } },
  });
  assert.equal(glm.json.tools[0].name, "run");
  assert.deepEqual(glm.json.tool_choice, { type: "function", name: "run" });
  assert.equal(glm.toolBuild.forcedRequirement, undefined);
  assert.equal("reasoning" in glm.json, false);

  const mapped = buildOpenAIResponsesRequest({
    model: { ...qwen, slug: "qwen-plan-responses/glm-5.2", upstreamModel: "glm-5.2" },
    payload: {
      input: [{ type: "custom_tool_call", call_id: "old", name: "shell", input: "pwd" }],
      tools: [
        { type: "custom", name: "shell", description: "run" },
        { type: "namespace", name: "mcp", tools: [{ type: "function", name: "读", strict: true, parameters: { type: "object", properties: {} } }] },
      ],
      tool_choice: { type: "function", namespace: "mcp", name: "读" },
    },
  });
  assert.notEqual(mapped.json.tool_choice.name, "读");
  assert.equal(mapped.json.tools[1].strict, true);
  assert.equal(mapped.json.input[0].type, "function_call");

  const customNamed = buildOpenAIResponsesRequest({
    model: { ...qwen, slug: "qwen-plan-responses/glm-5.2", upstreamModel: "glm-5.2" },
    payload: {
      input,
      tools: [{ type: "custom", name: "shell", description: "run" }],
      tool_choice: { type: "custom", name: "shell" },
    },
  });
  assert.deepEqual(customNamed.json.tool_choice, { type: "function", name: customNamed.json.tools[0].name });
  assert.notEqual(customNamed.json.tool_choice.name, "shell");

  const required = buildOpenAIResponsesRequest({
    model: { ...qwen, slug: "qwen-plan-responses/glm-5.2", upstreamModel: "glm-5.2" },
    payload: { input, tools: [tool], tool_choice: "required" },
  });
  assert.equal(required.json.tool_choice, "required");
  assert.equal(required.json.tools[0].strict, true);
});

test("adapter normalizes final JSON only for third-party Responses and native OpenAI bypasses byte-identically", () => {
  const thirdParty = adaptOpenAIResponses({
    model: deepseek,
    upstream: new Response(JSON.stringify({
      id: "resp_1",
      output: [{ id: "reasoning_1", type: "reasoning", content: [{ type: "reasoning_text", text: "private" }], summary: [] }],
      usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } },
    }), { headers: { "content-type": "application/json" } }),
  });
  assert.equal(thirdParty.transforms.length, 1);

  const native = adaptOpenAIResponses({
    model: { ...deepseek, effectiveTransport: "native-openai" },
    upstream: new Response("native-bytes"),
  });
  assert.equal(native.upstream, native.upstream);
  assert.deepEqual(native.transforms, []);
});

test("adapter composes third-party JSON through tool and reasoning normalization while preserving provider cache usage", async () => {
  const raw = JSON.stringify({
    id: "resp_1",
    output: [{ id: "reasoning_1", type: "reasoning", content: [{ type: "reasoning_text", text: "private" }], summary: [] }],
    usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } },
  });
  const adapter = adaptOpenAIResponses({
    model: deepseek,
    upstream: new Response(raw, { headers: { "content-type": "application/json" } }),
  });
  const output = JSON.parse(await through(adapter.transforms, [raw]));
  assert.deepEqual(output.output[0].summary, [{ type: "summary_text", text: "private" }]);
  assert.deepEqual(output.output[0].content, []);
  assert.deepEqual(output.usage.input_tokens_details, { cached_tokens: 3 });
});

test("malformed third-party Responses streams fail in the adapter and cannot fall back to chat completions", async () => {
  const adapter = adaptOpenAIResponses({
    model: deepseek,
    upstream: new Response("", { headers: { "content-type": "text/event-stream" } }),
  });
  await assert.rejects(
    through(adapter.transforms, ["data: {not-json}\n\n"]),
    /provider_response_malformed/,
  );
});

test("custom argument delta frames are dropped instead of serializing data undefined", async () => {
  const request = buildOpenAIResponsesRequest({
    model: deepseek,
    payload: { input, tools: [{ type: "custom", name: "shell", description: "run shell text" }] },
  });
  const added = { type: "response.output_item.added", item: { id: "item_1", type: "function_call", name: request.toolBuild.tools[0].name, call_id: "call_1", arguments: "" } };
  const delta = { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"input":"echo ' };
  const done = { type: "response.function_call_arguments.done", item_id: "item_1", arguments: '{"input":"echo hi"}' };
  const adapter = adaptOpenAIResponses({
    model: { ...deepseek, reasoningDisplayMode: "raw-preserve" },
    upstream: new Response("", { headers: { "content-type": "text/event-stream" } }),
    requestContext: { toolBuild: request.toolBuild },
  });
  const output = await through(adapter.transforms, [
    `data: ${JSON.stringify(added)}\n\n`,
    `data: ${JSON.stringify(delta)}\n\n`,
    `data: ${JSON.stringify(done)}\n\n`,
    "data: [DONE]\n\n",
  ]);
  assert.doesNotMatch(output, /undefined/);
  assert.doesNotMatch(output, /function_call_arguments\.delta/);
  assert.match(output, /response\.custom_tool_call_input\.done/);
});

test("an aborted forced coordinator never releases already held provider bytes", async () => {
  const request = buildOpenAIResponsesRequest({
    model: deepseek,
    payload: { input, tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }], tool_choice: "required" },
  });
  const controller = new AbortController();
  const adapter = adaptOpenAIResponses({
    model: { ...deepseek, reasoningDisplayMode: "raw-preserve" },
    upstream: new Response("", { headers: { "content-type": "text/event-stream" } }),
    requestContext: { toolBuild: request.toolBuild, signal: controller.signal, abort() {} },
  });
  const held = `data: ${JSON.stringify({ type: "response.created", sequence_number: 1, response: { id: "resp_must_not_release", model: "provider-secret", output: [] } })}\n\n`;
  const source = new Readable({
    read() {
      this.push(held);
      controller.abort("caller_aborted");
      this.push("data: [DONE]\n\n");
      this.push(null);
    },
  });
  const output = [];
  await pipeline(source, ...adapter.transforms, new Writable({ write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } }));
  assert.equal(Buffer.concat(output).length, 0);
});

test("byte framer accepts CR-only and split mixed SSE delimiters without changing untouched frames", async () => {
  const frames = [
    "event: note\rdata: {\"type\":\"response.created\",\"label\":\"月\"}\r\r",
    ": heartbeat\r\r",
    "data: [DONE]\r\r",
  ];
  const adapter = adaptOpenAIResponses({
    model: { ...deepseek, reasoningDisplayMode: "raw-preserve" },
    upstream: new Response("", { headers: { "content-type": "text/event-stream" } }),
  });
  const bytes = Buffer.from(frames.join(""));
  const split = bytes.indexOf(Buffer.from("月")) + 1;
  assert.equal(await through(adapter.transforms, [bytes.subarray(0, split), bytes.subarray(split)]), frames.join(""));
});

test("standalone completed responses reject duplicate item IDs before relay even when call IDs differ", () => {
  const request = buildOpenAIResponsesRequest({
    model: deepseek,
    credential: { value: "DEEPSEEK_TEST_KEY" },
    payload: {
      input,
      tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }],
    },
  });
  const completed = {
    type: "response.completed",
    response: {
      output: [
        { id: "item_same", type: "function_call", name: "run", call_id: "call_one", arguments: "{}" },
        { id: "item_same", type: "function_call", name: "run", call_id: "call_two", arguments: "{}" },
      ],
    },
  };
  assert.throws(() => restoreOpenAIResponsesEvent(completed, request.toolBuild), /tool_mapping_error/);
});

test("forced JSON Responses validates before relay at the exact 8 MiB boundary", async () => {
  const request = buildOpenAIResponsesRequest({
    model: deepseek,
    payload: {
      input,
      tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }],
      tool_choice: "required",
    },
  });
  const completed = JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_forced_json",
      model: "deepseek-v4-flash",
      output: [{ id: "item_json", type: "function_call", name: request.toolBuild.tools[0].name, call_id: "call_json", arguments: "{}" }],
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  });
  const atLimit = Buffer.concat([Buffer.alloc(8 * 1024 * 1024 - Buffer.byteLength(completed), 0x20), Buffer.from(completed)]);
  const context = createResponsesRelayContext();
  const adapter = adaptOpenAIResponses({
    model: deepseek,
    upstream: new Response("", { headers: { "content-type": "application/json" } }),
    requestContext: { toolBuild: request.toolBuild, relayContext: context },
  });
  const output = await through(adapter.transforms, [atLimit]);
  assert.match(output, /resp_forced_json/);
  assert.equal(context.relayedBytes, Buffer.byteLength(output));

  const overLimit = Buffer.concat([Buffer.from(" "), atLimit]);
  const rejected = adaptOpenAIResponses({
    model: deepseek,
    upstream: new Response("", { headers: { "content-type": "application/json" } }),
    requestContext: { toolBuild: request.toolBuild },
  });
  await assert.rejects(through(rejected.transforms, [overLimit]), /forced_tool_buffer_limit/);
});

test("direct forced JSON failure is a safe zero-byte pre-relay response", async () => {
  const seen = [];
  const upstream = await directServer(async (request, response) => {
    seen.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      type: "response.completed",
      response: { id: "resp_upstream_secret", model: "provider-secret", output: [], usage: { input_tokens: 1 } },
    }));
  });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`);
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash", input: "hello",
        tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }],
        tool_choice: "required",
      }),
    });
    const body = await response.text();
    assert.deepEqual(seen, ["/v1/responses"]);
    assert.equal(response.status, 422);
    assert.match(body, /required_tool_not_called/);
    assert.doesNotMatch(body, /resp_upstream_secret|provider-secret|DIRECT_SECRET_MUST_NOT_LEAK/);
  } finally { await stop(forwarder, upstream.server); }
});

test("post-relay adapter failure continues the real response once with a safe terminal", async () => {
  const upstream = await directServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "data: " + JSON.stringify({
        type: "response.created", sequence_number: 7,
        response: { id: "resp_actual_7", model: "deepseek-actual", output: [], usage: { input_tokens: 4, output_tokens: 1 } },
      }) + "\n\n" +
      "data: {malformed}\n\n",
    );
  });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`);
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello" }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /resp_actual_7/);
    assert.match(body, /deepseek-actual/);
    assert.match(body, /"sequence_number":8/);
    assert.equal((body.match(/response\.failed/g) || []).length, 1);
    assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1);
    assert.doesNotMatch(body, /malformed|DIRECT_SECRET_MUST_NOT_LEAK/);
  } finally { await stop(forwarder, upstream.server); }
});

test("caller cancellation aborts a direct forced dispatch without relaying or retrying", async () => {
  let arrived;
  let upstreamClosed;
  const arrivedAtUpstream = new Promise((resolve) => { arrived = resolve; });
  const closedUpstream = new Promise((resolve) => { upstreamClosed = resolve; });
  const upstream = await directServer((request, _response) => {
    arrived();
    request.once("close", upstreamClosed);
    // Deliberately never write headers: cancellation must reach fetch itself,
    // rather than depending on a provider body or a real-time timeout.
  });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`);
  try {
    await waitForwarder(port);
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-flash", input: "hello",
        tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }], tool_choice: "required",
      }),
    });
    await arrivedAtUpstream;
    controller.abort();
    await assert.rejects(request, /abort/i);
    await Promise.race([
      closedUpstream,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream was not cancelled")), 1_000)),
    ]);
  } finally { await stop(forwarder, upstream.server); }
});

test("real forwarder caller cancellation invokes the dispatch abort owner exactly once", async () => {
  let arrived;
  const arrivedAtUpstream = new Promise((resolve) => { arrived = resolve; });
  const upstream = await directServer((_request, _response) => { arrived(); });
  const trace = abortTracePreload();
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`, { importFile: trace.preload });
  try {
    await waitForwarder(port);
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello", tools: [{ type: "function", name: "run", parameters: { type: "object" } }], tool_choice: "required" }),
    });
    await arrivedAtUpstream;
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(trace.events().filter((event) => event.type === "abort" && /^caller_/.test(event.reason)).length, 1);
  } finally { await stop(forwarder, upstream.server); }
});

test("real forwarder coordinator failure aborts once after privately snapshotting usage", async () => {
  const upstream = await directServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "data: " + JSON.stringify({ type: "response.created", sequence_number: 1, response: { id: "resp_usage_abort", model: "deepseek-v4-flash", output: [] }, usage: { input_tokens: 9, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } }) + "\n\n" +
      "data: " + JSON.stringify({ type: "response.completed", sequence_number: 2, response: { id: "resp_usage_abort", model: "deepseek-v4-flash", output: [] } }) + "\n\n" +
      "data: [DONE]\n\n",
    );
  });
  const trace = abortTracePreload();
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`, { importFile: trace.preload });
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello", tools: [{ type: "function", name: "run", parameters: { type: "object" } }], tool_choice: "required" }),
    });
    const body = await response.text();
    const events = trace.events();
    assert.equal(events.filter((event) => event.type === "abort" && event.reason === "forced_tool_coordinator").length, 1);
    assert.equal(events.find((event) => event.type === "usage")?.frozen, true);
    assert.deepEqual(events.find((event) => event.type === "usage")?.value, { input_tokens: 9, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } });
    assert.doesNotMatch(body, /input_tokens|cached_tokens|resp_usage_abort/);
  } finally { await stop(forwarder, upstream.server); }
});

test("real forwarder deadline aborts once and classifies only that owner reason", async () => {
  const upstream = await directServer((_request, _response) => {});
  const trace = abortTracePreload({ accelerateDeadline: true });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`, { importFile: trace.preload });
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello", tools: [{ type: "function", name: "run", parameters: { type: "object" } }], tool_choice: "required" }),
    });
    assert.equal(response.status, 504);
    assert.match(await response.text(), /forced_tool_buffer_timeout/);
    assert.equal(trace.events().filter((event) => event.type === "abort" && event.reason === "forced_tool_buffer_timeout").length, 1);
  } finally { await stop(forwarder, upstream.server); }
});

test("forced provider 429 bypasses validation and preserves its status and retry header", async () => {
  const upstream = await directServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "17" });
    response.end(JSON.stringify({ error: { message: "provider throttle" } }));
  });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`);
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello", tools: [{ type: "function", name: "run", parameters: { type: "object" } }], tool_choice: "required" }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "17");
    assert.match(await response.text(), /provider throttle/);
  } finally { await stop(forwarder, upstream.server); }
});

test("slow forced 429 clears its deadline immediately after headers and remains opaque JSON", async () => {
  const upstream = await directServer((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "23" });
    response.flushHeaders();
    setTimeout(() => response.end(JSON.stringify({ error: { message: "slow provider throttle" } })), 80);
  });
  const trace = abortTracePreload({ accelerateDeadline: true });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`, { importFile: trace.preload });
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello", tools: [{ type: "function", name: "run", parameters: { type: "object" } }], tool_choice: "required" }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "23");
    assert.equal(await response.text(), JSON.stringify({ error: { message: "slow provider throttle" } }));
    assert.equal(trace.events().filter((event) => event.type === "abort").length, 0);
  } finally { await stop(forwarder, upstream.server); }
});

test("multiline data frames parse as one event while unchanged bytes remain exact", async () => {
  const raw = "event: response\r\ndata: {\"type\":\r\ndata: \"response.created\",\"sequence_number\":1,\"response\":{\"id\":\"resp_multiline\",\"model\":\"deepseek-v4-flash\",\"output\":[]}}\r\n\r\n: untouched comment\n\ndata: [DONE]\r\r";
  const adapter = adaptOpenAIResponses({
    model: { ...deepseek, reasoningDisplayMode: "raw-preserve" },
    upstream: new Response("", { headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(await through(adapter.transforms, [Buffer.from(raw)]), raw);
});

test("real ToolBuild preserves semantically unchanged multiline and unknown frames byte-for-byte", async () => {
  const request = buildOpenAIResponsesRequest({
    model: deepseek,
    payload: { input, tools: [{ type: "function", name: "run", parameters: { type: "object", properties: {} } }] },
  });
  const raw = "event: vendor-extension\r\ndata: {\"type\":\r\ndata: \"vendor.unknown\",\"nested\":{\"value\":1}}\r\n\r\ndata: [DONE]\r\r";
  const adapter = adaptOpenAIResponses({
    model: { ...deepseek, reasoningDisplayMode: "raw-preserve" },
    upstream: new Response("", { headers: { "content-type": "text/event-stream" } }),
    requestContext: { toolBuild: request.toolBuild },
  });
  assert.equal(await through(adapter.transforms, [Buffer.from(raw)]), raw);
});

test("slow consumer demand-drains 100 and 600 ordinary SSE frames with O(frames) wakeups", async () => {
  for (const count of [100, 600]) {
    const frames = Array.from({ length: count }, (_, sequence_number) => `data: ${JSON.stringify({ type: "response.created", sequence_number, response: { id: "resp_slow", model: "deepseek-v4-flash", output: [] } })}\n\n`);
    const adapter = adaptOpenAIResponses({
      model: { ...deepseek, reasoningDisplayMode: "raw-preserve" },
      upstream: new Response("", { headers: { "content-type": "text/event-stream" } }),
    });
    const output = [];
    await pipeline(
      Readable.from(frames),
      ...adapter.transforms,
      new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); setImmediate(callback); } }),
    );
    assert.equal(Buffer.concat(output).toString("utf8"), frames.join(""));
    assert.ok(adapter.relayContext.readWakeups > 0);
    assert.ok(adapter.relayContext.readWakeups <= count + 4, `${count} frames caused ${adapter.relayContext.readWakeups} wakeups`);
  }
});

test("invalid completed reasoning is not committed and becomes one failed terminal with real monotonic context", async () => {
  const upstream = await directServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "data: " + JSON.stringify({ type: "response.created", sequence_number: 7, response: { id: "resp_invalid_terminal", model: "deepseek-actual", output: [] } }) + "\n\n" +
      "data: " + JSON.stringify({ type: "response.output_item.done", sequence_number: 5, output_index: 0, item: { id: "message_1", type: "message", status: "completed", role: "assistant", content: [] } }) + "\n\n" +
      "data: " + JSON.stringify({ type: "response.completed", sequence_number: 8, response: { id: "resp_invalid_terminal", model: "deepseek-actual", output: [{ id: "reasoning_missing", type: "reasoning", summary: [] }] } }) + "\n\n" +
      "data: {malformed}\n\n",
    );
  });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`);
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello" }),
    });
    const body = await response.text();
    assert.equal((body.match(/response\.completed/g) || []).length, 0);
    assert.equal((body.match(/response\.failed/g) || []).length, 1);
    assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1);
    assert.match(body, /"sequence_number":8/);
    assert.match(body, /message_1/);
  } finally { await stop(forwarder, upstream.server); }
});

test("a relayed completed terminal prevents a second failure terminal", async () => {
  const upstream = await directServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      "data: " + JSON.stringify({ type: "response.completed", sequence_number: 7, response: { id: "resp_done", model: "deepseek-v4-flash", output: [], usage: { input_tokens: 1 } } }) + "\n\n" +
      "data: {malformed}\n\n",
    );
  });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/v1`);
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello" }),
    });
    const body = await response.text();
    assert.equal((body.match(/response\.completed/g) || []).length, 1);
    assert.equal((body.match(/response\.failed/g) || []).length, 0);
    assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1);
  } finally { await stop(forwarder, upstream.server); }
});

test("direct /responses reaches only the provider Responses leaf and emits a redacted public failure", async () => {
  const seen = [];
  const upstream = await directServer(async (request, response) => {
    seen.push(request.url);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: {not-json}\n\n");
  });
  const port = await openPort(); const forwarder = directForwarder(port, `http://127.0.0.1:${upstream.port}/compatible-mode/v1`);
  try {
    await waitForwarder(port);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${INTERNAL_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "hello", tool_choice: "required" }),
    });
    const body = await response.text();
    assert.deepEqual(seen, ["/compatible-mode/v1/responses"]);
    assert.equal(response.status, 502);
    assert.match(body, /reasoning_protocol_error/);
    assert.doesNotMatch(body, /DIRECT_SECRET_MUST_NOT_LEAK|not-json|chat\/completions/);
  } finally { await stop(forwarder, upstream.server); }
});
