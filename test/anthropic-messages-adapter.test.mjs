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
  assert.equal(terminal.response.usage.input_tokens, 10);
  assert.deepEqual(terminal.response.usage.input_tokens_details, { cached_tokens: 3 });
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
  assert.deepEqual(events.at(-1).response.incomplete_details, undefined);
});
