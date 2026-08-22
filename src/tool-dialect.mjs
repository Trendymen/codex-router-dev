import { createHash } from "node:crypto";

import { namespaceToolEntries } from "./namespace-relay.mjs";
import { providerToolSchema } from "./tool-schema-root.mjs";

const UPSTREAM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FORCED_MAX_BYTES = 8 * 1024 * 1024;
const FORCED_MAX_MS = 30_000;
const MAPPING_STATE = new WeakMap();
const MAX_GRAPH_DEPTH = 24;
const MAX_GRAPH_NODES = 512;

export class ToolDialectError extends Error {
  constructor(code = "tool_mapping_error") {
    super(code);
    this.name = "ToolDialectError";
    this.code = code;
  }
}

function fail(code = "tool_mapping_error") {
  throw new ToolDialectError(code);
}

function base32(buffer) {
  let output = "";
  let value = 0;
  let bits = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function sanitize(value) {
  const sanitized = String(value).replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized || "tool";
}

export function encodedToolName(kind, original) {
  const prefix = sanitize(original).slice(0, 40);
  const hash = base32(createHash("sha256").update(`${kind}\0${original}`, "utf8").digest()).slice(0, 16);
  return `cr_${prefix}_${hash}`;
}

function profileUsesFunctions(profile) {
  if (typeof profile === "string") return !/^(glm|glm-thinking)$/i.test(profile);
  if (!profile || typeof profile !== "object") return true;
  return !/^(glm|zai)$/i.test(String(profile.provider ?? profile.id ?? profile.requestProfile ?? ""));
}

function stateFor(mapping) {
  const state = MAPPING_STATE.get(mapping);
  if (!state) fail();
  return state;
}

function callKey(kind, namespace, name) {
  return `${kind}\0${namespace ?? ""}\0${name}`;
}

function functionParts(tool) {
  const nested = tool?.function && typeof tool.function === "object" ? tool.function : tool;
  if (!nested || typeof nested.name !== "string" || !nested.name) fail();
  return { nested, name: nested.name, parameters: nested.parameters ?? nested.inputSchema };
}

function declarationEntries(tools) {
  if (!Array.isArray(tools)) return [];
  const entries = [];
  for (const tool of tools) {
    if (tool?.type === "namespace") {
      if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) fail();
      for (const { namespace, tool: child } of namespaceToolEntries([tool])) {
        const parts = functionParts(child);
        entries.push({ kind: "namespace", namespace, tool: child, ...parts });
      }
      continue;
    }
    if (tool?.type === "custom") {
      if (typeof tool.name !== "string" || !tool.name) fail();
      entries.push({ kind: "custom", namespace: undefined, tool, name: tool.name, nested: tool });
      continue;
    }
    const parts = functionParts(tool);
    entries.push({ kind: "function", namespace: undefined, tool, ...parts });
  }
  return entries;
}

function outputTool(entry, encodedName, usesFunctions) {
  if (entry.kind === "custom") {
    return {
      type: "function",
      name: encodedName,
      ...(typeof entry.tool.description === "string" ? { description: entry.tool.description } : {}),
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
    };
  }
  const source = entry.nested;
  const parameters = entry.parameters === undefined ? undefined : providerToolSchema(entry.parameters);
  const result = {
    ...source,
    type: "function",
    name: encodedName,
    ...(parameters === undefined ? {} : { parameters }),
  };
  delete result.inputSchema;
  if (usesFunctions) delete result.strict;
  return result;
}

function originalName(entry) {
  return entry.kind === "namespace" ? `${entry.namespace}__${entry.name}` : entry.name;
}

function exactInput(argumentsText) {
  if (typeof argumentsText !== "string") fail();
  let value;
  try {
    value = JSON.parse(argumentsText);
  } catch {
    fail();
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.input !== "string") fail();
  return value.input;
}

// The local strict validator intentionally supports only this bounded JSON
// Schema subset. Profiles that need another keyword fail closed at build time.
const STRICT_KEYS = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items"]);
function assertStrictSchema(schema, seen = new WeakSet(), state = { nodes: 0 }, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > MAX_GRAPH_DEPTH || state.nodes++ >= MAX_GRAPH_NODES || seen.has(schema)) fail();
  seen.add(schema);
  let keys;
  try { keys = Object.keys(schema); } catch { fail(); }
  if (keys.some((key) => !STRICT_KEYS.has(key))) fail();
  if (schema.type !== undefined && typeof schema.type !== "string") fail();
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) fail();
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail();
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") fail();
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) fail();
    for (const value of Object.values(schema.properties)) assertStrictSchema(value, seen, state, depth + 1);
  }
  if (schema.items !== undefined) assertStrictSchema(schema.items, seen, state, depth + 1);
}

function parseArguments(argumentsText) {
  if (typeof argumentsText !== "string") fail();
  try {
    return JSON.parse(argumentsText);
  } catch {
    fail();
  }
}

function schemaAccepts(value, schema) {
  if (!schema || typeof schema !== "object") return true;
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const compatible = types.some((type) => type === actual || (type === "number" && Number.isInteger(value)) || (type === "integer" && Number.isInteger(value)));
    if (!compatible) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => !Object.hasOwn(value, key))) return false;
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) return false;
      } else if (!schemaAccepts(child, properties[key])) return false;
    }
  }
  if (Array.isArray(value) && schema.items && !value.every((entry) => schemaAccepts(entry, schema.items))) return false;
  return true;
}

function mappingForCall(mapping, item) {
  mapping = privateState(mapping);
  if (!item || typeof item !== "object" || typeof item.name !== "string") fail();
  const isCustom = item.type === "custom_tool_call" || item.type === "custom_tool_call_output";
  const kind = isCustom ? "custom" : item.namespace === undefined ? "function" : "namespace";
  const key = callKey(kind, item.namespace, item.name);
  return mapping.byOriginal.get(key) ?? (kind === "function" ? mapping.byOriginal.get(callKey("custom", undefined, item.name)) : undefined);
}

function privateState(mapping) {
  return MAPPING_STATE.get(mapping) ?? mapping;
}

function registerHistory(mapping, item) {
  mapping = privateState(mapping);
  if (typeof item.call_id !== "string" || !item.call_id) fail();
  if (mapping.callIds.has(item.call_id)) fail();
  mapping.callIds.set(item.call_id, mappingForCall(mapping, item));
}

function lowerInputItem(item, mapping) {
  mapping = privateState(mapping);
  if (!item || typeof item !== "object") return item;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    registerHistory(mapping, item);
    const entry = mapping.callIds.get(item.call_id);
    if (entry.kind === "custom") {
      const input = item.type === "custom_tool_call" ? item.input : exactInput(item.arguments);
      if (typeof input !== "string") fail();
      const { namespace: _namespace, input: _input, ...rest } = item;
      return { ...rest, type: "function_call", name: entry.encodedName, arguments: JSON.stringify({ input }) };
    }
    const { namespace: _namespace, ...rest } = item;
    return { ...rest, name: entry.encodedName };
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    if (typeof item.call_id !== "string" || !mapping.callIds.has(item.call_id)) fail();
    const entry = mapping.callIds.get(item.call_id);
    if (item.type === "custom_tool_call_output" && entry.kind !== "custom") fail();
    return item.type === "custom_tool_call_output" ? { ...item, type: "function_call_output" } : item;
  }
  return item;
}

function choiceFor(toolChoice, mapping, usesFunctions) {
  mapping = privateState(mapping);
  if (!usesFunctions || toolChoice === undefined) return { toolChoice, forcedRequirement: undefined };
  if (toolChoice === "auto" || toolChoice === "none") return { toolChoice, forcedRequirement: undefined };
  if (toolChoice === "required") return { toolChoice: "auto", forcedRequirement: { type: "any" } };
  if (toolChoice && typeof toolChoice === "object" && typeof toolChoice.name === "string") {
    const kind = toolChoice.type === "custom" ? "custom" : toolChoice.namespace === undefined ? "function" : "namespace";
    const entry = mapping.byOriginal.get(callKey(kind, toolChoice.namespace, toolChoice.name));
    if (!entry) fail();
    return { toolChoice: "auto", forcedRequirement: { type: "named", name: toolChoice.name, kind, namespace: toolChoice.namespace } };
  }
  fail();
}

export function encodeToolDialect({ tools, toolChoice, input, profile } = {}) {
  const usesFunctions = profileUsesFunctions(profile);
  if (!usesFunctions) {
    const mapping = Object.freeze({ entries: Object.freeze([]) });
    MAPPING_STATE.set(mapping, { native: true });
    return Object.freeze({ tools, toolChoice, input, mapping, forcedRequirement: undefined, strictValidators: Object.freeze([]) });
  }
  const state = { byEncodedName: new Map(), byOriginal: new Map(), callIds: new Map(), returnedCallIds: new Map(), itemCalls: new Map() };
  const entries = declarationEntries(tools);
  const names = new Set();
  const builtTools = entries.map((entry) => {
    const original = originalName(entry);
    const mayPreserve = entry.kind === "function" && UPSTREAM_NAME.test(entry.name);
    const encodedName = mayPreserve ? entry.name : encodedToolName(entry.kind, original);
    if (names.has(encodedName) || state.byEncodedName.has(encodedName)) fail();
    names.add(encodedName);
    const record = Object.freeze({ ...entry, encodedName });
    state.byEncodedName.set(encodedName, record);
    state.byOriginal.set(callKey(entry.kind, entry.namespace, entry.name), record);
    return outputTool(entry, encodedName, usesFunctions);
  });
  const loweredInput = Array.isArray(input) ? input.map((item) => lowerInputItem(item, state)) : input;
  const selected = choiceFor(toolChoice, state, usesFunctions);
  const strictValidators = new Map();
  if (usesFunctions) {
    for (const entry of state.byEncodedName.values()) {
      if (entry.kind === "function" && entry.nested.strict === true) {
        assertStrictSchema(entry.parameters);
        const schema = providerToolSchema(entry.parameters);
        assertStrictSchema(schema);
        strictValidators.set(entry.encodedName, schema);
      }
    }
  }
  state.strictValidators = strictValidators;
  const mapping = Object.freeze({ entries: Object.freeze([...state.byEncodedName.values()].map((entry) => Object.freeze({ kind: entry.kind, name: entry.name, namespace: entry.namespace, encodedName: entry.encodedName }))) });
  MAPPING_STATE.set(mapping, state);
  return Object.freeze({ tools: builtTools, toolChoice: selected.toolChoice, input: loweredInput, mapping, forcedRequirement: selected.forcedRequirement, strictValidators: Object.freeze([...strictValidators.keys()]) });
}

function restoreItem(item, mapping) {
  mapping = privateState(mapping);
  if (!item || typeof item !== "object" || item.type !== "function_call") return item;
  if (typeof item.name !== "string" || typeof item.call_id !== "string" || !item.call_id) fail();
  const entry = mapping.byEncodedName.get(item.name);
  if (!entry || mapping.callIds.has(item.call_id)) fail();
  const prior = mapping.returnedCallIds.get(item.call_id);
  if (prior && (prior.entry !== entry || prior.itemId !== item.id || item.id === undefined)) fail();
  if (entry.kind === "custom") {
    const input = item.arguments === "" ? undefined : exactInput(item.arguments);
    const { arguments: _arguments, ...rest } = item;
    if (!prior) mapping.returnedCallIds.set(item.call_id, { entry, itemId: item.id });
    return { ...rest, type: "custom_tool_call", name: entry.name, ...(input === undefined ? {} : { input }) };
  }
  const strictSchema = mapping.strictValidators?.get(item.name);
  if (strictSchema && item.arguments !== "" && !schemaAccepts(parseArguments(item.arguments), strictSchema)) fail();
  if (!prior) mapping.returnedCallIds.set(item.call_id, { entry, itemId: item.id });
  return entry.kind === "namespace" ? { ...item, name: entry.name, namespace: entry.namespace } : { ...item, name: entry.name };
}

function restoreOutput(item, mapping) {
  mapping = privateState(mapping);
  if (!item || typeof item !== "object" || !["function_call_output", "custom_tool_call_output"].includes(item.type)) return item;
  if (typeof item.call_id !== "string" || !mapping.callIds.has(item.call_id)) fail();
  const entry = mapping.callIds.get(item.call_id);
  if (entry.kind === "custom") return { ...item, type: "custom_tool_call_output" };
  if (item.type === "custom_tool_call_output") fail();
  return item;
}

function restoreValue(value, mapping) {
  if (!value || typeof value !== "object") return value;
  const item = restoreOutput(restoreItem(value, mapping), mapping);
  if (Array.isArray(item.output)) return { ...item, output: item.output.map((entry) => restoreValue(entry, mapping)) };
  if (Array.isArray(item.response?.output)) return { ...item, response: { ...item.response, output: item.response.output.map((entry) => restoreValue(entry, mapping)) } };
  if (item.item) return { ...item, item: restoreValue(item.item, mapping) };
  return item;
}

export function restoreToolEvent(event, mapping) {
  const state = stateFor(mapping);
  if (state.native) return event;
  if (event?.type === "response.function_call_arguments.delta" || event?.type === "response.function_call_arguments.done") {
    const tracked = state.itemCalls.get(event.item_id);
    if (!tracked) fail();
    if (event.type.endsWith("done")) {
      tracked.finalArguments = event.arguments;
      const strictSchema = state.strictValidators?.get(tracked.entry.encodedName);
      if (strictSchema && !schemaAccepts(parseArguments(event.arguments), strictSchema)) fail();
    }
    if (tracked.entry.kind !== "custom") return event;
    if (event.type.endsWith("delta")) return { ...event, type: "response.custom_tool_call_input.delta" };
    return { type: "response.custom_tool_call_input.done", item_id: event.item_id, input: exactInput(event.arguments) };
  }
  if (event?.type === "response.output_item.done" && event.item?.type === "function_call") {
    const tracked = state.itemCalls.get(event.item.id);
    if (tracked?.finalArguments !== undefined) event = { ...event, item: { ...event.item, arguments: tracked.finalArguments } };
  }
  const restored = restoreValue(event, mapping);
  const item = event?.item;
  if (item?.type === "function_call" && typeof item.id === "string") {
    const entry = state.byEncodedName.get(item.name);
    if (!entry) fail();
    const previous = state.itemCalls.get(item.id);
    if (previous && (previous.entry !== entry || previous.callId !== item.call_id)) fail();
    if (!previous) state.itemCalls.set(item.id, { entry, callId: item.call_id });
  }
  return restored;
}

function callsFrom(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) callsFrom(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  if (value.type === "function_call") found.push(value);
  if (value.item) callsFrom(value.item, found);
  if (Array.isArray(value.output)) for (const item of value.output) callsFrom(item, found);
  if (Array.isArray(value.response?.output)) for (const item of value.response.output) callsFrom(item, found);
  return found;
}

export function validateForcedToolResult(buffer, build) {
  if (!build?.forcedRequirement) return;
  if (!buffer || buffer.bytes > FORCED_MAX_BYTES) fail("forced_tool_buffer_limit");
  if (buffer.elapsedMs > FORCED_MAX_MS) fail("forced_tool_buffer_timeout");
  const calls = callsFrom(buffer.events);
  if (!calls.length) fail("required_tool_not_called");
  const state = stateFor(build.mapping);
  if (build.forcedRequirement.type === "named") {
    const matched = calls.some((call) => {
      const entry = state.byEncodedName.get(call.name);
      return entry?.name === build.forcedRequirement.name && entry.kind === build.forcedRequirement.kind;
    });
    if (!matched) fail("required_tool_mismatch");
  }
}

// Direct adapters keep a forced turn private until this request-local buffer
// proves it obeys the caller's choice. The counter and clock are injected so
// boundary tests (and future transports) never depend on wall-clock timing.
export function createForcedToolBuffer({
  build,
  abort = () => {},
  byteCounter = (chunk) => Buffer.byteLength(chunk),
  clock = () => Date.now(),
  signal,
  onUsage,
} = {}) {
  const readClock = () => {
    const value = clock();
    if (!Number.isFinite(value)) fail("forced_tool_buffer_timeout");
    if (value < lastClock) fail("forced_tool_buffer_timeout");
    lastClock = value;
    return value;
  };
  let lastClock = -Infinity;
  const startedAt = readClock();
  let bytes = 0;
  let terminal = false;
  let aborted = false;
  let usage;
  let listener;
  const cleanup = () => {
    if (listener) signal?.removeEventListener("abort", listener);
    listener = undefined;
  };
  const cancel = () => {
    if (terminal) return;
    terminal = true;
    aborted = true;
    cleanup();
    abort();
  };
  const deadline = () => {
    const now = readClock();
    if (now - startedAt <= FORCED_MAX_MS) return now;
    cancel();
    fail("forced_tool_buffer_timeout");
  };
  const abortFromCaller = () => {
    cancel();
  };
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else {
      listener = abortFromCaller;
      signal.addEventListener("abort", listener, { once: true });
    }
  }
  return {
    push(chunk) {
      if (terminal) return false;
      deadline();
      const counted = byteCounter(chunk);
      if (!Number.isSafeInteger(counted) || counted < 0 || bytes > Number.MAX_SAFE_INTEGER - counted) {
        cancel();
        fail("forced_tool_buffer_limit");
      }
      const nextBytes = bytes + counted;
      if (nextBytes > FORCED_MAX_BYTES) {
        cancel();
        fail("forced_tool_buffer_limit");
      }
      bytes = nextBytes;
      return true;
    },
    observeUsage(nextUsage) {
      if (terminal) return false;
      usage = nextUsage;
      return true;
    },
    finish(events) {
      if (terminal) return false;
      const now = deadline();
      try {
        validateForcedToolResult({ bytes, elapsedMs: now - startedAt, events }, build);
      } catch (error) {
        cancel();
        throw error;
      }
      terminal = true;
      cleanup();
      onUsage?.(usage);
      return true;
    },
    abortFromCaller,
    get state() {
      return { bytes, usage, aborted, relayedBytes: 0, retries: 0, failovers: 0 };
    },
  };
}

export const FORCED_TOOL_BUFFER_LIMIT_BYTES = FORCED_MAX_BYTES;
export const FORCED_TOOL_BUFFER_TIMEOUT_MS = FORCED_MAX_MS;
