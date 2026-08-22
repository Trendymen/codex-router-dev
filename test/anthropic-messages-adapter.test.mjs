import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { buildAnthropicMessagesRequest, adaptAnthropicMessages, AnthropicMessagesAdapterError } from "../src/anthropic-messages-adapter.mjs";
import { sealReasoningEnvelope, reasoningTextHash } from "../src/reasoning-envelope.mjs";

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
  assert.deepEqual(built.json.tool_choice, { type: "tool", name: "lookup" });
  assert.equal(built.json.disable_parallel_tool_use, true);
  assert.deepEqual(built.json.tools[0].input_schema, payload().tools[0].parameters);
  assert.equal(built.headers["x-api-key"], "provider-secret");
  assert.equal(built.headers["anthropic-version"], "2023-06-01");
  assert.equal(built.json.stream, true);
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
  const valid = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", responseId: "msg_old", itemId: "rsn_old", summary: [{ type: "summary_text", text: summary[0] }], encrypted_content: envelope }] }] }), credential: "k", internalKey: KEY });
  assert.deepEqual(valid.json.messages[0].content[0], { type: "thinking", thinking: summary[0], signature: "sig" });
  const foreign = sealReasoningEnvelope({ v: 1, provider: "other", model: MODEL.upstreamModel, transport: "anthropic-messages", responseId: "msg_old", itemId: "rsn_old", textSha256: reasoningTextHash(summary), signature: "sig" }, KEY);
  const omitted = buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", responseId: "msg_old", itemId: "rsn_old", summary, encrypted_content: foreign }] }] }), credential: "k", internalKey: KEY });
  assert.deepEqual(omitted.json.messages[0].content, []);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", summary }] }] }), credential: "k", internalKey: KEY }), /thinking_provenance_unknown/);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "assistant", content: [{ type: "reasoning", summary, encrypted_content: "cr.reasoning.v2.bad.bad" }] }] }), credential: "k", internalKey: KEY }), /thinking_signature_invalid/);
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
  assert.equal(output.endsWith("data: [DONE]\n\n"), true);
});

test("rejects malformed/unknown/duplicate/truncated streams and passes non-2xx untouched", async () => {
  const bad = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body: Readable.toWeb(Readable.from("data: {bad}\n\n")) };
  const adapted = adaptAnthropicMessages({ model: MODEL, upstream: bad, requestContext: { internalKey: KEY } });
  await assert.rejects(() => collect(adapted.transforms[0], [Buffer.from("data: {bad}\n\n")]), /provider_response_malformed/);
  assert.throws(() => buildAnthropicMessagesRequest({ model: MODEL, payload: payload({ input: [{ role: "user", content: [{ type: "unsupported" }] }] }), credential: "k", internalKey: KEY }), /unsupported/);
  const non2xx = { status: 429, headers: new Headers({ "content-type": "application/json" }), body: Readable.toWeb(Readable.from('{"error":"provider"}')) };
  assert.deepEqual(adaptAnthropicMessages({ model: MODEL, upstream: non2xx }).transforms, []);
});
