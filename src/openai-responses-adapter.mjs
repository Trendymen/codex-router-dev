import { Duplex, Transform } from "node:stream";
import { types as utilTypes } from "node:util";

import { providerEndpoint } from "./provider-endpoint.mjs";
import { reasoningTransformForModel, normalizeReasoningResponse } from "./reasoning-summary-compat.mjs";
import { createForcedToolBuffer, encodeToolDialect, restoreToolEvent, ToolDialectError } from "./tool-dialect.mjs";

const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_WORK = 65_536;
const MAX_JSON_COMPARE_DEPTH = 64;
const MAX_JSON_COMPARE_WORK = 65_536;
const RELAY_CONTEXT_STATE = new WeakMap();

// This object is deliberately caller-owned but contains only JSON values read
// from the provider stream.  The forwarder uses it if a transform fails after
// committing bytes, so a terminal frame continues the actual response rather
// than inventing a new response identity.
export function createResponsesRelayContext() {
  const context = {
    responseId: "resp_unknown",
    model: "unknown",
    sequenceNumber: undefined,
    output: [],
    usage: undefined,
    relayedBytes: 0,
    terminalSeen: false,
    doneSeen: false,
    readWakeups: 0,
  };
  RELAY_CONTEXT_STATE.set(context, { output: new Map() });
  return context;
}

function observeResponseContext(context, event, { terminal = true } = {}) {
  if (!context || !event || typeof event !== "object") return;
  const terminalEvent = ["response.completed", "response.incomplete", "response.failed"].includes(event.type);
  if (terminalEvent && !terminal) return;
  const response = event.response && typeof event.response === "object" ? event.response : undefined;
  const sequence = event.sequence_number;
  if (Number.isSafeInteger(sequence) && sequence >= 0) context.sequenceNumber = sequence;
  const id = response?.id ?? event.response_id;
  if (typeof id === "string" && id) context.responseId = id;
  const model = response?.model ?? event.model;
  if (typeof model === "string" && model) context.model = model;
  const state = RELAY_CONTEXT_STATE.get(context);
  if (event.type === "response.output_item.done" && event.item && typeof event.item === "object") {
    const index = Number.isSafeInteger(event.output_index) && event.output_index >= 0
      ? event.output_index
      : state?.output.size ?? context.output.length;
    state?.output.set(index, event.item);
    if (state) context.output = [...state.output.entries()].sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
  }
  if (Array.isArray(response?.output)) context.output = response.output;
  else if (Array.isArray(event.output)) context.output = event.output;
  const usage = event.usage ?? response?.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) context.usage = usage;
  if (terminal && terminalEvent) context.terminalSeen = true;
}

function commitResponseContext(context, event) {
  if (!context || !event || typeof event !== "object") return;
  if (Object.hasOwn(event, "sequence_number")) {
    const sequence = event.sequence_number;
    const prior = context.sequenceNumber;
    const terminalEvent = ["response.completed", "response.incomplete", "response.failed"].includes(event.type);
    if (!Number.isSafeInteger(sequence) || sequence < 0
      || (Number.isSafeInteger(prior) && sequence <= prior)
      || (!terminalEvent && sequence === Number.MAX_SAFE_INTEGER)) {
      fail("reasoning_protocol_error");
    }
  }
  observeResponseContext(context, event);
}

function semanticJsonEqual(left, right, state = { work: 0 }, depth = 0) {
  if (++state.work > MAX_JSON_COMPARE_WORK || depth > MAX_JSON_COMPARE_DEPTH) return false;
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right || typeof left !== "object") return false;
  if (utilTypes.isProxy(left) || utilTypes.isProxy(right)) return false;
  const leftArray = Array.isArray(left); const rightArray = Array.isArray(right);
  if (leftArray !== rightArray) return false;
  try {
    if (!leftArray) {
      const leftPrototype = Object.getPrototypeOf(left); const rightPrototype = Object.getPrototypeOf(right);
      if (![null, Object.prototype].includes(leftPrototype) || ![null, Object.prototype].includes(rightPrototype)) return false;
    }
    const leftKeys = Reflect.ownKeys(left); const rightKeys = Reflect.ownKeys(right);
    if (leftKeys.length !== rightKeys.length || state.work + leftKeys.length > MAX_JSON_COMPARE_WORK) return false;
    const rightKeySet = new Set(rightKeys);
    for (const key of leftKeys) {
      if (typeof key !== "string" || !rightKeySet.has(key)) return false;
      const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
      const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
      if (!leftDescriptor || !rightDescriptor || !("value" in leftDescriptor) || !("value" in rightDescriptor)
        || leftDescriptor.enumerable !== rightDescriptor.enumerable
        || !semanticJsonEqual(leftDescriptor.value, rightDescriptor.value, state, depth + 1)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class OpenAIResponsesAdapterError extends Error {
  constructor(code = "provider_response_malformed") {
    super(code);
    this.name = "OpenAIResponsesAdapterError";
    this.code = code;
  }
}

function fail(code) { throw new OpenAIResponsesAdapterError(code); }

function ownObject(value, code = "provider_response_malformed") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function responseModel(model) {
  if (model?.effectiveTransport !== "openai-responses") {
    throw new TypeError("transport mismatch");
  }
  if (typeof model.upstreamModel !== "string" || !model.upstreamModel) {
    throw new TypeError("Responses model requires an upstream model");
  }
  return model;
}

function responseReasoningModel(model) {
  return {
    ...model,
    finalReasoningShape:
      model.effectiveFinalReasoningShape ?? model.finalReasoningShape ?? model.declaredFinalReasoningShape,
  };
}

function forcedChoice(choice) {
  return choice !== undefined && choice !== "none" ? "auto" : choice;
}

function qwenGlmCompatibility(model) {
  return model.slug === "qwen-plan-responses/glm-5.2";
}

function mappedGlmChoice(choice, sourceTools, encodedTools) {
  if (!choice || typeof choice !== "object" || Array.isArray(choice) || !["function", "custom"].includes(choice.type) || typeof choice.name !== "string") return choice;
  const flattened = [];
  for (const tool of sourceTools || []) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) for (const child of tool.tools) flattened.push({ tool: child, namespace: tool.name });
    else flattened.push({ tool, namespace: undefined });
  }
  const index = flattened.findIndex(({ tool, namespace }) => {
    const kindMatches = choice.type === "custom" ? tool?.type === "custom" : tool?.type === "function";
    return kindMatches && tool.name === choice.name && namespace === choice.namespace;
  });
  if (index < 0 || typeof encodedTools?.[index]?.name !== "string") return choice;
  return { type: "function", name: encodedTools[index].name };
}

function glmMappedTools(sourceTools, encodedTools) {
  const flattened = [];
  for (const tool of sourceTools || []) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) flattened.push(...tool.tools);
    else flattened.push(tool);
  }
  return encodedTools.map((tool, index) => flattened[index]?.strict === true ? { ...tool, strict: true } : tool);
}

function applyResponsesProfile(model, payload, toolBuild) {
  const body = { ...ownObject(payload, "provider_request_malformed"), model: model.upstreamModel };
  delete body.client_metadata;
  // These are legacy Chat Completions controls.  The native Responses profiles
  // preserve the caller's nested `reasoning` object instead.
  delete body.thinking;
  delete body.think;
  delete body.reasoning_effort;

  if (Object.hasOwn(payload, "tools")) body.tools = toolBuild.tools;
  if (Object.hasOwn(payload, "tool_choice")) body.tool_choice = toolBuild.toolChoice;
  if (Array.isArray(payload.input)) body.input = toolBuild.input;

  if (["deepseek-thinking", "qwen-plan"].includes(model.requestProfile) && !qwenGlmCompatibility(model)) {
    body.tool_choice = forcedChoice(body.tool_choice);
  }
  if (model.requestProfile === "qwen-plan") {
    // Qwen Plan Responses retains no stored server-side state.  This is also
    // required for the diagnostic GLM compatibility route.
    body.store = false;
    // The GLM Responses canary accepted automatic reasoning but rejected every
    // explicit caller reasoning object.  Do not apply this narrow repair to
    // Qwen or resold DeepSeek models, where nested reasoning is meaningful.
    if (qwenGlmCompatibility(model)) delete body.reasoning;
  }
  return body;
}

export function providerHeaders(model, credential) {
  responseModel(model);
  const value = credential?.value ?? credential;
  if (typeof value !== "string" || !value) return { "Content-Type": "application/json", Accept: "application/json" };
  return { Authorization: `Bearer ${value}`, "Content-Type": "application/json", Accept: "application/json" };
}

export function buildOpenAIResponsesRequest({ model, payload, credential } = {}) {
  responseModel(model);
  const source = ownObject(payload, "provider_request_malformed");
  const encodedBuild = encodeToolDialect({
    tools: source.tools,
    toolChoice: source.tool_choice,
    // Tool lowering only applies to the structured Responses input array. A
    // string input is legal too and deliberately remains untouched.
    input: Array.isArray(source.input) ? source.input : undefined,
    profile: model.requestProfile,
  });
  // GLM keeps the Responses-functions mapping (custom/namespace/history still
  // need lowering and restoration) but unlike Qwen accepts required/named
  // choices. Rebuild only the public selection fields; the private mapping
  // state remains the one Task2 created for the encoded declarations.
  const toolBuild = qwenGlmCompatibility(model)
    ? Object.freeze({ ...encodedBuild, tools: glmMappedTools(source.tools, encodedBuild.tools), toolChoice: mappedGlmChoice(source.tool_choice, source.tools, encodedBuild.tools), forcedRequirement: undefined })
    : encodedBuild;
  const json = applyResponsesProfile(model, source, toolBuild);
  return Object.freeze({
    url: providerEndpoint(model.baseUrl, "responses"),
    headers: providerHeaders(model, credential),
    body: Buffer.from(JSON.stringify(json), "utf8"),
    json,
    toolBuild,
  });
}

function completedOutput(event) {
  if (event?.type !== "response.completed") return [];
  if (Array.isArray(event.response?.output)) return event.response.output;
  return Array.isArray(event.output) ? event.output : [];
}

// Task 2's mapping state identifies repeated call ids.  A provider can also
// lie by reusing the same item id under a new call id in a standalone completed
// response.  Reject it here before any item is restored or relayed, so no
// downstream continuation can treat two calls as one lifecycle.
function assertDistinctCompletedItemIds(event) {
  const ids = new Set();
  for (const item of completedOutput(event)) {
    if (item?.type !== "function_call") continue;
    if (typeof item.id !== "string" || !item.id || ids.has(item.id)) {
      throw new ToolDialectError("tool_mapping_error");
    }
    ids.add(item.id);
  }
}

export function restoreOpenAIResponsesEvent(event, toolBuild) {
  ownObject(event);
  assertDistinctCompletedItemIds(event);
  if (!toolBuild?.mapping) return event;
  return restoreToolEvent(event, toolBuild.mapping);
}

function dataLine(block) {
  const lines = block.split(/\r\n|\n|\r/);
  const indexes = [];
  const values = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("data:")) continue;
    indexes.push(index);
    values.push(lines[index].slice(5).replace(/^ /, ""));
  }
  if (!indexes.length) return undefined;
  // SSE delivers each `data:` line joined by LF, independent of the frame's
  // physical delimiter.  This parsing result is used only for inspection;
  // semantically unchanged events still write the original bytes below.
  return { lines, indexes, index: indexes[0], data: values.join("\n") };
}

// Byte framing is deliberately independent from JSON parsing. It accepts the
// legal LF/CRLF/CR blank-line combinations across arbitrary chunks and hands
// unmodified frames downstream as their original bytes.
class SseFramer {
  #chunks = []; #bytes = 0; #tail = ""; #limit; #deferred = false;
  constructor(limit = MAX_SSE_FRAME_BYTES) { this.#limit = limit; }
  push(chunk, emit) {
    let start = 0;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      // `\r\r` is either a CR-only blank line or the prefix of `\r\r\n`.
      // Hold the decision for one byte so the latter remains one frame.
      if (this.#deferred && chunk[offset] !== 0x0a) {
        this.#append(chunk.subarray(start, offset));
        emit(Buffer.concat(this.#chunks));
        this.#chunks = []; this.#bytes = 0; this.#tail = ""; this.#deferred = false; start = offset;
      }
      const next = (this.#tail + String.fromCharCode(chunk[offset])).slice(-4);
      const deferred = next.endsWith("\r\r");
      const boundary = !deferred && (next.endsWith("\n\n") || next.endsWith("\r\n\r\n") || next.endsWith("\n\r\n") || next.endsWith("\r\n\n") || next.endsWith("\r\r\n"));
      this.#tail = next;
      this.#deferred = deferred;
      if (!boundary) continue;
      this.#append(chunk.subarray(start, offset + 1));
      emit(Buffer.concat(this.#chunks));
      this.#chunks = []; this.#bytes = 0; this.#tail = ""; start = offset + 1;
    }
    if (start < chunk.length) this.#append(chunk.subarray(start));
  }
  #append(chunk) {
    this.#bytes += chunk.length;
    if (!Number.isSafeInteger(this.#bytes) || this.#bytes > this.#limit) fail("forced_tool_buffer_limit");
    this.#chunks.push(chunk);
  }
  finish(emit) {
    if (this.#deferred) {
      emit(Buffer.concat(this.#chunks));
      this.#chunks = []; this.#bytes = 0; this.#tail = ""; this.#deferred = false;
      return false;
    }
    return this.#bytes > 0;
  }
}

class ResponsesSseToolTransform extends Transform {
  #framer; #toolBuild; #work = 0; #forced; #events; #held = []; #context;
  #backpressured = false; #pendingCallback; #validated = false;
  #onForcedValidated;
  #outputQueue = []; #queuedBytes = 0;
  constructor(toolBuild, { signal, abort, limits, forcedBuffer, relayContext, onForcedValidated } = {}) {
    super(); this.#toolBuild = toolBuild;
    this.#context = relayContext;
    if (onForcedValidated !== undefined && typeof onForcedValidated !== "function") throw new TypeError("invalid forced validation callback");
    this.#onForcedValidated = onForcedValidated;
    const frameBytes = limits?.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
    if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0 || frameBytes > MAX_SSE_FRAME_BYTES) fail("forced_tool_buffer_limit");
    this.#framer = new SseFramer(frameBytes);
    if (toolBuild?.forcedRequirement) {
      this.#forced = forcedBuffer ?? createForcedToolBuffer({ build: toolBuild, signal, abort });
      // A forced relay must validate the full lifecycle before a single byte
      // can commit.  Ordinary relays deliberately retain no prior events.
      this.#events = [];
    }
  }
  _transform(chunk, _encoding, callback) {
    try {
      this.#framer.push(Buffer.from(chunk), (frame) => this.#rewrite(frame));
      // Do not acknowledge more upstream input while our readable side has
      // reached its high-water mark.  This leaves at most the current framed
      // chunk in memory; unlike the former event array, it never retains the
      // history of an ordinary relay.
      if (this.#backpressured || this.#outputQueue.length) {
        this.#pendingCallback = callback;
      }
      else callback();
    } catch (error) { callback(error); }
  }
  _read(size) {
    this.#context.readWakeups += 1;
    if (this.#backpressured) this.#backpressured = false;
    this.#drainOutput();
    const callback = !this.#backpressured && !this.#outputQueue.length ? this.#pendingCallback : undefined;
    if (callback) this.#pendingCallback = undefined;
    callback?.();
    super._read(size);
  }
  _flush(callback) {
    try {
      if (this.#framer.finish((frame) => this.#rewrite(frame))) fail("upstream_stream_truncated");
      if (this.#forced && !this.#validated) {
        if (this.#forced.state.aborted || !this.#finishForced()) { this.#held.length = 0; callback(); return; }
      }
      this.#release();
      callback();
    } catch (error) { callback(error); }
  }
  #output(chunk) {
    if (this.#forced && !this.#validated) {
      this.#held.push(chunk);
      return;
    }
    this.#enqueueOutput(chunk);
  }
  #release() {
    if (!this.#forced || !this.#validated) return;
    // `createForcedToolBuffer` has already bounded the raw upstream lifetime
    // at exactly 8 MiB.  Release the held fragments in source order instead of
    // concatenating them, which keeps the peak bounded and preserves framing.
    for (const chunk of this.#held.splice(0)) {
      this.#enqueueOutput(chunk);
    }
  }
  #enqueueOutput(chunk) {
    this.#queuedBytes += chunk.length;
    if (!Number.isSafeInteger(this.#queuedBytes) || this.#queuedBytes > MAX_SSE_FRAME_BYTES) fail("forced_tool_buffer_limit");
    this.#outputQueue.push(chunk);
    this.#drainOutput();
  }
  #drainOutput() {
    while (!this.#backpressured && this.#outputQueue.length) {
      const chunk = this.#outputQueue.shift();
      this.#queuedBytes -= chunk.length;
      this.#context.relayedBytes += chunk.length;
      if (!this.push(chunk)) this.#backpressured = true;
    }
  }
  #finishForced() {
    if (!this.#forced || this.#validated) return this.#validated;
    const validated = this.#forced.finish(this.#events) === true;
    if (validated) this.#onForcedValidated?.();
    this.#validated = validated;
    return this.#validated;
  }
  #rewrite(raw) {
    if (++this.#work > MAX_SSE_WORK) fail("reasoning_protocol_error");
    this.#forced?.push(raw);
    const data = dataLine(raw.toString("utf8"));
    if (!data || !data.data || data.data === "[DONE]") {
      // Forced turns release exactly once, after their terminal validation.
      // Heartbeats/comments are valid SSE but cannot open the relay early.
      if (data?.data === "[DONE]" && this.#forced) {
        if (this.#finishForced()) this.#release();
        else this.#held.length = 0;
      }
      this.#output(raw);
      return;
    }
    let event;
    try { event = JSON.parse(data.data); } catch { fail("provider_response_malformed"); }
    this.#events?.push(event);
    const usage = event.usage ?? event.response?.usage;
    if (usage && typeof usage === "object") this.#forced?.observeUsage(usage);
    const restored = restoreOpenAIResponsesEvent(event, this.#toolBuild);
    // Task2 intentionally withholds custom argument deltas until the final
    // exact input is known. A suppressed event is a suppressed frame; JSON
    // stringifying it would manufacture the invalid `data: undefined` event.
    if (restored === undefined) return;
    if (restored === event || semanticJsonEqual(restored, event)) { this.#output(raw); return; }
    const lines = [...data.lines];
    lines[data.index] = `data: ${JSON.stringify(restored)}`;
    for (const index of data.indexes.slice(1)) lines[index] = "";
    this.#output(Buffer.from(`${lines.join("\n")}\n\n`, "utf8"));
  }
}

class ResponsesSseContextTransform extends Transform {
  #framer; #context;
  constructor(context) { super(); this.#context = context; this.#framer = new SseFramer(); }
  _transform(chunk, _encoding, callback) {
    try {
      this.#framer.push(Buffer.from(chunk), (raw) => this.#observe(raw));
      callback();
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    try {
      if (this.#framer.finish((raw) => this.#observe(raw))) fail("upstream_stream_truncated");
      if (this.#context.terminalSeen && !this.#context.doneSeen) {
        this.#context.doneSeen = true;
        this.push(Buffer.from("data: [DONE]\n\n", "utf8"));
      }
      callback();
    }
    catch (error) { callback(error); }
  }
  #observe(raw) {
    const data = dataLine(raw.toString("utf8"));
    if (data?.data === "[DONE]") this.#context.doneSeen = true;
    else if (data?.data) {
      let event; try { event = JSON.parse(data.data); } catch { fail("provider_response_malformed"); }
      commitResponseContext(this.#context, event);
    }
    this.push(raw);
  }
}

class ResponsesJsonTransform extends Transform {
  #chunks = []; #bytes = 0;
  #model; #toolBuild; #forced; #context; #onForcedValidated;
  constructor(model, toolBuild, { forcedBuffer, signal, abort, relayContext, onForcedValidated } = {}) {
    super(); this.#model = model; this.#toolBuild = toolBuild; this.#context = relayContext;
    if (onForcedValidated !== undefined && typeof onForcedValidated !== "function") throw new TypeError("invalid forced validation callback");
    this.#onForcedValidated = onForcedValidated;
    if (toolBuild?.forcedRequirement) this.#forced = forcedBuffer ?? createForcedToolBuffer({ build: toolBuild, signal, abort });
  }
  _transform(chunk, _encoding, callback) {
    const copy = Buffer.from(chunk); this.#bytes += copy.length;
    if (!Number.isSafeInteger(this.#bytes) || this.#bytes > MAX_JSON_BYTES) { callback(new OpenAIResponsesAdapterError("forced_tool_buffer_limit")); return; }
    try {
      this.#forced?.push(copy);
      this.#chunks.push(copy);
      callback();
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    try {
      const original = Buffer.concat(this.#chunks);
      let json;
      try { json = JSON.parse(original.toString("utf8")); } catch { fail("provider_response_malformed"); }
      // A JSON terminal is not committed merely because it parsed: forced
      // validation still has to succeed before this context suppresses the
      // safe pre-relay error response.
      const usage = json.usage ?? json.response?.usage;
      if (usage && typeof usage === "object") this.#forced?.observeUsage(usage);
      // A single JSON response is the complete forced lifecycle.  Validate it
      // before creating the transformed output, so validation failure writes
      // exactly zero provider bytes to the caller.
      if (this.#forced) {
        if (!this.#forced.finish([json])) { callback(); return; }
        this.#onForcedValidated?.();
      }
      json = restoreOpenAIResponsesEvent(json, this.#toolBuild);
      json = normalizeReasoningResponse(json, responseReasoningModel(this.#model));
      commitResponseContext(this.#context, json);
      const output = Buffer.from(JSON.stringify(json), "utf8");
      this.#context.relayedBytes += output.length;
      this.push(output);
      callback();
    } catch (error) { callback(error); }
  }
}

export function adaptOpenAIResponses({ model, upstream, requestContext = {} } = {}) {
  if (model?.effectiveTransport === "native-openai") {
    // Native events already carry the exact OpenAI contract.  Attaching even a
    // pass-through transform risks byte changes and violates the transport
    // boundary, so return the upstream object untouched.
    return Object.freeze({ upstream, transforms: [] });
  }
  responseModel(model);
  const relayContext = requestContext.relayContext ?? createResponsesRelayContext();
  const contentType = String(upstream?.headers?.get?.("content-type") || "").toLowerCase();
  const toolBuild = requestContext.toolBuild;
  if (contentType.includes("application/json")) {
    return Object.freeze({
      upstream,
      relayContext,
      transforms: [new ResponsesJsonTransform(model, toolBuild, { ...requestContext, relayContext })],
    });
  }
  const reasoning = reasoningTransformForModel(responseReasoningModel(model), {
    responseId: requestContext.responseId,
    signal: requestContext.signal,
  });
  const reasoningDuplex = Duplex.fromWeb(reasoning);
  // Node 22's Web-stream adapter has a writev rejection bug: when a preceding
  // forced buffer releases several held frames and this stage rejects one,
  // its internal callback treats the single Error as an array (`error.filter`)
  // and loses the trusted protocol error in an unhandled rejection. Disable
  // only that batching hook; ordinary `_write` preserves the same ordered
  // Web TransformStream contract and lets pipeline reach the safe boundary.
  if (toolBuild?.forcedRequirement) reasoningDuplex._writev = null;
  return Object.freeze({
    upstream,
    relayContext,
    transforms: [new ResponsesSseToolTransform(toolBuild, { ...requestContext, relayContext }), reasoningDuplex, new ResponsesSseContextTransform(relayContext)],
  });
}
