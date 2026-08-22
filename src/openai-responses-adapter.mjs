import { Duplex, Transform } from "node:stream";

import { providerEndpoint } from "./provider-endpoint.mjs";
import { reasoningTransformForModel, normalizeReasoningResponse } from "./reasoning-summary-compat.mjs";
import { encodeToolDialect, restoreToolEvent, ToolDialectError } from "./tool-dialect.mjs";

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

  if (["deepseek-thinking", "qwen-plan"].includes(model.requestProfile)) {
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
  const toolBuild = encodeToolDialect({
    tools: source.tools,
    toolChoice: source.tool_choice,
    // Tool lowering only applies to the structured Responses input array. A
    // string input is legal too and deliberately remains untouched.
    input: Array.isArray(source.input) ? source.input : undefined,
    profile: model.requestProfile,
  });
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

class ResponsesSseToolTransform extends Transform {
  #buffer = "";
  #toolBuild;
  constructor(toolBuild) { super(); this.#toolBuild = toolBuild; }
  _transform(chunk, _encoding, callback) {
    this.#buffer += Buffer.from(chunk).toString("utf8");
    try {
      this.#drain(false);
      callback();
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    try {
      this.#drain(true);
      callback();
    } catch (error) { callback(error); }
  }
  #drain(flush) {
    const blocks = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = flush ? "" : blocks.pop() || "";
    for (const block of blocks) this.#rewrite(block);
    if (flush && this.#buffer) fail("provider_response_malformed");
  }
  #rewrite(block) {
    const data = dataLine(block);
    if (!data || !data.data || data.data === "[DONE]") {
      this.push(Buffer.from(`${block}\n\n`, "utf8"));
      return;
    }
    let event;
    try { event = JSON.parse(data.data); } catch { fail("provider_response_malformed"); }
    const restored = restoreOpenAIResponsesEvent(event, this.#toolBuild);
    const lines = [...data.lines];
    lines[data.index] = `data: ${JSON.stringify(restored)}`;
    this.push(Buffer.from(`${lines.join("\n")}\n\n`, "utf8"));
  }
}

class ResponsesJsonTransform extends Transform {
  #chunks = [];
  #model;
  #toolBuild;
  constructor(model, toolBuild) { super(); this.#model = model; this.#toolBuild = toolBuild; }
  _transform(chunk, _encoding, callback) { this.#chunks.push(Buffer.from(chunk)); callback(); }
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
    transforms: [new ResponsesSseToolTransform(toolBuild), Duplex.fromWeb(reasoning)],
  });
}
