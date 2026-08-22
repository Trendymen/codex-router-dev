import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  adaptOpenAIResponses,
  buildOpenAIResponsesRequest,
  restoreOpenAIResponsesEvent,
} from "../src/openai-responses-adapter.mjs";
import { providerEndpoint } from "../src/provider-endpoint.mjs";
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
function directForwarder(port, base) {
  const child = spawn(process.execPath, [path.join(root, "src", "api-forwarder.mjs")], {
    cwd: root,
    env: { ...process.env, MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "task4-direct-")), CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY, CODEX_ROUTER_API_PORT: String(port), DEEPSEEK_API_BASE_URL: base, DEEPSEEK_API_KEY: "DIRECT_SECRET_MUST_NOT_LEAK", CODEX_ROUTER_QUIET: "1" },
    stdio: "ignore",
  });
  return child;
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

test("GLM Responses compatibility profile keeps native required/named tool choices", () => {
  const tool = { type: "function", name: "run", strict: true, parameters: { type: "object", properties: {} } };
  const glm = buildOpenAIResponsesRequest({
    model: { ...qwen, slug: "qwen-plan-responses/glm-5.2", upstreamModel: "glm-5.2" },
    credential: { value: "QWEN_TEST_KEY" },
    payload: { input, tools: [tool], tool_choice: { type: "function", name: "run" }, reasoning: { effort: "high" } },
  });
  assert.deepEqual(glm.json.tools, [tool]);
  assert.deepEqual(glm.json.tool_choice, { type: "function", name: "run" });
  assert.equal(glm.toolBuild.forcedRequirement, undefined);
  assert.equal("reasoning" in glm.json, false);
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
