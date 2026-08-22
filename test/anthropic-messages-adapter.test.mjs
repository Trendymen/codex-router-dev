import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { buildAnthropicMessagesRequest, adaptAnthropicMessages, AnthropicMessagesAdapterError } from "../src/anthropic-messages-adapter.mjs";
import { sealReasoningEnvelope, reasoningTextHash, reasoningItemId } from "../src/reasoning-envelope.mjs";

const KEY = "task5-internal-key-with-enough-entropy";
const MODEL = {
  slug: "qwen-plan/glm-5.2", provider: "qwen-plan", upstreamModel: "glm-5.2",
  baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
  effectiveTransport: "anthropic-messages", requestProfile: "qwen-plan",
};

function payload(overrides = {}) {
  return {
    instructions: "Be exact.",
    input: [
      { role: "user", content: [
        { type: "input_text", text: "你好" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ] },
      { role: "assistant", content: [{ type: "output_text", text: "previous" }] },
    ],
    tools: [{ type: "function", name: "lookup", description: "Look up", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    tool_choice: { type: "function", name: "lookup" },
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
    max_output_tokens: 9216,
    ...overrides,
  };
}

function frame(type, value) { return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; }

async function collect(transform, chunks) {
  const out = [];
  transform.on("data", (chunk) => out.push(Buffer.from(chunk)));
  await new Promise((resolve, reject) => { transform.on("end", resolve); transform.on("error", reject); for (const c of chunks) transform.write(c); transform.end(); });
  return Buffer.concat(out).toString("utf8");
}

function eventsFrom(output) {
  return output.split("\n\n")
    .filter(Boolean)
    .map((part) => part.split(/\r\n|\n|\r/).find((line) => line.startsWith("data:")))
    .filter((line) => line && line.slice(5).trim() !== "[DONE]")
    .map((line) => JSON.parse(line.slice(5).trim()));
}

async function summarize(transform, chunks) {
  const summary = { completed: 0, incomplete: 0, failed: 0, done: 0, bytes: 0 };
  transform.on("data", (chunk) => {
    const text = Buffer.from(chunk).toString("utf8");
    summary.bytes += Buffer.byteLength(text);
    summary.completed += (text.match(/event: response\.completed/g) || []).length;
    summary.incomplete += (text.match(/event: response\.incomplete/g) || []).length;
    summary.failed += (text.match(/event: response\.failed|data: \{"type":"response\.failed"/g) || []).length;
    summary.done += (text.match(/data: \[DONE\]/g) || []).length;
  });
  await new Promise((resolve, reject) => {
    transform.on("end", resolve);
    transform.on("error", reject);
    for (const chunk of chunks) transform.write(chunk);
    transform.end();
  });
  return summary;
}

function request(overrides = {}, requestContext = {}) {
  return buildAnthropicMessagesRequest({ model: MODEL, payload: payload(overrides), credential: "k", internalKey: KEY, requestContext });
}

function simpleCompletion(id = "msg_limits") {
  return [
    frame("message_start", { type: "message_start", message: { id, model: "glm-5.2" } }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
}

test("builds canonical GLM Messages request with full base path", () => {
  const built = buildAnthropicMessagesRequest({ model: MODEL, payload: payload(), credential: { value: "provider-secret" }, internalKey: KEY });
  assert.equal(built.url.href, `${MODEL.baseUrl}/messages`);
  assert.equal(built.json.model, "glm-5.2");
  assert.equal(built.json.system[0].text, "Be exact.");
  assert.deepEqual(built.json.messages[0].content[0], { type: "text", text: "你好" });
  assert.deepEqual(built.json.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  assert.deepEqual(built.json.messages[1].content, [{ type: "text", text: "previous" }]);
  assert.equal(built.json.max_tokens, 9216);
  assert.deepEqual(built.json.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.deepEqual(built.json.tool_choice, { type: "tool", name: "lookup", disable_parallel_tool_use: true });
  assert.equal(built.json.disable_parallel_tool_use, undefined);
  assert.deepEqual(built.json.tools[0].input_schema, payload().tools[0].parameters);
  assert.equal(built.headers["x-api-key"], "provider-secret");
  assert.equal(built.headers["anthropic-version"], "2023-06-01");
  assert.equal(built.json.stream, true);
  const beijing = buildAnthropicMessagesRequest({ model: { ...MODEL, baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/" }, payload: payload(), credential: "k", internalKey: KEY });
  assert.equal(beijing.url.href, "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/messages");
});

test("maps all reasoning budgets and exact output boundaries", () => {
  const budgets = new Map([["minimal", 1024], ["low", 2048], ["medium", 4096], ["high", 8192], ["xhigh", 16384], ["max", 32768]]);
  for (const [effort, budget] of budgets) {
    const built = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ reasoning: { effort }, max_output_tokens: budget + 1024 }), credential: "k", internalKey: KEY });
    assert.deepEqual(built.json.thinking, { type: "enabled", budget_tokens: budget });
    assert.equal(built.json.max_tokens, budget + 1024);
  }
  assert.equal(buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ reasoning: { effort: "off" }, max_output_tokens: 1 }), credential: "k", internalKey: KEY }).json.thinking, undefined);
  assert.equal(buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ reasoning: undefined, max_output_tokens: 131072 }), credential: "k", internalKey: KEY }).json.max_tokens, 131072);
  for (const value of [null, 0, -1, 1.5, 131073]) assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ max_output_tokens: value }), credential: "k", internalKey: KEY }), AnthropicMessagesAdapterError);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ reasoning: { effort: "high" }, max_output_tokens: 9215 }), credential: "k", internalKey: KEY }), /thinking_budget_exceeds_output_limit/);
  for (const choice of ["auto", "none", "required", { type: "function", name: "lookup" }]) {
    const result = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ tool_choice: choice, reasoning: { effort: "off" }, max_output_tokens: 131072 }), credential: "k", internalKey: KEY });
    if (choice === "none") assert.equal(result.json.tool_choice, undefined);
    else assert.ok(result.json.tool_choice);
  }
});

test("accepts a valid current thinking continuation, omits foreign, and rejects unknown provenance", () => {
  const summary = ["previous thought"];
  const envelope = sealReasoningEnvelope({ v: 1, provider: MODEL.provider, model: MODEL.upstreamModel, transport: "anthropic-messages", responseId: "msg_old", itemId: "rsn_old", textSha256: reasoningTextHash(summary), signature: "sig" }, KEY);
  const valid = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", id: "rsn_old", summary: [{ type: "summary_text", text: summary[0] }], encrypted_content: envelope }] }] }), credential: "k", internalKey: KEY, requestContext: { responseId: "msg_old" } });
  assert.deepEqual(valid.json.messages[0].content[0], { type: "thinking", thinking: summary[0], signature: "sig" });
  const foreign = sealReasoningEnvelope({ v: 1, provider: "other", model: MODEL.upstreamModel, transport: "anthropic-messages", responseId: "msg_old", itemId: "rsn_old", textSha256: reasoningTextHash(summary), signature: "sig" }, KEY);
  const omitted = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", id: "rsn_old", summary, encrypted_content: foreign }] }] }), credential: "k", internalKey: KEY, requestContext: { responseId: "msg_old" } });
  assert.deepEqual(omitted.json.messages[0].content, []);
  const missingSignature = sealReasoningEnvelope({ v: 1, provider: MODEL.provider, model: MODEL.upstreamModel, transport: "anthropic-messages", responseId: "msg_old", itemId: "rsn_old", textSha256: reasoningTextHash(summary), signature: null }, KEY);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", id: "rsn_old", summary, encrypted_content: missingSignature }] }] }), credential: "k", internalKey: KEY, requestContext: { responseId: "msg_old" } }), /thinking_signature_missing/);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", summary }] }] }), credential: "k", internalKey: KEY }), /thinking_provenance_unknown/);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", summary, encrypted_content: "cr.reasoning.v2.bad.bad" }] }] }), credential: "k", internalKey: KEY }), /thinking_signature_invalid/);
});

test("lowers function, custom, and namespace history through the shared tool dialect", () => {
  const tools = [
    { type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, strict: true },
    { type: "custom", name: "freeform", description: "free" },
    { type: "namespace", name: "files", tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }] },
  ];
  const sourceInput = [
    { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
    { type: "custom_tool_call", id: "item_2", call_id: "call_2", name: "freeform", input: "raw text" },
    { type: "function_call", id: "item_3", call_id: "call_3", name: "read", namespace: "files", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "result" },
    { type: "custom_tool_call_output", call_id: "call_2", output: "custom result" },
  ];
  const built = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ tools, tool_choice: "required", input: sourceInput, reasoning: { effort: "off" }, max_output_tokens: 131072 }), credential: "k", internalKey: KEY });
  assert.equal(built.json.tool_choice.type, "any");
  assert.equal(built.json.tools.length, 3);
  assert.ok(built.json.tools.every((tool) => tool.name !== "freeform" || tool.input_schema.properties.input));
  assert.deepEqual(built.json.messages[0].content[0].input, { q: "x" });
  assert.deepEqual(built.json.messages[1].content[0].input, { input: "raw text" });
  assert.equal(built.json.messages[2].content[0].name, "cr_files__read_LEZ5OZ2EUHBABJAL");
  assert.equal(built.json.messages[3].content[0].type, "tool_result");
  const none = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ tools, tool_choice: "none", parallel_tool_calls: false, reasoning: { effort: "off" }, max_output_tokens: 131072 }), credential: "k", internalKey: KEY });
  assert.equal(none.json.tools, undefined);
  assert.equal(none.json.tool_choice, undefined);
  assert.equal(none.json.disable_parallel_tool_use, undefined);
});

test("converts text, thinking signature, tool input, usage and one terminal event", async () => {
  const upstream = {
    status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
    body: Readable.toWeb(Readable.from([
      frame("message_start", { type: "message_start", message: { id: "msg_1", model: "glm-5.2", usage: { input_tokens: 10, cache_read_input_tokens: 3 } } }),
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } }),
      frame("content_block_stop", { type: "content_block_stop", index: 1 }),
      frame("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} } }),
      frame("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } }),
      frame("content_block_stop", { type: "content_block_stop", index: 2 }),
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8, cache_creation_input_tokens: 2 } }),
      frame("message_stop", { type: "message_stop" }),
    ].map((value) => Buffer.from(value)))),
  };
  const adapted = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } });
  const output = await collect(adapted.transforms[0], [Buffer.from(await new Response(upstream.body).text())]);
  const events = output.split("\n\n").filter(Boolean).map((frame) => frame.split("\n").find((line) => line.startsWith("data:"))).filter((line) => line && line.slice(5).trim() !== "[DONE]").map((line) => JSON.parse(line.slice(5).trim()));
  assert.equal(events.filter((e) => ["response.completed", "response.incomplete", "response.failed"].includes(e.type)).length, 1);
  assert.ok(events.some((e) => e.type === "response.output_text.delta" && e.delta === "answer"));
  const terminal = events.find((e) => e.type === "response.completed");
  assert.equal(terminal.response.status, "completed");
  assert.deepEqual(terminal.response.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens: 8,
    cache_creation_input_tokens: 2,
  });
  assert.equal(output.endsWith("data: [DONE]\n\n"), true);
});

test("frames arbitrary UTF-8 chunks and closes max-token, duplicate, and malformed lifecycles safely", async () => {
  const source = [
    frame("message_start", { type: "message_start", message: { id: "msg_chunks", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中文" } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" } }),
    frame("message_stop", { type: "message_stop" }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
  const chunks = [...Buffer.from(source)].map((byte) => Buffer.from([byte]));
  const output = await collect(transform, chunks);
  assert.equal((output.match(/data: \{"type":"response\.incomplete"/g) || []).length, 1);
  assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1);
  assert.match(output, /max_output_tokens/);
  const badType = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
  const failed = await collect(badType, [Buffer.from(frame("message_start", { message: { id: "m" } }) + frame("content_block_start", { index: 0, content_block: { type: "text" } }) + frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "wrong" } }))]);
  assert.equal((failed.match(/data: \{"type":"response\.failed"/g) || []).length, 1);
  assert.equal((failed.match(/data: \[DONE\]/g) || []).length, 1);
});

test("restores mapped provider tool calls only after the shared lifecycle mapping validates them", async () => {
  const built = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ reasoning: { effort: "off" }, max_output_tokens: 131072 }), credential: "k", internalKey: KEY });
  const encoded = built.json.tools[0].name;
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY, toolBuild: built.toolBuild } }).transforms[0];
  const output = await collect(transform, [Buffer.from([
    frame("message_start", { type: "message_start", message: { id: "msg_tool", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_tool", name: encoded, input: {} } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
    frame("message_stop", { type: "message_stop" }),
  ].join(""))]);
  assert.match(output, /"type":"function_call"/);
  assert.match(output, /"name":"lookup"/);
  assert.match(output, /"id":"fc_[A-Za-z0-9_-]{24}","call_id":"call_tool"/);
});

test("caller abort invokes the upstream abort owner once and closes the transform", async () => {
  const controller = new AbortController();
  let aborts = 0;
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY, signal: controller.signal, abort: () => { aborts += 1; } } }).transforms[0];
  const pending = new Promise((resolve) => { transform.once("error", (error) => resolve(error)); });
  transform.write(Buffer.from(frame("message_start", { type: "message_start", message: { id: "msg_abort", model: "glm-5.2" } })));
  controller.abort();
  const error = await pending;
  assert.equal(error.code, "request_aborted");
  assert.equal(aborts, 1);
});

test("rejects malformed/unknown/duplicate/truncated streams and passes non-2xx untouched", async () => {
  const bad = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: Readable.toWeb(Readable.from("data: {bad}\n\n")) };
  const adapted = adaptAnthropicMessages({ model: MODEL, upstream: bad, requestContext: { internalKey: KEY } });
  const malformedOutput = await collect(adapted.transforms[0], [Buffer.from("data: {bad}\n\n")]);
  assert.match(malformedOutput, /response\.failed/);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "user", content: [{ type: "unsupported" }] }] }), credential: "k", internalKey: KEY }), /unsupported/);
  const non2xx = { status: 429, headers: new Headers({ "content-type": "application/json" }), body: Readable.toWeb(Readable.from('{"error":"provider"}')) };
  assert.deepEqual(adaptAnthropicMessages({ model: MODEL, upstream: non2xx }).transforms, []);
});

test("refuses to seal thinking when the internal key is absent", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream }).transforms[0];
  const output = await collect(transform, [Buffer.from([
    frame("message_start", { type: "message_start", message: { id: "msg_no_key", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private" } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    frame("message_stop", { type: "message_stop" }),
  ].join(""))]);
  assert.match(output, /thinking_signature_missing|response\.failed/);
  assert.doesNotMatch(output, /response\.completed/);
});

test("assigns contiguous internal output indexes and aggregates thinking into one summary part", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
  const output = await collect(transform, [Buffer.from([
    frame("message_start", { type: "message_start", message: { id: "msg_indexes", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 10, content_block: { type: "thinking" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 10, delta: { type: "thinking_delta", thinking: "a" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 10, delta: { type: "thinking_delta", thinking: "b" } }),
    frame("content_block_stop", { type: "content_block_stop", index: 10 }),
    frame("content_block_start", { type: "content_block_start", index: 20, content_block: { type: "text" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 20, delta: { type: "text_delta", text: "answer" } }),
    frame("content_block_stop", { type: "content_block_stop", index: 20 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    frame("message_stop", { type: "message_stop" }),
  ].join(""))]);
  const events = output.split("\n\n").filter(Boolean).map((part) => part.split("\n").find((line) => line.startsWith("data:"))).filter(Boolean).filter((line) => !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(5).trim()));
  const added = events.filter((event) => event.type === "response.output_item.added");
  assert.deepEqual(added.map((event) => event.output_index), [0, 1]);
  const done = events.find((event) => event.type === "response.output_item.done" && event.item.type === "reasoning");
  assert.deepEqual(done.item.summary, [{ type: "summary_text", text: "ab" }]);
  assert.deepEqual(done.item.content, []);
  assert.match(done.item.id, /^rsn_[A-Za-z0-9_-]{24}$/);
});

test("binds continuation identity to trusted provenance instead of caller response fields", () => {
  const summary = ["previous thought"];
  const responseId = "trusted_response";
  const itemId = reasoningItemId(responseId, 3);
  const envelope = sealReasoningEnvelope({ v: 1, provider: MODEL.provider, model: MODEL.upstreamModel, transport: "anthropic-messages", responseId, itemId, textSha256: reasoningTextHash(summary), signature: "sig" }, KEY);
  const base = { role: "assistant", content: [{ type: "reasoning", id: itemId, summary, encrypted_content: envelope }] };
  assert.doesNotThrow(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ response_id: "caller_forged", input: [base] }), credential: "k", internalKey: KEY, requestContext: { provenance: { [itemId]: { responseId, outputIndex: 3 } } } }));
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ ...base, content: [{ ...base.content[0], id: reasoningItemId(responseId, 4) }] }] }), credential: "k", internalKey: KEY, requestContext: { provenance: { [reasoningItemId(responseId, 4)]: { responseId, outputIndex: 4 } } } }), /thinking_signature_invalid/);
});

test("GLM Messages preserves strict schemas and nests parallel choice control", () => {
  const tools = [{ type: "function", name: "strict_lookup", strict: true, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false } }];
  for (const toolChoice of ["auto", "required", { type: "function", name: "strict_lookup" }]) {
    const built = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ tools, tool_choice: toolChoice, parallel_tool_calls: false, reasoning: { effort: "off" }, max_output_tokens: 131072 }), credential: "k", internalKey: KEY });
    assert.equal(built.json.tools[0].strict, true);
    assert.equal(built.json.tool_choice.disable_parallel_tool_use, true);
    assert.equal(built.json.disable_parallel_tool_use, undefined);
  }
  const enabled = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ tools, tool_choice: undefined, parallel_tool_calls: true, reasoning: { effort: "off" }, max_output_tokens: 131072 }), credential: "k", internalKey: KEY });
  assert.deepEqual(enabled.json.tool_choice, { type: "auto" });
  const none = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ tools, tool_choice: "none", parallel_tool_calls: false, reasoning: { effort: "off" }, max_output_tokens: 131072 }), credential: "k", internalKey: KEY });
  assert.equal(none.json.tools, undefined);
  assert.equal(none.json.tool_choice, undefined);
});

test("closes every active block before one canonical failure terminal", async () => {
  const seen = [];
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY, responseId: "trusted-failure", observeReasoningProtocol: (event) => seen.push(event) } }).transforms[0];
  const output = await collect(transform, [Buffer.from([
    frame("message_start", { type: "message_start", message: { id: "msg_failure", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "wrong" } }),
  ].join(""))]);
  const events = output.split("\n\n").filter(Boolean).map((part) => part.split("\n").find((line) => line.startsWith("data:"))).filter((line) => line && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(5).trim()));
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.created_at, 0);
  assert.equal(events.at(-1).response.model, MODEL.slug);
  assert.ok(events.some((event) => event.type === "response.output_text.done"));
  assert.ok(events.some((event) => event.type === "response.content_part.done"));
  assert.ok(events.some((event) => event.type === "response.output_item.done"));
  assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1);
  assert.equal(seen.length, 0);
});

test("paused consumers resume a bounded ordered queue without losing terminal output", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
  const frames = [frame("message_start", { type: "message_start", message: { id: "msg_pause", model: "glm-5.2" } }), frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } })];
  for (let index = 0; index < 2000; index += 1) frames.push(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }));
  frames.push(frame("content_block_stop", { type: "content_block_stop", index: 0 }), frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }), frame("message_stop", { type: "message_stop" }));
  const source = frames.join("");
  transform.pause();
  const output = [];
  const finished = new Promise((resolve, reject) => { transform.on("data", (chunk) => output.push(Buffer.from(chunk))); transform.on("end", resolve); transform.on("error", reject); });
  transform.end(Buffer.from(source));
  transform.resume();
  await finished;
  const body = Buffer.concat(output).toString("utf8");
  assert.equal((body.match(/event: response\.output_text\.delta/g) || []).length, 2000);
  assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1);
  assert.ok(body.indexOf("response.completed") < body.lastIndexOf("data: [DONE]"));
});

test("rejects new blocks after a stop reason and closes max-token items as incomplete", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
  const output = await collect(transform, [Buffer.from([
    frame("message_start", { type: "message_start", message: { id: "msg_stage", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" } }),
    frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text" } }),
  ].join(""))]);
  const events = output.split("\n\n").filter(Boolean).map((part) => part.split("\n").find((line) => line.startsWith("data:"))).filter((line) => line && !line.includes("[DONE]")).map((line) => JSON.parse(line.slice(5).trim()));
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.output[0].status, "incomplete");
  assert.ok(events.some((event) => event.type === "response.output_text.done"));
  assert.deepEqual(events.at(-1).response.incomplete_details, null);
});

test("reasoning and output-limit matrix uses every exact budget, default, cap, and invalid branch", () => {
  const cases = [
    [undefined, undefined, { type: "enabled", budget_tokens: 32768 }, 131072],
    [{}, undefined, { type: "enabled", budget_tokens: 32768 }, 131072],
    [{ effort: "off" }, 1, undefined, 1],
    [{ effort: "none" }, 131072, undefined, 131072],
    [{ effort: "minimal" }, 2048, { type: "enabled", budget_tokens: 1024 }, 2048],
    [{ effort: "low" }, 3072, { type: "enabled", budget_tokens: 2048 }, 3072],
    [{ effort: "medium" }, 5120, { type: "enabled", budget_tokens: 4096 }, 5120],
    [{ effort: "high" }, 9216, { type: "enabled", budget_tokens: 8192 }, 9216],
    [{ effort: "xhigh" }, 17408, { type: "enabled", budget_tokens: 16384 }, 17408],
    [{ effort: "max" }, 33792, { type: "enabled", budget_tokens: 32768 }, 33792],
    [{ effort: "max" }, 131072, { type: "enabled", budget_tokens: 32768 }, 131072],
  ];
  for (const [reasoning, limit, thinking, maxTokens] of cases) {
    const overrides = { reasoning, max_output_tokens: limit };
    const built = request(overrides);
    assert.deepEqual(built.json.thinking, thinking);
    assert.equal(built.json.max_tokens, maxTokens);
  }
  const cross = [
    [undefined, 33792],
    [{}, 33792],
    [{ effort: "off" }, 1],
    [{ effort: "none" }, 1],
    [{ effort: "minimal" }, 2048],
    [{ effort: "low" }, 3072],
    [{ effort: "medium" }, 5120],
    [{ effort: "high" }, 9216],
    [{ effort: "xhigh" }, 17408],
    [{ effort: "max" }, 33792],
  ];
  for (const [reasoning, explicit] of cross) {
    assert.equal(request({ reasoning, max_output_tokens: undefined }).json.max_tokens, 131072);
    assert.equal(request({ reasoning, max_output_tokens: 131072 }).json.max_tokens, 131072);
    assert.equal(request({ reasoning, max_output_tokens: explicit }).json.max_tokens, explicit);
  }
  const failures = [
    [null, undefined, "invalid_reasoning_config"],
    ["high", undefined, "invalid_reasoning_config"],
    [[], undefined, "invalid_reasoning_config"],
    [{ effort: "ultra" }, undefined, "unsupported_reasoning_effort"],
    [{ effort: "minimal" }, null, "invalid_output_limit"],
    [{ effort: "minimal" }, 1.5, "invalid_output_limit"],
    [{ effort: "minimal" }, 0, "invalid_output_limit"],
    [{ effort: "minimal" }, -1, "invalid_output_limit"],
    [{ effort: "minimal" }, 2047, "thinking_budget_exceeds_output_limit"],
    [{ effort: "off" }, 131073, "output_limit_exceeds_provider_cap"],
  ];
  for (const [reasoning, limit, code] of failures) {
    assert.throws(() => request({ reasoning, max_output_tokens: limit }), (error) => error.code === code);
  }
  for (const reasoning of [null, "high", [], { effort: "ultra" }]) {
    const code = reasoning && typeof reasoning === "object" && !Array.isArray(reasoning) ? "unsupported_reasoning_effort" : "invalid_reasoning_config";
    for (const limit of [undefined, 131072, 33792]) assert.throws(() => request({ reasoning, max_output_tokens: limit }), (error) => error.code === code);
  }
});

test("parallel settings and every tool choice have exact Anthropic shapes", () => {
  const tools = payload().tools;
  const cases = [
    [undefined, undefined, { type: "auto" }],
    [undefined, true, { type: "auto" }],
    [undefined, false, { type: "auto", disable_parallel_tool_use: true }],
    ["auto", false, { type: "auto", disable_parallel_tool_use: true }],
    ["required", false, { type: "any", disable_parallel_tool_use: true }],
    [{ type: "function", name: "lookup" }, false, { type: "tool", name: "lookup", disable_parallel_tool_use: true }],
  ];
  for (const [toolChoice, parallel, expected] of cases) {
    const built = request({ tools, tool_choice: toolChoice, parallel_tool_calls: parallel, reasoning: { effort: "off" }, max_output_tokens: 131072 });
    assert.deepEqual(built.json.tool_choice, expected);
  }
  const none = request({ tools, tool_choice: "none", parallel_tool_calls: false, reasoning: { effort: "off" }, max_output_tokens: 131072 });
  assert.equal(none.json.tools, undefined);
  assert.equal(none.json.tool_choice, undefined);

  const mixedTools = [
    ...tools,
    { type: "custom", name: "freeform" },
    { type: "namespace", name: "files", tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }] },
  ];
  for (const choice of [{ type: "custom", name: "freeform" }, { type: "function", namespace: "files", name: "read" }]) {
    const built = request({ tools: mixedTools, tool_choice: choice, parallel_tool_calls: false, reasoning: { effort: "off" }, max_output_tokens: 131072 });
    assert.equal(built.json.tool_choice.type, "tool");
    assert.equal(built.json.tool_choice.disable_parallel_tool_use, true);
    assert.ok(built.json.tools.some((tool) => tool.name === built.json.tool_choice.name));
  }
});

test("continuation provenance crosses every bound field and distinguishes foreign from invalid and unknown", () => {
  const summary = ["bound thought"];
  const responseId = "msg_bound";
  const itemId = reasoningItemId(responseId, 2);
  const basePayload = { v: 1, provider: MODEL.provider, model: MODEL.upstreamModel, transport: "anthropic-messages", responseId, itemId, textSha256: reasoningTextHash(summary), signature: "sig" };
  const build = (encrypted_content, block = {}, provenance = { [itemId]: { responseId, outputIndex: 2 } }, model = MODEL) => buildAnthropicMessagesRequest({
    model,
    payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", id: itemId, summary, encrypted_content, ...block }] }] }),
    credential: "k", internalKey: KEY, requestContext: { provenance },
  });
  assert.deepEqual(build(sealReasoningEnvelope(basePayload, KEY)).json.messages[0].content, [{ type: "thinking", thinking: summary[0], signature: "sig" }]);
  for (const mutation of [
    { provider: "other" }, { model: "glm-foreign" }, { transport: "openai-responses" },
  ]) {
    assert.deepEqual(build(sealReasoningEnvelope({ ...basePayload, ...mutation }, KEY)).json.messages[0].content, []);
  }
  for (const mutation of [
    { responseId: "msg_other" }, { itemId: "rsn_other" }, { textSha256: reasoningTextHash(["other"]) },
  ]) {
    assert.throws(() => build(sealReasoningEnvelope({ ...basePayload, ...mutation }, KEY)), (error) => error.code === "thinking_signature_invalid");
  }
  assert.throws(() => build("cr.reasoning.v2.invalid.invalid"), (error) => error.code === "thinking_signature_invalid");
  assert.throws(() => build(undefined), (error) => error.code === "thinking_provenance_unknown");
  assert.throws(() => build("untagged"), (error) => error.code === "thinking_signature_invalid" || error.code === "thinking_provenance_unknown");
  assert.throws(() => build(sealReasoningEnvelope({ ...basePayload, signature: null }, KEY)), (error) => error.code === "thinking_signature_missing");
});

test("failed and incomplete terminals deep-equal Appendix I with no private provider fields", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const malformed = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY, responseId: "resp_safe" } }).transforms[0];
  const failedOutput = await collect(malformed, [Buffer.from("data: {provider_secret}\n\n")]);
  const failed = eventsFrom(failedOutput).at(-1);
  assert.deepEqual(failed, {
    type: "response.failed",
    sequence_number: 1,
    response: {
      id: "resp_safe",
      object: "response",
      created_at: 0,
      model: MODEL.slug,
      output: [],
      usage: null,
      status: "failed",
      error: { code: "reasoning_protocol_error", message: "Invalid upstream reasoning sequence." },
      incomplete_details: null,
    },
  });
  assert.doesNotMatch(JSON.stringify(failed), /provider_secret|provider_response_malformed|"details":|"param":/);
  assert.equal((failedOutput.match(/data: \[DONE\]/g) || []).length, 1);

  const incompleteTransform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
  const incompleteOutput = await collect(incompleteTransform, [Buffer.from([
    frame("message_start", { type: "message_start", message: { id: "msg_incomplete", model: "private-provider-model", created_at: 7, usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 } } }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" } }),
    frame("message_stop", { type: "message_stop" }),
  ].join(""))]);
  assert.deepEqual(eventsFrom(incompleteOutput).at(-1), {
    type: "response.incomplete",
    sequence_number: 2,
    response: {
      id: "msg_incomplete",
      object: "response",
      created_at: 7,
      model: MODEL.slug,
      output: [],
      usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
      status: "incomplete",
      error: null,
      incomplete_details: { reason: "max_output_tokens" },
    },
  });
  assert.doesNotMatch(incompleteOutput, /private-provider-model/);
});

test("a paused consumer accepts sixty thousand small frames totaling twelve MiB in order", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
  const count = 60_000;
  const targetBytes = 12 * 1024 * 1024;
  const frames = [
    frame("message_start", { type: "message_start", message: { id: "msg_many_frames", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    ...Array.from({ length: count }, () => frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } })),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    frame("message_stop", { type: "message_stop" }),
  ];
  let source = Buffer.from(frames.join(""));
  const remainder = targetBytes - source.length;
  if (remainder > 0) source = Buffer.concat([Buffer.from(`:${"x".repeat(remainder - 3)}\n\n`), source]);
  assert.equal(source.length, targetBytes);
  transform.pause();
  const done = summarize(transform, [source]);
  transform.resume();
  const result = await done;
  assert.deepEqual({ ...result, bytes: 0 }, { completed: 1, incomplete: 0, failed: 0, done: 1, bytes: 0 });
  assert.ok(result.bytes > 0);
});

test("frame, body, work, and tool-argument limits accept the exact boundary and reject the first extra byte or event", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const run = (source) => summarize(adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0], [Buffer.isBuffer(source) ? source : Buffer.from(source)]);
  const runPaused = async (source) => {
    const transform = adaptAnthropicMessages({ model: MODEL, upstream, requestContext: { internalKey: KEY } }).transforms[0];
    transform.pause();
    const result = summarize(transform, [Buffer.isBuffer(source) ? source : Buffer.from(source)]);
    transform.resume();
    return result;
  };

  const exactFrame = Buffer.from(`:${"x".repeat(8 * 1024 * 1024 - 1)}\n\n${simpleCompletion("msg_frame_exact")}`);
  assert.deepEqual({ ...(await run(exactFrame)), bytes: 0 }, { completed: 1, incomplete: 0, failed: 0, done: 1, bytes: 0 });
  const extraFrame = Buffer.from(`:${"x".repeat(8 * 1024 * 1024)}\n\n${simpleCompletion("msg_frame_extra")}`);
  assert.deepEqual({ ...(await run(extraFrame)), bytes: 0 }, { completed: 0, incomplete: 0, failed: 1, done: 1, bytes: 0 });

  const bodyTail = Buffer.from(simpleCompletion("msg_body_exact"));
  const comment = (size) => Buffer.from(`:${"x".repeat(size - 3)}\n\n`);
  const first = comment(6 * 1024 * 1024);
  const second = comment(6 * 1024 * 1024);
  const third = comment(16 * 1024 * 1024 - first.length - second.length - bodyTail.length);
  const exactBody = Buffer.concat([first, second, third, bodyTail]);
  assert.equal(exactBody.length, 16 * 1024 * 1024);
  assert.deepEqual({ ...(await run(exactBody)), bytes: 0 }, { completed: 1, incomplete: 0, failed: 0, done: 1, bytes: 0 });
  assert.deepEqual({ ...(await run(Buffer.concat([Buffer.from("x"), exactBody]))), bytes: 0 }, { completed: 0, incomplete: 0, failed: 1, done: 1, bytes: 0 });

  const workSource = (deltaCount, id) => [
    frame("message_start", { type: "message_start", message: { id, model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    ...Array.from({ length: deltaCount }, () => frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }),
    frame("message_stop", { type: "message_stop" }),
  ].join("");
  assert.deepEqual({ ...(await run(workSource(65_531, "msg_work_exact"))), bytes: 0 }, { completed: 1, incomplete: 0, failed: 0, done: 1, bytes: 0 });
  assert.deepEqual({ ...(await run(workSource(65_532, "msg_work_extra"))), bytes: 0 }, { completed: 0, incomplete: 0, failed: 1, done: 1, bytes: 0 });

  const argumentsOfSize = (size) => `{"value":"${"a".repeat(size - 12)}"}`;
  const argsSource = (size, id) => {
    const args = argumentsOfSize(size);
    const pieces = [];
    for (let offset = 0; offset < args.length; offset += 512 * 1024) pieces.push(args.slice(offset, offset + 512 * 1024));
    return [
      frame("message_start", { type: "message_start", message: { id, model: "glm-5.2" } }),
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_limit", name: "lookup", input: {} } }),
      ...pieces.map((partial_json) => frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
      frame("message_stop", { type: "message_stop" }),
    ].join("");
  };
  assert.deepEqual({ ...(await runPaused(argsSource(8 * 1024 * 1024, "msg_args_exact"))), bytes: 0 }, { completed: 1, incomplete: 0, failed: 0, done: 1, bytes: 0 });
  assert.deepEqual({ ...(await run(argsSource(8 * 1024 * 1024 + 1, "msg_args_extra"))), bytes: 0 }, { completed: 0, incomplete: 0, failed: 1, done: 1, bytes: 0 });
});

test("EOF, unknown blocks, malformed tool JSON, non-2xx headers, and post-terminal input preserve public boundaries", async () => {
  const upstream = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }) };
  const run = (source, context = { internalKey: KEY }) => collect(adaptAnthropicMessages({ model: MODEL, upstream, requestContext: context }).transforms[0], [Buffer.from(source)]);
  const truncated = eventsFrom(await run(frame("message_start", { type: "message_start", message: { id: "msg_eof", model: "glm-5.2" } }))).at(-1);
  assert.deepEqual(truncated.response.error, { code: "upstream_stream_truncated", message: "Upstream stream ended early." });
  assert.throws(() => request({ input: [{ role: "user", content: [{ type: "unknown" }] }] }), (error) => error.code === "unsupported_anthropic_block");
  const unknown = eventsFrom(await run(frame("message_start", { type: "message_start", message: { id: "msg_unknown", model: "glm-5.2" } }) + frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "unknown", private: "provider-secret" } }))).at(-1);
  assert.deepEqual(unknown.response.error, { code: "unsupported_anthropic_block", message: "Unsupported Messages response block." });
  assert.doesNotMatch(JSON.stringify(unknown), /provider-secret/);
  const badArgs = eventsFrom(await run([
    frame("message_start", { type: "message_start", message: { id: "msg_bad_args", model: "glm-5.2" } }),
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_bad", name: "lookup", input: {} } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{private-provider-json" } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  ].join(""))).at(-1);
  assert.deepEqual(badArgs.response.error, { code: "tool_mapping_error", message: "Invalid tool mapping." });
  assert.doesNotMatch(JSON.stringify(badArgs), /private-provider-json|invalid_tool_arguments/);

  for (const status of [400, 429, 500, 503]) {
    const non2xx = { status, headers: new Headers({ "x-request-id": `req-${status}`, "retry-after": "5", "x-secret": "hidden" }), body: { marker: status } };
    const adapted = adaptAnthropicMessages({ model: MODEL, upstream: non2xx });
    assert.equal(adapted.upstream, non2xx);
    assert.deepEqual(adapted.transforms, []);
    assert.equal(adapted.upstream.headers.get("x-request-id"), `req-${status}`);
  }

  const observed = [];
  const terminalSource = simpleCompletion("msg_post_terminal") + frame("error", { type: "error", error: { type: "private-provider-error", message: "secret" } });
  const terminalOutput = await run(terminalSource, { internalKey: KEY, observeReasoningProtocol: (value) => observed.push(value) });
  assert.equal(eventsFrom(terminalOutput).filter((event) => event.type === "response.completed").length, 1);
  assert.equal(eventsFrom(terminalOutput).filter((event) => event.type === "response.failed").length, 0);
  assert.deepEqual(observed, [{ code: "event_after_terminal" }]);
  assert.doesNotMatch(terminalOutput, /private-provider-error|secret/);
});
