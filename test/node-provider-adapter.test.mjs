import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  adaptOpenAIResponses,
  buildOpenAIResponsesRequest,
  restoreOpenAIResponsesEvent,
} from "../src/openai-responses-adapter.mjs";
import { providerEndpoint } from "../src/provider-endpoint.mjs";

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
