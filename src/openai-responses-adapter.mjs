import { Duplex, Transform } from "node:stream";

import { providerEndpoint } from "./provider-endpoint.mjs";
import { reasoningTransformForModel, normalizeReasoningResponse } from "./reasoning-summary-compat.mjs";
import { createForcedToolBuffer, encodeToolDialect, restoreToolEvent, ToolDialectError } from "./tool-dialect.mjs";

const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_WORK = 65_536;

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
  if (typeof value !== "string" || !value) return { Accept: "application/json" };
  return { Authorization: `Bearer ${value}`, Accept: "application/json" };
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
    ? Object.freeze({ ...encodedBuild, toolChoice: source.tool_choice, forcedRequirement: undefined })
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
  const index = lines.findIndex((line) => line.startsWith("data:"));
  if (index === -1) return undefined;
  const data = lines[index].slice(5).trimStart();
  return { lines, index, data };
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
  #framer; #toolBuild; #work = 0; #forced; #events = []; #held = [];
  constructor(toolBuild, { signal, abort, limits } = {}) {
    super(); this.#toolBuild = toolBuild;
    const frameBytes = limits?.maxFrameBytes ?? MAX_SSE_FRAME_BYTES;
    if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0 || frameBytes > MAX_SSE_FRAME_BYTES) fail("forced_tool_buffer_limit");
    this.#framer = new SseFramer(frameBytes);
    if (toolBuild?.forcedRequirement) {
      this.#forced = createForcedToolBuffer({ build: toolBuild, signal, abort });
    }
  }
  _transform(chunk, _encoding, callback) {
    try {
      this.#framer.push(Buffer.from(chunk), (frame) => this.#rewrite(frame));
      callback();
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    try {
      if (this.#framer.finish((frame) => this.#rewrite(frame))) fail("upstream_stream_truncated");
      if (this.#forced?.state.aborted === false) this.#forced.finish(this.#events);
      this.#release();
      callback();
    } catch (error) { callback(error); }
  }
  #output(chunk) {
    if (this.#forced) this.#held.push(chunk);
    else this.push(chunk);
  }
  #release() { if (this.#forced) for (const chunk of this.#held.splice(0)) this.push(chunk); }
  #rewrite(raw) {
    if (++this.#work > MAX_SSE_WORK) fail("reasoning_protocol_error");
    this.#forced?.push(raw);
    const data = dataLine(raw.toString("utf8"));
    if (!data || !data.data || data.data === "[DONE]") {
      // Forced turns release exactly once, after their terminal validation.
      // Heartbeats/comments are valid SSE but cannot open the relay early.
      if (data?.data === "[DONE]" && this.#forced) {
        this.#forced.finish(this.#events);
        this.#release();
      }
      this.#output(raw);
      return;
    }
    let event;
    try { event = JSON.parse(data.data); } catch { fail("provider_response_malformed"); }
    this.#events.push(event);
    const usage = event.usage ?? event.response?.usage;
    if (usage && typeof usage === "object") this.#forced?.observeUsage(usage);
    const restored = restoreOpenAIResponsesEvent(event, this.#toolBuild);
    // Task2 intentionally withholds custom argument deltas until the final
    // exact input is known. A suppressed event is a suppressed frame; JSON
    // stringifying it would manufacture the invalid `data: undefined` event.
    if (restored === undefined) return;
    if (restored === event || JSON.stringify(restored) === data.data) { this.#output(raw); return; }
    const lines = [...data.lines];
    lines[data.index] = `data: ${JSON.stringify(restored)}`;
    this.#output(Buffer.from(`${lines.join("\n")}\n\n`, "utf8"));
  }
}

class ResponsesJsonTransform extends Transform {
  #chunks = []; #bytes = 0;
  #model;
  #toolBuild;
  constructor(model, toolBuild) { super(); this.#model = model; this.#toolBuild = toolBuild; }
  _transform(chunk, _encoding, callback) {
    const copy = Buffer.from(chunk); this.#bytes += copy.length;
    if (!Number.isSafeInteger(this.#bytes) || this.#bytes > MAX_JSON_BYTES) { callback(new OpenAIResponsesAdapterError("forced_tool_buffer_limit")); return; }
    this.#chunks.push(copy); callback();
  }
  _flush(callback) {
    try {
      const original = Buffer.concat(this.#chunks);
      let json;
      try { json = JSON.parse(original.toString("utf8")); } catch { fail("provider_response_malformed"); }
      json = restoreOpenAIResponsesEvent(json, this.#toolBuild);
      json = normalizeReasoningResponse(json, responseReasoningModel(this.#model));
      this.push(Buffer.from(JSON.stringify(json), "utf8"));
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
  const contentType = String(upstream?.headers?.get?.("content-type") || "").toLowerCase();
  const toolBuild = requestContext.toolBuild;
  if (contentType.includes("application/json")) {
    return Object.freeze({ upstream, transforms: [new ResponsesJsonTransform(model, toolBuild)] });
  }
  const reasoning = reasoningTransformForModel(responseReasoningModel(model), {
    responseId: requestContext.responseId,
    signal: requestContext.signal,
  });
  return Object.freeze({
    upstream,
    transforms: [new ResponsesSseToolTransform(toolBuild, requestContext), Duplex.fromWeb(reasoning)],
  });
}
