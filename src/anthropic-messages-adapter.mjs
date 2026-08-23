import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import { providerEndpoint } from "./provider-endpoint.mjs";
import { authenticateReasoningEnvelope, reasoningItemId, reasoningOutputIndex, sealReasoningEnvelope, reasoningTextHash } from "./reasoning-envelope.mjs";
import { encodeToolDialect, restoreToolEvent } from "./tool-dialect.mjs";
import { ERROR_DEFINITIONS, failedResponseEvent, formatTerminalFrames, incompleteResponseEvent, routerError } from "./public-error.mjs";

const DEFAULT_MAX = 131072;
const BUDGETS = Object.freeze({ minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 });
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_WORK = 65536;
const MAX_ITEMS = 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_ARGS_BYTES = 8 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024 * 1024;
const TERMINAL_QUEUE_RESERVE = 64 * 1024;

export class AnthropicMessagesAdapterError extends Error {
  constructor(code) { super(code); this.name = "AnthropicMessagesAdapterError"; this.code = code; }
}
const fail = (code) => { throw new AnthropicMessagesAdapterError(code); };
function object(value, code = "provider_request_malformed") { if (!value || typeof value !== "object" || Array.isArray(value)) fail(code); return value; }
function plainJson(value) { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

function imageBlock(value) {
  const source = value?.image_url ?? value?.source;
  if (typeof source !== "string" || !source.startsWith("data:")) fail("unsupported_anthropic_image");
  const match = /^data:([^;,]+);base64,(.*)$/.exec(source);
  if (!match) fail("unsupported_anthropic_image");
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
}

function thinkingFromHistory(block, model, internalKey) {
  if (!internalKey) fail("thinking_provenance_unknown");
  if (!block || typeof block.id !== "string" || !block.id) {
    if (typeof block?.encrypted_content === "string" && block.encrypted_content.startsWith("cr.reasoning.")) fail("thinking_signature_invalid");
    fail("thinking_provenance_unknown");
  }
  if (typeof block.encrypted_content !== "string" || !block.encrypted_content) fail("thinking_provenance_unknown");
  const parts = Array.isArray(block.summary)
    ? block.summary.map((part) => typeof part === "string" ? part : part?.text).filter((part) => typeof part === "string")
    : typeof block.text === "string" ? [block.text] : [];
  const authenticated = authenticateReasoningEnvelope(block.encrypted_content, internalKey);
  if (authenticated.status !== "valid") fail(authenticated.code || "thinking_provenance_unknown");
  const signed = authenticated.payload;
  if (signed.provider !== model.provider || signed.model !== model.upstreamModel || signed.transport !== "anthropic-messages") return undefined;
  const outputIndex = reasoningOutputIndex(signed.responseId, signed.itemId, MAX_ITEMS);
  if (signed.itemId !== block.id || outputIndex === undefined || signed.textSha256 !== reasoningTextHash(parts)) fail("thinking_signature_invalid");
  if (!parts.length || typeof signed.signature !== "string" || !signed.signature) fail("thinking_signature_missing");
  return { type: "thinking", thinking: parts.join(""), signature: signed.signature };
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") fail("provider_request_malformed");
  try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("invalid_tool_arguments"); return parsed; }
  catch (error) { if (error instanceof AnthropicMessagesAdapterError) throw error; fail("invalid_tool_arguments"); }
}

function inputContent(content, model, internalKey) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) fail("provider_request_malformed");
  return content.map((block) => {
    if (!block || typeof block !== "object") fail("provider_request_malformed");
    if (["input_text", "output_text", "text"].includes(block.type)) return { type: "text", text: String(block.text ?? "") };
    if (block.type === "input_image") return imageBlock(block);
    if (block.type === "reasoning") return thinkingFromHistory(block, model, internalKey);
    if (block.type === "function_call") return { type: "tool_use", id: block.call_id ?? block.id, name: block.name, input: parseObject(block.arguments) };
    if (block.type === "function_call_output") return { type: "tool_result", tool_use_id: block.call_id ?? block.id, content: typeof block.output === "string" ? block.output : JSON.stringify(block.output) };
    fail("unsupported_anthropic_block");
  }).filter(Boolean);
}

function messagesFromInput(input, model, internalKey) {
  if (typeof input === "string") input = [{ role: "user", content: input }];
  if (!Array.isArray(input)) fail("provider_request_malformed");
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== "object") fail("provider_request_malformed");
    if (["reasoning", "function_call", "custom_tool_call"].includes(item.type)) { out.push({ role: "assistant", content: inputContent([item], model, internalKey) }); continue; }
    if (["function_call_output", "custom_tool_call_output"].includes(item.type)) { out.push({ role: "user", content: inputContent([item], model, internalKey) }); continue; }
    if (!["user", "assistant", "tool"].includes(item.role)) fail("provider_request_malformed");
    out.push({ role: item.role === "tool" ? "user" : item.role, content: inputContent(item.content ?? item.output ?? "", model, internalKey) });
  }
  return out;
}

function reasoningConfig(value) {
  if (value === undefined) return { budget: BUDGETS.max, enabled: true };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_reasoning_config");
  if (value.effort === "off" || value.effort === "none") return { enabled: false };
  if (value.effort === undefined) return { budget: BUDGETS.max, enabled: true };
  if (!(value.effort in BUDGETS)) fail("unsupported_reasoning_effort");
  return { budget: BUDGETS[value.effort], enabled: true };
}
function outputLimit(value, budget, enabled) {
  const max = value === undefined ? DEFAULT_MAX : value;
  if (!Number.isSafeInteger(max) || max <= 0) fail("invalid_output_limit");
  if (max > DEFAULT_MAX) fail("output_limit_exceeds_provider_cap");
  if (enabled && max < budget + 1024) fail("thinking_budget_exceeds_output_limit");
  return max;
}

export function buildAnthropicMessagesRequest({ model, payload, credential, internalKey, requestContext = {} } = {}) {
  if (model?.effectiveTransport !== "anthropic-messages") throw new TypeError("transport mismatch");
  const source = object(payload, "provider_request_malformed");
  const reasoning = reasoningConfig(source.reasoning);
  const maxTokens = outputLimit(source.max_output_tokens, reasoning.budget, reasoning.enabled);
  const normalizedInput = typeof source.input === "string" ? [{ role: "user", content: source.input }] : source.input;
  const toolBuild = encodeToolDialect({ tools: source.tools, toolChoice: source.tool_choice, input: normalizedInput, profile: model.requestProfile ?? model.provider, preserveStrict: true });
  const system = source.instructions === undefined ? undefined : Array.isArray(source.instructions)
    ? source.instructions.map((block) => typeof block === "string" ? { type: "text", text: block } : block?.type === "input_text" ? { type: "text", text: String(block.text ?? "") } : block)
    : [{ type: "text", text: String(source.instructions) }];
  const input = toolBuild.input ?? normalizedInput ?? [];
  const json = { model: model.upstreamModel, messages: messagesFromInput(input, model, internalKey), max_tokens: maxTokens, stream: true };
  if (system?.length) json.system = system;
  if (reasoning.enabled) json.thinking = { type: "enabled", budget_tokens: reasoning.budget };
  const tools = source.tool_choice === "none" ? undefined : toolBuild.tools?.map((tool) => ({ name: tool.name, description: tool.description ?? "", input_schema: plainJson(tool.parameters ?? { type: "object", properties: {} }), ...(tool.strict === true ? { strict: true } : {}) }));
  if (tools?.length) json.tools = tools;
  const choice = source.tool_choice === "none" ? undefined : source.tool_choice === "required" ? { type: "any" } : source.tool_choice === "auto" || source.tool_choice === undefined ? (tools?.length ? { type: "auto" } : undefined) : toolBuild.forcedRequirement?.type === "named"
    ? { type: "tool", name: toolBuild.mapping.entries.find((entry) => entry.kind === toolBuild.forcedRequirement.kind && entry.namespace === toolBuild.forcedRequirement.namespace && entry.name === toolBuild.forcedRequirement.name)?.encodedName }
    : typeof source.tool_choice === "object" && ["function", "custom"].includes(source.tool_choice?.type) ? { type: "tool", name: source.tool_choice.namespace ? `${source.tool_choice.namespace}__${source.tool_choice.name}` : source.tool_choice.name } : undefined;
  if (choice?.name === undefined && source.tool_choice && typeof source.tool_choice === "object" && source.tool_choice !== null && source.tool_choice !== "auto" && source.tool_choice !== "required") fail("tool_mapping_error");
  if (choice && tools?.length) json.tool_choice = source.parallel_tool_calls === false ? { ...choice, disable_parallel_tool_use: true } : choice;
  const value = credential?.value ?? credential;
  if (typeof value !== "string" || !value) throw new TypeError("provider credential is required");
  return Object.freeze({ url: providerEndpoint(model.baseUrl, "messages"), headers: { "content-type": "application/json", accept: "text/event-stream", "x-api-key": value, "anthropic-version": "2023-06-01" }, body: Buffer.from(JSON.stringify(json), "utf8"), json, toolBuild });
}

function eventFrame(type, value) { return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; }
function responsesUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const mapped = { ...value }; const cached = value.cache_read_input_tokens ?? value.cached_input_tokens;
  if (cached !== undefined) mapped.input_tokens_details = { ...(mapped.input_tokens_details || {}), cached_tokens: cached };
  delete mapped.cache_read_input_tokens; delete mapped.cached_input_tokens; return mapped;
}
function lineLength(buffer, offset) { if (buffer[offset] === 0x0d) return buffer[offset + 1] === 0x0a ? 2 : 1; if (buffer[offset] === 0x0a) return 1; return 0; }
function frameBoundary(buffer, offset = 0) { for (let index = offset; index < buffer.length; index += 1) { const first = lineLength(buffer, index); if (!first) continue; const second = lineLength(buffer, index + first); if (second) return { index, length: first + second }; } return undefined; }
function unfinishedFrameBytes(buffer) {
  if (buffer.length >= 2 && buffer[buffer.length - 2] === 0x0d && buffer[buffer.length - 1] === 0x0a) return buffer.length - 2;
  if (buffer.length && (buffer[buffer.length - 1] === 0x0d || buffer[buffer.length - 1] === 0x0a)) return buffer.length - 1;
  return buffer.length;
}
function publicCodeFor(reason) {
  if (ERROR_DEFINITIONS[reason]) return reason;
  if (reason === "invalid_tool_arguments") return "tool_mapping_error";
  if (reason === "unsupported_anthropic_image") return "unsupported_anthropic_block";
  return "reasoning_protocol_error";
}
function parseFrame(frame) {
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(frame); } catch { fail("provider_response_malformed"); }
  const data = text.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
  if (!data) return undefined; if (data === "[DONE]") return { done: true };
  try { return { value: JSON.parse(data) }; } catch { fail("provider_response_malformed"); }
}
function generatedTextId(responseId, outputIndex) { return `msg_${createHash("sha256").update(`${responseId}:${outputIndex}`, "utf8").digest("base64url").slice(0, 24)}`; }
function generatedToolId(responseId, outputIndex) { return `fc_${createHash("sha256").update(`${responseId}:${outputIndex}`, "utf8").digest("base64url").slice(0, 24)}`; }

class AnthropicStreamTransform extends Transform {
  #buffer = Buffer.alloc(0); #queue = []; #queueBytes = 0; #backpressured = false; #pendingTransform; #pendingFlush;
  #frameScanOffset = 0; #pendingBoundary; #settleScheduled = false; #settleGeneration = 0; #destroyed = false;
  #state = { id: undefined, model: "", created: undefined, messageStarted: false, blockProviderIndexes: new Set(), nextOutputIndex: 0, items: new Map(), usage: undefined, stopReason: undefined, messageStopped: false, terminal: false, sequence: 0, work: 0, bodyBytes: 0, textBytes: 0, argsBytes: 0, signatureBytes: 0 };
  #model; #requestContext; #key; #toolBuild; #abortListener; #abortCalled = false;
  constructor(model, requestContext) { super(); this.#model = model; this.#requestContext = requestContext; this.#key = requestContext.internalKey; this.#toolBuild = requestContext.toolBuild; if (requestContext.signal) { this.#abortListener = () => { if (this.#state.terminal && !this.#pendingTransform && !this.#pendingFlush) return; this.#callAbort(); this.destroy(new AnthropicMessagesAdapterError("request_aborted")); }; if (requestContext.signal.aborted) this.#abortListener(); else requestContext.signal.addEventListener("abort", this.#abortListener, { once: true }); } }
  #callAbort() { if (this.#abortCalled) return; this.#abortCalled = true; try { this.#requestContext.abort?.(); } catch {} }
  #cleanup() { if (this.#abortListener && this.#requestContext.signal) { try { this.#requestContext.signal.removeEventListener("abort", this.#abortListener); } catch {} this.#abortListener = undefined; } }
  _destroy(error, callback) {
    this.#destroyed = true;
    this.#settleGeneration += 1;
    this.#cleanup();
    const pending = [this.#pendingTransform, this.#pendingFlush].filter(Boolean);
    this.#pendingTransform = undefined;
    this.#pendingFlush = undefined;
    this.#buffer = Buffer.alloc(0);
    this.#queue = [];
    this.#queueBytes = 0;
    this.#pendingBoundary = undefined;
    this.#frameScanOffset = 0;
    const reason = error || new Error("The stream was destroyed.");
    for (const settle of pending) {
      try { settle(reason); } catch {}
    }
    callback(error);
  }
  _transform(chunk, _encoding, callback) {
    if (this.#destroyed) { callback(new Error("The stream was destroyed.")); return; }
    try { const bytes = Buffer.from(chunk); this.#state.bodyBytes += bytes.length; if (this.#state.bodyBytes > MAX_BODY_BYTES) fail("provider_response_malformed"); this.#buffer = Buffer.concat([this.#buffer, bytes]); this.#processBuffered(); this.#drain(); this.#settle(); if (this.#backpressured) this.#pendingTransform = callback; else callback(); } catch (error) { if (error?.code === "request_aborted") callback(error); else { this.#failSafe(error?.code || "provider_response_malformed"); this.#drain(); if (this.#backpressured) this.#pendingTransform = callback; else callback(); } }
  }
  _flush(callback) {
    if (this.#destroyed) { callback(new Error("The stream was destroyed.")); return; }
    try { this.#processBuffered(); if (!this.#backpressured && this.#buffer.length) { const parsed = parseFrame(this.#buffer); this.#buffer = Buffer.alloc(0); if (parsed) this.#consumeParsed(parsed); } if (!this.#state.terminal && !this.#backpressured) { if (!this.#state.messageStopped) fail("upstream_stream_truncated"); this.#terminal(this.#state.stopReason === "max_tokens" ? "incomplete" : "completed"); } this.#drain(); this.#settle(); if (this.#backpressured || this.#queue.length || this.#buffer.length) this.#pendingFlush = callback; else callback(); } catch (error) { if (error?.code === "request_aborted") callback(error); else { this.#failSafe(error?.code || "upstream_stream_truncated"); this.#drain(); this.#settle(); if (this.#backpressured || this.#queue.length) this.#pendingFlush = callback; else callback(); } }
  }
  _read() { if (this.#destroyed) return; this.#backpressured = false; this.#drain(); this.#processBuffered(); this.#drain(); this.#settle(); }
  #locateBoundary() {
    if (this.#pendingBoundary) return this.#pendingBoundary;
    const boundary = frameBoundary(this.#buffer, this.#frameScanOffset);
    if (boundary) {
      if (boundary.index > MAX_FRAME_BYTES) fail("provider_response_malformed");
      this.#pendingBoundary = boundary;
      return boundary;
    }
    if (unfinishedFrameBytes(this.#buffer) > MAX_FRAME_BYTES) fail("provider_response_malformed");
    this.#frameScanOffset = Math.max(0, this.#buffer.length - 3);
    return undefined;
  }
  #processBuffered() { let boundary; while ((boundary = this.#locateBoundary())) { if (this.#backpressured) return; const frame = this.#buffer.subarray(0, boundary.index); this.#buffer = this.#buffer.subarray(boundary.index + boundary.length); this.#pendingBoundary = undefined; this.#frameScanOffset = 0; this.#consume(frame); } }
  #drain() { while (!this.#backpressured && this.#queue.length) { const chunk = this.#queue.shift(); this.#queueBytes -= chunk.length; if (!this.push(chunk)) this.#backpressured = true; } }
  #settle() {
    if (this.#destroyed || this.#settleScheduled || this.#backpressured || this.#queue.length || (!this.#pendingTransform && !this.#pendingFlush)) return;
    const generation = this.#settleGeneration;
    this.#settleScheduled = true;
    queueMicrotask(() => {
      this.#settleScheduled = false;
      if (this.#destroyed || generation !== this.#settleGeneration) return;
      if (this.#backpressured || this.#queue.length) return;
      const callback = this.#pendingTransform || this.#pendingFlush;
      if (this.#pendingTransform) this.#pendingTransform = undefined;
      else this.#pendingFlush = undefined;
      callback?.();
    });
  }
  #enqueue(chunk, terminal = false) {
    if (this.#destroyed) return;
    if (!this.#backpressured && !this.#queue.length) {
      if (!this.push(chunk)) this.#backpressured = true;
      return;
    }
    const limit = terminal ? MAX_BODY_BYTES : MAX_BODY_BYTES - TERMINAL_QUEUE_RESERVE;
    if (this.#queueBytes + chunk.length > limit) fail("provider_response_malformed");
    this.#queueBytes += chunk.length;
    this.#queue.push(chunk);
    this.#drain();
  }
  #emit(type, value) { if (type !== "[DONE]" && value === undefined) return; let output = value; if (type !== "[DONE]" && this.#toolBuild?.mapping && output && typeof output === "object") output = restoreToolEvent(output, this.#toolBuild.mapping); if (type !== "[DONE]" && output === undefined) return; if (type !== "[DONE]" && output && typeof output === "object") output = { ...output, sequence_number: ++this.#state.sequence }; const chunk = Buffer.from(type === "[DONE]" ? "data: [DONE]\n\n" : eventFrame(type, output), "utf8"); this.#enqueue(chunk, type === "[DONE]" || type === "response.completed" || type === "response.incomplete" || type === "response.failed"); }
  #spend() { this.#state.work += 1; if (this.#state.work > MAX_WORK) fail("provider_response_malformed"); }
  #terminalContext(output) { return { responseId: this.#state.id || this.#requestContext.responseId || "resp_unknown", model: this.#state.model || this.#model.slug || this.#model.upstreamModel || "unknown", createdAt: this.#state.created ?? 0, sequenceNumber: this.#state.sequence + 1, output, usage: this.#state.usage ?? null }; }
  #emitTrustedTerminal(event) { this.#state.sequence = event.sequence_number; this.#enqueue(Buffer.from(formatTerminalFrames(event), "utf8"), true); }
  #failSafe(code) { if (this.#state.terminal) { try { this.#requestContext.observeReasoningProtocol?.({ code: "event_after_terminal" }); } catch {} return; } this.#callAbort(); try { this.#terminal("failed", code); } catch { const output = [...this.#state.items.values()].filter((item) => item.closed).sort((a, b) => a.index - b.index).map((item) => item.output); this.#state.terminal = true; this.#emitTrustedTerminal(failedResponseEvent(this.#terminalContext(output), routerError(publicCodeFor(code), { internalReason: code }))); } }
  #consume(frame) { const parsed = parseFrame(frame); if (parsed) this.#consumeParsed(parsed); }
  #consumeParsed(parsed) { if (parsed.done) { if (this.#state.terminal) try { this.#requestContext.observeReasoningProtocol?.({ code: "event_after_terminal" }); } catch {} return; } const value = parsed.value; if (!value || typeof value !== "object") fail("provider_response_malformed"); if (this.#state.terminal) { try { this.#requestContext.observeReasoningProtocol?.({ code: "event_after_terminal" }); } catch {} return; } this.#spend(); if (value.type === "message_start") return this.#messageStart(value); if (!this.#state.messageStarted) fail("provider_response_malformed"); if (this.#state.stopReason && ["content_block_start", "content_block_delta", "content_block_stop"].includes(value.type)) fail("provider_response_malformed"); if (value.type === "content_block_start") return this.#start(value); if (value.type === "content_block_delta") return this.#delta(value); if (value.type === "content_block_stop") return this.#stopBlock(value); if (value.type === "message_delta") { const delta = object(value.delta); if (delta.stop_reason !== undefined && !["end_turn", "tool_use", "max_tokens"].includes(delta.stop_reason)) fail("provider_response_malformed"); if (delta.stop_reason !== undefined) this.#state.stopReason = delta.stop_reason; if (value.usage) this.#state.usage = { ...(this.#state.usage || {}), ...responsesUsage(value.usage) }; return; } if (value.type === "message_stop") { if (this.#state.messageStopped) { try { this.#requestContext.observeReasoningProtocol?.({ code: "event_after_terminal" }); } catch {} return; } this.#state.messageStopped = true; return this.#terminal(this.#state.stopReason === "max_tokens" ? "incomplete" : "completed"); } if (value.type === "error") return this.#terminal("failed", value.error?.type === "overloaded_error" ? "provider_overloaded" : "provider_error"); fail("provider_response_malformed"); }
  #messageStart(value) { if (this.#state.messageStarted) fail("provider_response_malformed"); const message = object(value.message); if (typeof message.id !== "string" || !message.id || typeof message.model !== "string" || !message.model) fail("provider_response_malformed"); this.#state.messageStarted = true; this.#state.id = message.id; this.#state.model = this.#model.slug || this.#model.upstreamModel; this.#state.created = Number.isSafeInteger(message.created_at) ? message.created_at : 0; this.#state.usage = responsesUsage(message.usage); this.#emit("response.created", { type: "response.created", response: { id: this.#state.id, object: "response", status: "in_progress", model: this.#state.model, created_at: this.#state.created, output: [], usage: this.#state.usage ?? null } }); }
  #start(value) { const block = object(value.content_block); const providerIndex = value.index; if (!Number.isSafeInteger(providerIndex) || providerIndex < 0 || this.#state.blockProviderIndexes.has(providerIndex)) fail("provider_response_malformed"); if (this.#state.items.size >= MAX_ITEMS || [...this.#state.items.values()].some((item) => !item.closed)) fail("provider_response_malformed"); this.#state.blockProviderIndexes.add(providerIndex); const index = this.#state.nextOutputIndex++; const type = block.type; if (type === "thinking" && !this.#key) fail("thinking_signature_missing"); const callId = typeof block.id === "string" && block.id ? block.id : `call_${index}`; const id = type === "thinking" ? reasoningItemId(this.#state.id, index) : type === "text" ? generatedTextId(this.#state.id, index) : generatedToolId(this.#state.id, index); const item = { providerIndex, index, type, id, callId, text: "", signature: "", initialInput: block.input && typeof block.input === "object" ? block.input : undefined, args: "", closed: false, output: undefined }; if (type === "thinking") { item.output = { type: "reasoning", id, status: "in_progress", summary: [], content: [] }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); this.#emit("response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } }); } else if (type === "text") { item.output = { type: "message", id, status: "in_progress", role: "assistant", content: [] }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); this.#emit("response.content_part.added", { type: "response.content_part.added", item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }); } else if (type === "tool_use") { if (typeof block.name !== "string" || !block.name) fail("provider_response_malformed"); item.output = { type: "function_call", id, call_id: callId, name: block.name, arguments: "" }; this.#emit("response.output_item.added", { type: "response.output_item.added", output_index: index, item: item.output }); } else fail("unsupported_anthropic_block"); this.#state.items.set(providerIndex, item); }
  #delta(value) { const item = this.#state.items.get(value.index); if (!item || item.closed) fail("provider_response_malformed"); const delta = object(value.delta); let text; if (delta.type === "text_delta" && item.type === "text") text = delta.text; else if (delta.type === "thinking_delta" && item.type === "thinking") text = delta.thinking; else if (delta.type === "signature_delta" && item.type === "thinking") { text = delta.signature; if (typeof text !== "string") fail("provider_response_malformed"); item.signature += text; this.#state.signatureBytes += Buffer.byteLength(text); if (this.#state.signatureBytes > MAX_SIGNATURE_BYTES) fail("provider_response_malformed"); return; } else if (delta.type === "input_json_delta" && item.type === "tool_use") { text = delta.partial_json; if (typeof text !== "string") fail("provider_response_malformed"); item.args += text; this.#state.argsBytes += Buffer.byteLength(text); if (this.#state.argsBytes > MAX_ARGS_BYTES) fail("provider_response_malformed"); this.#emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.index, delta: text }); return; } else fail("provider_response_malformed"); if (typeof text !== "string") fail("provider_response_malformed"); item.text += text; this.#state.textBytes += Buffer.byteLength(text); if (this.#state.textBytes > MAX_TEXT_BYTES) fail("provider_response_malformed"); this.#emit(item.type === "thinking" ? "response.reasoning_summary_text.delta" : "response.output_text.delta", item.type === "thinking" ? { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: item.index, summary_index: 0, delta: text } : { type: "response.output_text.delta", item_id: item.id, output_index: item.index, content_index: 0, delta: text }); }
  #stopBlock(value) { const item = this.#state.items.get(value.index); if (!item || item.closed) fail("provider_response_malformed"); item.closed = true; if (item.type === "thinking") { if (!this.#key) fail("thinking_signature_missing"); item.output.status = "completed"; item.output.summary = [{ type: "summary_text", text: item.text }]; item.output.encrypted_content = sealReasoningEnvelope({ v: 1, provider: this.#model.provider, model: this.#model.upstreamModel, transport: "anthropic-messages", responseId: this.#state.id, itemId: item.id, textSha256: reasoningTextHash([item.text]), signature: item.signature || null }, this.#key); this.#emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: item.id, output_index: item.index, summary_index: 0, text: item.text }); this.#emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: item.id, output_index: item.index, summary_index: 0, part: { type: "summary_text", text: item.text } }); } else if (item.type === "text") { item.output.status = "completed"; item.output.content = [{ type: "output_text", text: item.text, annotations: [] }]; this.#emit("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: item.index, content_index: 0, text: item.text }); this.#emit("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: item.index, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } }); } else { const args = item.args || (item.initialInput === undefined ? "{}" : JSON.stringify(item.initialInput)); item.output.arguments = JSON.stringify(parseObject(args)); this.#emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: item.index, arguments: item.output.arguments }); } this.#emit("response.output_item.done", { type: "response.output_item.done", output_index: item.index, item: item.output }); }
  #closeTerminalItem(item, status) { if (item.closed) return; item.closed = true; item.output.status = status === "failed" ? "incomplete" : status; if (item.type === "thinking") { item.output.summary = [{ type: "summary_text", text: item.text }]; this.#emit("response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: item.id, output_index: item.index, summary_index: 0, text: item.text }); this.#emit("response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: item.id, output_index: item.index, summary_index: 0, part: { type: "summary_text", text: item.text } }); } else if (item.type === "text") { item.output.content = [{ type: "output_text", text: item.text, annotations: [] }]; this.#emit("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: item.index, content_index: 0, text: item.text }); this.#emit("response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: item.index, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } }); } else { item.output.arguments = ""; this.#emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: item.index, arguments: "" }); } this.#emit("response.output_item.done", { type: "response.output_item.done", output_index: item.index, item: item.output }); }
  #terminal(status, reason) { if (this.#state.terminal) return; if (!this.#state.messageStarted && status !== "failed") fail("provider_response_malformed"); if (status === "failed") this.#callAbort(); const open = [...this.#state.items.values()].filter((item) => !item.closed); if (status === "completed" && open.length) fail("provider_response_malformed"); for (const item of open) { if (status === "failed" || status === "incomplete") this.#closeTerminalItem(item, status); else this.#stopBlock({ index: item.providerIndex }); } this.#state.terminal = true; const output = [...this.#state.items.values()].sort((a, b) => a.index - b.index).map((item) => item.output); if (status === "failed") { this.#emitTrustedTerminal(failedResponseEvent(this.#terminalContext(output), routerError(publicCodeFor(reason), { internalReason: reason }))); return; } if (status === "incomplete") { this.#emitTrustedTerminal(incompleteResponseEvent(this.#terminalContext(output), "max_output_tokens")); return; } const response = { id: this.#state.id || "resp_unknown", object: "response", status, model: this.#state.model || this.#model.slug || this.#model.upstreamModel, created_at: this.#state.created ?? 0, output, usage: this.#state.usage ?? null }; this.#emit(`response.${status}`, { type: `response.${status}`, response }); this.#emit("[DONE]"); }
}

export function createAnthropicMessagesTransform(model, requestContext = {}) { return new AnthropicStreamTransform(model, requestContext); }
export function adaptAnthropicMessages({ model, upstream, requestContext = {} } = {}) { if (model?.effectiveTransport !== "anthropic-messages") throw new TypeError("transport mismatch"); if (!upstream || Number(upstream.status) < 200 || Number(upstream.status) >= 300) return Object.freeze({ upstream, transforms: [] }); return Object.freeze({ upstream, toolBuild: requestContext.toolBuild, transforms: [createAnthropicMessagesTransform(model, requestContext)] }); }
