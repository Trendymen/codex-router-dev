import { Transform } from "node:stream";
import { providerEndpoint } from "./provider-endpoint.mjs";
import { sealReasoningEnvelope, verifyReasoningEnvelope, reasoningTextHash } from "./reasoning-envelope.mjs";

const DEFAULT_MAX = 131072;
const BUDGETS = Object.freeze({ minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 });

export class AnthropicMessagesAdapterError extends Error {
  constructor(code) { super(code); this.name = "AnthropicMessagesAdapterError"; this.code = code; }
}
function fail(code) { throw new AnthropicMessagesAdapterError(code); }
function object(value, code = "provider_request_malformed") { if (!value || typeof value !== "object" || Array.isArray(value)) fail(code); return value; }

function imageBlock(value) {
  const source = value?.image_url ?? value?.source;
  if (typeof source !== "string" || !source.startsWith("data:")) fail("unsupported_anthropic_image");
  const match = /^data:([^;,]+);base64,(.*)$/.exec(source);
  if (!match) fail("unsupported_anthropic_image");
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
}

function thinkingFromHistory(block, model, internalKey, expected) {
  if (!block?.encrypted_content) fail("thinking_provenance_unknown");
  const parts = Array.isArray(block.summary) ? block.summary.map((part) => typeof part === "string" ? part : part?.text).filter((part) => typeof part === "string") : typeof block.text === "string" ? [block.text] : [];
  const verdict = verifyReasoningEnvelope(block.encrypted_content, { ...expected, summaryParts: parts }, internalKey);
  if (verdict.status === "foreign") return undefined;
  if (verdict.status !== "valid") fail(verdict.code || "thinking_provenance_unknown");
  if (!parts.length || !verdict.payload.signature) fail("thinking_signature_missing");
  return { type: "thinking", thinking: parts.join(""), signature: verdict.payload.signature };
}

function inputContent(content, model, internalKey) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("provider_request_malformed");
  const result = [];
  for (const block of content) {
    if (!block || typeof block !== "object") fail("provider_request_malformed");
    if (block.type === "input_text" || block.type === "output_text" || block.type === "text") result.push({ type: "text", text: String(block.text ?? "") });
    else if (block.type === "input_image") result.push(imageBlock(block));
    else if (block.type === "reasoning") {
      const thinking = thinkingFromHistory(block, model, internalKey, { provider: model.provider, model: model.upstreamModel, transport: "anthropic-messages", responseId: block.responseId, itemId: block.itemId, summaryParts: block.summary });
      if (thinking) result.push(thinking);
    } else if (block.type === "function_call") result.push({ type: "tool_use", id: block.call_id ?? block.id, name: block.name, input: parseObject(block.arguments) });
    else if (block.type === "function_call_output") result.push({ type: "tool_result", tool_use_id: block.call_id ?? block.id, content: typeof block.output === "string" ? block.output : JSON.stringify(block.output) });
    else fail("unsupported_anthropic_block");
  }
  return result;
}
function parseObject(value) { if (value && typeof value === "object" && !Array.isArray(value)) return value; if (typeof value !== "string") fail("provider_request_malformed"); try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_tool_arguments"); return parsed; } catch { fail("invalid_tool_arguments"); } }

function messagesFromInput(input, model, internalKey) {
  if (typeof input === "string") return [{ role: "user", content: [{ type: "text", text: input }] }];
  if (!Array.isArray(input)) fail("provider_request_malformed");
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || !["user", "assistant", "tool"].includes(item.role)) fail("provider_request_malformed");
    const role = item.role === "tool" ? "user" : item.role;
    out.push({ role, content: inputContent(item.content ?? item.output ?? "", model, internalKey) });
  }
  return out;
}

function reasoningConfig(value) {
  if (value === undefined) return { budget: BUDGETS.max, enabled: true };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_reasoning_config");
  const effort = value.effort;
  if (effort === "off" || effort === "none") return { enabled: false };
  if (effort === undefined) return { budget: BUDGETS.max, enabled: true };
  if (!(effort in BUDGETS)) fail("unsupported_reasoning_effort");
  return { budget: BUDGETS[effort], enabled: true };
}

function outputLimit(value, budget, enabled) {
  const max = value === undefined ? DEFAULT_MAX : value;
  if (!Number.isSafeInteger(max) || max <= 0) fail("invalid_output_limit");
  if (max > DEFAULT_MAX) fail("output_limit_exceeds_provider_cap");
  if (enabled && max < budget + 1024) fail("thinking_budget_exceeds_output_limit");
  return max;
}

function toolDeclarations(tools) {
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools)) fail("provider_request_malformed");
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object" || !["function", "custom"].includes(tool.type) || typeof tool.name !== "string") fail("tool_mapping_error");
    const schema = tool.parameters ?? tool.input_schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail("tool_mapping_error");
    return { name: tool.name, description: tool.description ?? "", input_schema: schema };
  });
}

function choice(value) {
  if (value === undefined || value === "auto") return { type: "auto" };
  if (value === "none") return undefined;
  if (value === "required") return { type: "any" };
  if (value && typeof value === "object" && value.type === "function" && typeof value.name === "string") return { type: "tool", name: value.name };
  fail("invalid_tool_choice");
}

export function buildAnthropicMessagesRequest({ model, payload, credential, internalKey } = {}) {
  if (model?.effectiveTransport !== "anthropic-messages") throw new TypeError("transport mismatch");
  const source = object(payload, "provider_request_malformed");
  const reasoning = reasoningConfig(source.reasoning);
  const maxTokens = outputLimit(source.max_output_tokens, reasoning.budget, reasoning.enabled);
  const system = source.instructions === undefined ? undefined : Array.isArray(source.instructions) ? source.instructions.map((block) => typeof block === "string" ? { type: "text", text: block } : block) : [{ type: "text", text: String(source.instructions) }];
  const json = { model: model.upstreamModel, messages: messagesFromInput(source.input ?? [], model, internalKey), max_tokens: maxTokens, stream: true };
  if (system?.length) json.system = system;
  if (reasoning.enabled) json.thinking = { type: "enabled", budget_tokens: reasoning.budget };
  const tools = toolDeclarations(source.tools);
  if (tools?.length) json.tools = tools;
  const selected = choice(source.tool_choice);
  if (selected && tools?.length) json.tool_choice = selected;
  if (source.parallel_tool_calls === false && tools?.length) json.disable_parallel_tool_use = true;
  const value = credential?.value ?? credential;
  if (typeof value !== "string" || !value) throw new TypeError("provider credential is required");
  return Object.freeze({ url: providerEndpoint(model.baseUrl, "messages"), headers: { "content-type": "application/json", accept: "text/event-stream", "x-api-key": value, "anthropic-version": "2023-06-01" }, body: Buffer.from(JSON.stringify(json), "utf8"), json });
}

function eventFrame(type, value) { return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; }
function responsesUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const mapped = { ...value };
  const cached = value.cache_read_input_tokens ?? value.cached_input_tokens;
  if (cached !== undefined) mapped.input_tokens_details = { ...(mapped.input_tokens_details || {}), cached_tokens: cached };
  delete mapped.cache_read_input_tokens;
  return mapped;
}
function parseFrame(frame) {
  const data = frame.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  if (!data || data === "[DONE]") return undefined;
  try { return JSON.parse(data); } catch { fail("provider_response_malformed"); }
}

class AnthropicStreamTransform extends Transform {
  #buffer = ""; #state = { id: "resp_unknown", model: "", items: new Map(), usage: undefined, stopReason: undefined, messageStopped: false, terminal: false, responseOutput: [] }; #key; #model; #requestContext;
  constructor(model, requestContext) { super(); this.#model = model; this.#requestContext = requestContext; this.#key = requestContext.internalKey; if (requestContext.signal) { if (requestContext.signal.aborted) this.destroy(new AnthropicMessagesAdapterError("request_aborted")); else requestContext.signal.addEventListener("abort", () => this.destroy(new AnthropicMessagesAdapterError("request_aborted")), { once: true }); } }
  _transform(chunk, _encoding, callback) { try { this.#buffer += Buffer.from(chunk).toString("utf8"); let boundary; while ((boundary = this.#buffer.search(/\r\n\r\n|\n\n|\r\r/)) >= 0) { const sep = this.#buffer.match(/\r\n\r\n|\n\n|\r\r/)[0]; const frame = this.#buffer.slice(0, boundary); this.#buffer = this.#buffer.slice(boundary + sep.length); this.#consume(frame); } callback(); } catch (error) { callback(error); } }
  _flush(callback) { try { if (this.#buffer.trim()) this.#consume(this.#buffer); if (!this.#state.terminal) { if (!this.#state.messageStopped) fail("upstream_stream_truncated"); this.#terminal(this.#state.stopReason === "max_tokens" ? "incomplete" : "completed"); } callback(); } catch (error) { callback(error); } }
  #emit(type, value) { this.push(Buffer.from(eventFrame(type, value), "utf8")); }
  #consume(frame) {
    const value = parseFrame(frame); if (!value) return;
    if (value.type === "message_start") { const m = object(value.message); this.#state.id = m.id || this.#state.id; this.#state.model = m.model || this.#model.upstreamModel; this.#state.usage = responsesUsage(m.usage); this.#emit("response.created", { type: "response.created", response: { id: this.#state.id, object: "response", status: "in_progress", model: this.#state.model, output: [], usage: this.#state.usage } }); return; }
    if (this.#state.terminal) return;
    if (value.type === "content_block_start") { this.#start(value); return; }
    if (value.type === "content_block_delta") { this.#delta(value); return; }
    if (value.type === "content_block_stop") { this.#stopBlock(value); return; }
    if (value.type === "message_delta") { this.#state.stopReason = value.delta?.stop_reason; if (value.usage) this.#state.usage = { ...(this.#state.usage || {}), ...responsesUsage(value.usage) }; return; }
    if (value.type === "message_stop") { this.#state.messageStopped = true; this.#terminal(this.#state.stopReason === "max_tokens" ? "incomplete" : "completed"); return; }
    if (value.type === "error") { this.#terminal("failed", value.error?.type === "overloaded_error" ? "provider_overloaded" : "provider_error"); return; }
    fail("provider_response_malformed");
  }
  #start(value) { const block = object(value.content_block); const index = value.index; if (!Number.isSafeInteger(index) || this.#state.items.has(index)) fail("provider_response_malformed"); const item = { index, type: block.type, id: block.id || `item_${index}`, name: block.name, text: [], thinking: [], signature: "", args: "", closed: false }; this.#state.items.set(index, item); if (block.type === "thinking") { item.output = { type: "reasoning", id: item.id, summary: [] }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); this.#emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } }); } else if (block.type === "text") { item.output = { type: "message", id: item.id, role: "assistant", content: [] }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); this.#emit("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }); } else if (block.type === "tool_use") { item.output = { type: "function_call", id: item.id, call_id: block.id || item.id, name: block.name, arguments: "" }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); } else fail("unsupported_anthropic_block"); }
  #delta(value) { const item = this.#state.items.get(value.index); if (!item || item.closed) fail("provider_response_malformed"); const d = object(value.delta); if (d.type === "text_delta") { item.text.push(String(d.text || "")); this.#emit("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: item.index, content_index: 0, delta: String(d.text || "") }); } else if (d.type === "thinking_delta") { item.thinking.push(String(d.thinking || "")); this.#emit("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: item.index, summary_index: 0, delta: String(d.thinking || "") }); } else if (d.type === "signature_delta") item.signature += String(d.signature || ""); else if (d.type === "input_json_delta") { item.args += String(d.partial_json || ""); this.#emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.index, delta: String(d.partial_json || "") }); } else fail("provider_response_malformed"); }
  #stopBlock(value) { const item = this.#state.items.get(value.index); if (!item || item.closed) fail("provider_response_malformed"); item.closed = true; if (item.type === "thinking") { const encrypted = this.#key && sealReasoningEnvelope({ v: 1, provider: this.#model.provider, model: this.#model.upstreamModel, transport: "anthropic-messages", responseId: this.#state.id, itemId: item.id, textSha256: reasoningTextHash(item.thinking), signature: item.signature || null }, this.#key); item.output.encrypted_content = encrypted; item.output.summary = item.thinking.map((text) => ({ type: "summary_text", text })); this.#emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: item.id, output_index: item.index, summary_index: 0, text: item.thinking.join("") }); this.#emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: item.id, output_index: item.index, summary_index: 0, part: { type: "summary_text", text: item.thinking.join("") } }); } else if (item.type === "text") { item.output.content = [{ type: "output_text", text: item.text.join(""), annotations: [] }]; this.#emit("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: item.index, content_index: 0, text: item.text.join("") }); } else { try { item.output.arguments = JSON.stringify(parseObject(item.args || "{}")); } catch { fail("provider_response_malformed"); } this.#emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: item.index, arguments: item.output.arguments }); } this.#state.responseOutput.push(item.output); this.#emit("response.output_item.done", { type: "response.output_item.done", output_index: item.index, item: item.output }); }
  #terminal(status, reason) { if (this.#state.terminal) return; this.#state.terminal = true; for (const item of this.#state.items.values()) if (!item.closed) { item.closed = true; this.#emit("response.output_item.done", { type: "response.output_item.done", output_index: item.index, item: item.output }); } const response = { id: this.#state.id, object: "response", status, model: this.#state.model || this.#model.upstreamModel, output: this.#state.responseOutput, usage: this.#state.usage }; if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" }; if (status === "failed") response.error = { code: reason || "provider_error" }; this.#emit(`response.${status}`, { type: `response.${status}`, response }); this.push(Buffer.from("data: [DONE]\n\n", "utf8")); }
}
export function createAnthropicMessagesTransform(model, requestContext = {}) { return new AnthropicStreamTransform(model, requestContext); }
export function adaptAnthropicMessages({ model, upstream, requestContext = {} } = {}) {
  if (model?.effectiveTransport !== "anthropic-messages") throw new TypeError("transport mismatch");
  if (!upstream || Number(upstream.status) < 200 || Number(upstream.status) >= 300) return Object.freeze({ upstream, transforms: [] });
  const type = String(upstream.headers?.get?.("content-type") || "").toLowerCase();
  return Object.freeze({ upstream, transforms: [type.includes("event-stream") ? createAnthropicMessagesTransform(model, requestContext) : createAnthropicMessagesTransform(model, requestContext)] });
}
