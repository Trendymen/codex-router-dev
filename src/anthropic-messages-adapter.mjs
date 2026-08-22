import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import { providerEndpoint } from "./provider-endpoint.mjs";
import { sealReasoningEnvelope, verifyReasoningEnvelope, reasoningTextHash } from "./reasoning-envelope.mjs";
import { encodeToolDialect, restoreToolEvent } from "./tool-dialect.mjs";

const DEFAULT_MAX = 131072;
const BUDGETS = Object.freeze({ minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 });

export class AnthropicMessagesAdapterError extends Error {
  constructor(code) { super(code); this.name = "AnthropicMessagesAdapterError"; this.code = code; }
}
function fail(code) { throw new AnthropicMessagesAdapterError(code); }
function object(value, code = "provider_request_malformed") { if (!value || typeof value !== "object" || Array.isArray(value)) fail(code); return value; }
function plainJson(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

function imageBlock(value) {
  const source = value?.image_url ?? value?.source;
  if (typeof source !== "string" || !source.startsWith("data:")) fail("unsupported_anthropic_image");
  const match = /^data:([^;,]+);base64,(.*)$/.exec(source);
  if (!match) fail("unsupported_anthropic_image");
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
}

function thinkingFromHistory(block, model, internalKey, expected, trustedResponseId) {
  if (!block?.encrypted_content) fail("thinking_provenance_unknown");
  const parts = Array.isArray(block.summary) ? block.summary.map((part) => typeof part === "string" ? part : part?.text).filter((part) => typeof part === "string") : typeof block.text === "string" ? [block.text] : [];
  const responseId = trustedResponseId;
  const itemId = block.id;
  const verdict = verifyReasoningEnvelope(block.encrypted_content, { ...expected, responseId, itemId, summaryParts: parts }, internalKey);
  if (verdict.status === "foreign") return undefined;
  if (verdict.status !== "valid") fail(verdict.code || "thinking_provenance_unknown");
  if (!parts.length || !verdict.payload.signature) fail("thinking_signature_missing");
  return { type: "thinking", thinking: parts.join(""), signature: verdict.payload.signature };
}

function inputContent(content, model, internalKey, trustedResponseId) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("provider_request_malformed");
  const result = [];
  for (const block of content) {
    if (!block || typeof block !== "object") fail("provider_request_malformed");
    if (block.type === "input_text" || block.type === "output_text" || block.type === "text") result.push({ type: "text", text: String(block.text ?? "") });
    else if (block.type === "input_image") result.push(imageBlock(block));
    else if (block.type === "reasoning") {
      const thinking = thinkingFromHistory(block, model, internalKey, { provider: model.provider, model: model.upstreamModel, transport: "anthropic-messages" }, trustedResponseId);
      if (thinking) result.push(thinking);
    } else if (block.type === "function_call") result.push({ type: "tool_use", id: block.call_id ?? block.id, name: block.name, input: parseObject(block.arguments) });
    else if (block.type === "function_call_output") result.push({ type: "tool_result", tool_use_id: block.call_id ?? block.id, content: typeof block.output === "string" ? block.output : JSON.stringify(block.output) });
    else fail("unsupported_anthropic_block");
  }
  return result;
}
function parseObject(value) { if (value && typeof value === "object" && !Array.isArray(value)) return value; if (typeof value !== "string") fail("provider_request_malformed"); try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_tool_arguments"); return parsed; } catch { fail("invalid_tool_arguments"); } }

function messagesFromInput(input, model, internalKey, trustedResponseId) {
  if (typeof input === "string") return [{ role: "user", content: [{ type: "text", text: input }] }];
  if (!Array.isArray(input)) fail("provider_request_malformed");
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== "object") fail("provider_request_malformed");
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      out.push({ role: "assistant", content: inputContent([item], model, internalKey, trustedResponseId) });
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      out.push({ role: "user", content: inputContent([item], model, internalKey, trustedResponseId) });
      continue;
    }
    if (!["user", "assistant", "tool"].includes(item.role)) fail("provider_request_malformed");
    const role = item.role === "tool" ? "user" : item.role;
    out.push({ role, content: inputContent(item.content ?? item.output ?? "", model, internalKey, trustedResponseId) });
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

function choice(value) {
  if (value === undefined || value === "auto") return { type: "auto" };
  if (value === "none") return undefined;
  if (value === "required") return { type: "any" };
  if (value && typeof value === "object" && value.type === "function" && typeof value.name === "string") return { type: "tool", name: value.name };
  fail("invalid_tool_choice");
}

export function buildAnthropicMessagesRequest({ model, payload, credential, internalKey, requestContext = {} } = {}) {
  if (model?.effectiveTransport !== "anthropic-messages") throw new TypeError("transport mismatch");
  const source = object(payload, "provider_request_malformed");
  const reasoning = reasoningConfig(source.reasoning);
  const maxTokens = outputLimit(source.max_output_tokens, reasoning.budget, reasoning.enabled);
  const toolBuild = encodeToolDialect({ tools: source.tools, toolChoice: source.tool_choice, input: source.input, profile: model.requestProfile ?? model.provider });
  const system = source.instructions === undefined ? undefined : Array.isArray(source.instructions) ? source.instructions.map((block) => typeof block === "string" ? { type: "text", text: block } : block?.type === "input_text" ? { type: "text", text: String(block.text ?? "") } : block) : [{ type: "text", text: String(source.instructions) }];
  const trustedResponseId = requestContext.responseId ?? source.response_id ?? source.responseId;
  const json = { model: model.upstreamModel, messages: messagesFromInput(toolBuild.input ?? source.input ?? [], model, internalKey, trustedResponseId), max_tokens: maxTokens, stream: true };
  if (system?.length) json.system = system;
  if (reasoning.enabled) json.thinking = { type: "enabled", budget_tokens: reasoning.budget };
  const tools = source.tool_choice === "none" ? undefined : toolBuild.tools?.map((tool) => ({ name: tool.name, description: tool.description ?? "", input_schema: plainJson(tool.parameters ?? { type: "object", properties: {} }) }));
  if (tools?.length) json.tools = tools;
  let selected;
  if (source.tool_choice !== "none" && source.tool_choice !== undefined) {
    if (source.tool_choice === "required") selected = { type: "any" };
    else if (source.tool_choice === "auto") selected = { type: "auto" };
    else if (toolBuild.forcedRequirement?.type === "named") {
      const mapped = toolBuild.mapping.entries.find((entry) => entry.kind === toolBuild.forcedRequirement.kind && entry.namespace === toolBuild.forcedRequirement.namespace && entry.name === toolBuild.forcedRequirement.name);
      if (!mapped) fail("tool_mapping_error");
      selected = { type: "tool", name: mapped.encodedName };
    } else selected = choice(source.tool_choice);
  }
  if (selected && tools?.length) json.tool_choice = selected;
  if (source.parallel_tool_calls === false && json.tool_choice && tools?.length) json.disable_parallel_tool_use = true;
  const value = credential?.value ?? credential;
  if (typeof value !== "string" || !value) throw new TypeError("provider credential is required");
  return Object.freeze({ url: providerEndpoint(model.baseUrl, "messages"), headers: { "content-type": "application/json", accept: "text/event-stream", "x-api-key": value, "anthropic-version": "2023-06-01" }, body: Buffer.from(JSON.stringify(json), "utf8"), json, toolBuild });
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
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_WORK = 65536;
function frameBoundary(buffer) {
  const candidates = ["\r\r\n", "\n\r\n", "\r\n\r\n", "\n\n", "\r\r"];
  let best = -1; let length = 0;
  for (const delimiter of candidates) { const index = buffer.indexOf(Buffer.from(delimiter, "ascii")); if (index >= 0 && (best < 0 || index < best || (index === best && delimiter.length > length))) { best = index; length = delimiter.length; } }
  return best < 0 ? undefined : { index: best, length };
}
function parseFrame(frame) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(frame); } catch { fail("provider_response_malformed"); }
  const data = text.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  if (!data || data === "[DONE]") return undefined;
  try { return JSON.parse(data); } catch { fail("provider_response_malformed"); }
}

class AnthropicStreamTransform extends Transform {
  #buffer = Buffer.alloc(0); #queue = []; #queueBytes = 0; #backpressured = false; #pendingCallback; #state = { id: "resp_unknown", model: "", items: new Map(), usage: undefined, stopReason: undefined, messageStopped: false, terminal: false, responseOutput: [], lastIndex: -1, work: 0, bodyBytes: 0, textBytes: 0, argsBytes: 0, signatureBytes: 0 }; #key; #model; #requestContext; #toolBuild;
  constructor(model, requestContext) { super(); this.#model = model; this.#requestContext = requestContext; this.#key = requestContext.internalKey; this.#toolBuild = requestContext.toolBuild; if (requestContext.signal) { const cancel = () => { requestContext.abort?.(); this.destroy(new AnthropicMessagesAdapterError("request_aborted")); }; if (requestContext.signal.aborted) cancel(); else requestContext.signal.addEventListener("abort", cancel, { once: true }); } }
  _transform(chunk, _encoding, callback) { try { const bytes = Buffer.from(chunk); this.#state.bodyBytes += bytes.length; if (this.#state.bodyBytes > MAX_BODY_BYTES) fail("provider_response_malformed"); this.#buffer = Buffer.concat([this.#buffer, bytes]); if (this.#buffer.length > MAX_FRAME_BYTES || this.#state.work > MAX_WORK) fail("provider_response_malformed"); let boundary; while ((boundary = frameBoundary(this.#buffer))) { const frame = this.#buffer.subarray(0, boundary.index); this.#buffer = this.#buffer.subarray(boundary.index + boundary.length); this.#state.work += 1; if (this.#state.work > MAX_WORK) fail("provider_response_malformed"); this.#consume(frame); } if (this.#buffer.length > MAX_FRAME_BYTES) fail("provider_response_malformed"); this.#drain(); if (this.#backpressured || this.#queue.length) this.#pendingCallback = callback; else callback(); } catch (error) { if (error?.code === "request_aborted") callback(error); else { this.#failSafe(error?.code || "provider_response_malformed"); callback(); } } }
  _flush(callback) { try { if (this.#buffer.length) { this.#state.work += 1; this.#consume(this.#buffer); } if (!this.#state.terminal) { if (!this.#state.messageStopped) fail("upstream_stream_truncated"); this.#terminal(this.#state.stopReason === "max_tokens" ? "incomplete" : "completed"); } callback(); } catch (error) { if (error?.code === "request_aborted") callback(error); else { this.#failSafe(error?.code || "upstream_stream_truncated"); callback(); } } }
  #emit(type, value) { let output = value; if (this.#toolBuild?.mapping && output && typeof output === "object") output = restoreToolEvent(output, this.#toolBuild.mapping); if (output === undefined) return; const chunk = Buffer.from(eventFrame(type, output), "utf8"); this.#queueBytes += chunk.length; if (this.#queueBytes > 8 * 1024 * 1024) fail("provider_response_malformed"); this.#queue.push(chunk); this.#drain(); }
  #drain() { while (!this.#backpressured && this.#queue.length) { const chunk = this.#queue.shift(); this.#queueBytes -= chunk.length; if (!this.push(chunk)) this.#backpressured = true; } if (!this.#backpressured && !this.#queue.length && this.#pendingCallback) { const callback = this.#pendingCallback; this.#pendingCallback = undefined; callback(); } }
  _read(size) { this.#backpressured = false; this.#drain(); super._read(size); }
  #failSafe(code) { if (this.#state.terminal) return; try { this.#terminal("failed", code); } catch { this.#state.terminal = true; this.push(Buffer.from(eventFrame("response.failed", { type: "response.failed", response: { id: this.#state.id, object: "response", status: "failed", output: [], error: { code } } }) + "data: [DONE]\n\n", "utf8")); } }
  #consume(frame) {
    const value = parseFrame(frame); if (!value) return;
    if (this.#state.terminal) return;
    if (value.type === "message_start") { const m = object(value.message); if (typeof m.id !== "string" || !m.id || typeof m.model !== "string" || !m.model) fail("provider_response_malformed"); this.#state.id = m.id; this.#state.model = m.model; this.#state.usage = responsesUsage(m.usage); this.#emit("response.created", { type: "response.created", response: { id: this.#state.id, object: "response", status: "in_progress", model: this.#state.model, output: [], usage: this.#state.usage } }); return; }
    if (value.type === "content_block_start") { this.#start(value); return; }
    if (value.type === "content_block_delta") { this.#delta(value); return; }
    if (value.type === "content_block_stop") { this.#stopBlock(value); return; }
    if (value.type === "message_delta") { const delta = object(value.delta, "provider_response_malformed"); if (!["end_turn", "tool_use", "max_tokens"].includes(delta.stop_reason)) fail("provider_response_malformed"); this.#state.stopReason = delta.stop_reason; if (value.usage) this.#state.usage = { ...(this.#state.usage || {}), ...responsesUsage(value.usage) }; return; }
    if (value.type === "message_stop") { this.#state.messageStopped = true; this.#terminal(this.#state.stopReason === "max_tokens" ? "incomplete" : "completed"); return; }
    if (value.type === "error") { this.#terminal("failed", value.error?.type === "overloaded_error" ? "provider_overloaded" : "provider_error"); return; }
    fail("provider_response_malformed");
  }
  #start(value) { const block = object(value.content_block); const index = value.index; if (!Number.isSafeInteger(index) || index <= this.#state.lastIndex || this.#state.items.has(index)) fail("provider_response_malformed"); this.#state.lastIndex = index; const generated = `rsn_${createHash("sha256").update(`${this.#state.id}\0${index}`).digest("base64url").slice(0, 22)}`; const item = { index, type: block.type, id: block.id || (block.type === "thinking" ? generated : `item_${index}`), name: block.name, text: [], thinking: [], signature: "", args: "", closed: false }; this.#state.items.set(index, item); if (block.type === "thinking") { item.output = { type: "reasoning", id: item.id, summary: [] }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); this.#emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: item.id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } }); } else if (block.type === "text") { item.output = { type: "message", id: item.id, role: "assistant", content: [] }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); this.#emit("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }); } else if (block.type === "tool_use") { item.output = { type: "function_call", id: item.id, call_id: block.id || item.id, name: block.name, arguments: "" }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); } else fail("unsupported_anthropic_block"); }
  #delta(value) { const item = this.#state.items.get(value.index); if (!item || item.closed) fail("provider_response_malformed"); const d = object(value.delta); if (d.type === "text_delta" && item.type === "text") { const text = String(d.text || ""); this.#state.textBytes += Buffer.byteLength(text); if (this.#state.textBytes > 4 * 1024 * 1024) fail("provider_response_malformed"); item.text.push(text); this.#emit("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: item.index, content_index: 0, delta: text }); } else if (d.type === "thinking_delta" && item.type === "thinking") { const text = String(d.thinking || ""); this.#state.textBytes += Buffer.byteLength(text); if (this.#state.textBytes > 4 * 1024 * 1024) fail("provider_response_malformed"); item.thinking.push(text); this.#emit("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: item.index, summary_index: 0, delta: text }); } else if (d.type === "signature_delta" && item.type === "thinking") { item.signature += String(d.signature || ""); this.#state.signatureBytes += Buffer.byteLength(String(d.signature || "")); if (this.#state.signatureBytes > 1024 * 1024) fail("provider_response_malformed"); } else if (d.type === "input_json_delta" && item.type === "tool_use") { const args = String(d.partial_json || ""); item.args += args; this.#state.argsBytes += Buffer.byteLength(args); if (this.#state.argsBytes > 8 * 1024 * 1024) fail("provider_response_malformed"); this.#emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.index, delta: args }); } else fail("provider_response_malformed"); }
  #stopBlock(value) { const item = this.#state.items.get(value.index); if (!item || item.closed) fail("provider_response_malformed"); item.closed = true; if (item.type === "thinking") { const encrypted = this.#key && sealReasoningEnvelope({ v: 1, provider: this.#model.provider, model: this.#model.upstreamModel, transport: "anthropic-messages", responseId: this.#state.id, itemId: item.id, textSha256: reasoningTextHash(item.thinking), signature: item.signature || null }, this.#key); item.output.encrypted_content = encrypted; item.output.summary = item.thinking.map((text) => ({ type: "summary_text", text })); this.#emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: item.id, output_index: item.index, summary_index: 0, text: item.thinking.join("") }); this.#emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: item.id, output_index: item.index, summary_index: 0, part: { type: "summary_text", text: item.thinking.join("") } }); } else if (item.type === "text") { item.output.content = [{ type: "output_text", text: item.text.join(""), annotations: [] }]; this.#emit("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: item.index, content_index: 0, text: item.text.join("") }); } else { try { item.output.arguments = JSON.stringify(parseObject(item.args || "{}")); } catch { fail("provider_response_malformed"); } this.#emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: item.index, arguments: item.output.arguments }); } this.#state.responseOutput.push({ index: item.index, item: item.output }); this.#emit("response.output_item.done", { type: "response.output_item.done", output_index: item.index, item: item.output }); }
  #terminal(status, reason) { if (this.#state.terminal) return; if (status !== "failed" && !this.#state.stopReason) fail("provider_response_malformed"); for (const item of this.#state.items.values()) if (!item.closed && status !== "failed") fail("provider_response_malformed"); this.#state.terminal = true; for (const item of this.#state.items.values()) if (!item.closed) { item.closed = true; this.#emit("response.output_item.done", { type: "response.output_item.done", output_index: item.index, item: item.output }); } const response = { id: this.#state.id, object: "response", status, model: this.#state.model || this.#model.upstreamModel, output: this.#state.responseOutput.sort((left, right) => left.index - right.index).map(({ item }) => item), usage: this.#state.usage }; if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" }; if (status === "failed") response.error = { code: reason || "provider_error" }; this.#emit(`response.${status}`, { type: `response.${status}`, response }); this.push(Buffer.from("data: [DONE]\n\n", "utf8")); }
}
export function createAnthropicMessagesTransform(model, requestContext = {}) { return new AnthropicStreamTransform(model, requestContext); }
export function adaptAnthropicMessages({ model, upstream, requestContext = {} } = {}) {
  if (model?.effectiveTransport !== "anthropic-messages") throw new TypeError("transport mismatch");
  if (!upstream || Number(upstream.status) < 200 || Number(upstream.status) >= 300) return Object.freeze({ upstream, transforms: [] });
  const type = String(upstream.headers?.get?.("content-type") || "").toLowerCase();
  return Object.freeze({ upstream, toolBuild: requestContext.toolBuild, transforms: [type.includes("event-stream") ? createAnthropicMessagesTransform(model, requestContext) : createAnthropicMessagesTransform(model, requestContext)] });
}
