import { createHash } from "node:crypto";

import { namespaceToolEntries } from "./namespace-relay.mjs";
import { providerToolSchema } from "./tool-schema-root.mjs";

const UPSTREAM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FORCED_MAX_BYTES = 8 * 1024 * 1024;
const FORCED_MAX_MS = 30_000;
const MAX_GRAPH_DEPTH = 24;
const MAX_GRAPH_NODES = 512;
const MAX_ARRAY_LENGTH = 512;
const MAPPING_STATE = new WeakMap();
const BUILD_STATE = new WeakMap();

export class ToolDialectError extends Error {
  constructor(code = "tool_mapping_error") {
    super(code);
    this.name = "ToolDialectError";
    this.code = code;
  }
}

function fail(code = "tool_mapping_error") { throw new ToolDialectError(code); }

function ownData(value, key, code = "tool_mapping_error") {
  if (!value || (typeof value !== "object" && typeof value !== "function")) fail(code);
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch { fail(code); }
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) fail(code);
  return descriptor.value;
}

// All caller/provider values enter through this bounded descriptor-only copy.
// It rejects accessors, reflection-trapping proxies, cycles and huge arrays.
function safeSnapshot(value, state = { nodes: 0 }, seen = new WeakSet(), depth = 0, code = "tool_mapping_error", finiteNumbers = true) {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
    if (finiteNumbers && typeof value === "number" && !Number.isFinite(value)) fail(code);
    return value;
  }
  if (!value || typeof value !== "object" || depth > MAX_GRAPH_DEPTH || state.nodes++ >= MAX_GRAPH_NODES || seen.has(value)) fail(code);
  seen.add(value);
  let keys; let descriptors;
  try { keys = Reflect.ownKeys(value); descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(code); }
  if (keys.length > MAX_GRAPH_NODES || keys.some((key) => typeof key !== "string")) fail(code);
  if (keys.some((key) => !Object.hasOwn(descriptors[key], "value"))) fail(code);
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) fail(code);
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor) continue;
      Object.defineProperty(copy, index, { value: safeSnapshot(descriptor.value, state, seen, depth + 1, code, finiteNumbers), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  }
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable) continue;
    Object.defineProperty(copy, key, { value: safeSnapshot(descriptor.value, state, seen, depth + 1, code, finiteNumbers), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

function privateUsageSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const copy = safeSnapshot(value);
  if (Object.keys(copy).length > 64) fail();
  return deepFreezeSnapshot(copy);
}

function deepFreezeSnapshot(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreezeSnapshot(item, seen);
  return Object.freeze(value);
}

function publicUsageCopy(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => publicUsageCopy(item));
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: publicUsageCopy(item), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}

function base32(buffer) {
  let output = ""; let value = 0; let bits = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function sanitize(value) { return String(value).replace(/[^A-Za-z0-9_-]/g, "_") || "tool"; }

export function encodedToolName(kind, original) {
  return `cr_${sanitize(original).slice(0, 40)}_${base32(createHash("sha256").update(`${kind}\0${original}`, "utf8").digest()).slice(0, 16)}`;
}

function profileUsesFunctions(profile) {
  if (typeof profile === "string") return !/^(glm|glm-thinking)$/i.test(profile);
  if (!profile || typeof profile !== "object") return true;
  const provider = profile.provider ?? profile.id ?? profile.requestProfile ?? "";
  if (typeof provider !== "string") fail();
  return !/^(glm|zai)$/i.test(provider);
}

function stateFor(mapping) { const state = MAPPING_STATE.get(mapping); if (!state) fail(); return state; }
function buildStateFor(build) { const state = BUILD_STATE.get(build); if (!state) fail(); return state; }
function callKey(kind, namespace, name) { return `${kind}\0${namespace ?? ""}\0${name}`; }

function functionParts(tool) {
  const nested = tool.function && typeof tool.function === "object" ? tool.function : tool;
  if (!nested || typeof nested.name !== "string" || !nested.name) fail();
  return { nested, name: nested.name, parameters: nested.parameters ?? nested.inputSchema };
}

function declarationEntries(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) fail();
  const entries = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") fail();
    if (tool.type === "namespace") {
      if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) fail();
      for (const { namespace, tool: child } of namespaceToolEntries([tool])) entries.push({ kind: "namespace", namespace, tool: child, ...functionParts(child) });
    } else if (tool.type === "custom") {
      if (typeof tool.name !== "string" || !tool.name) fail();
      entries.push({ kind: "custom", namespace: undefined, tool, name: tool.name, nested: tool });
    } else entries.push({ kind: "function", namespace: undefined, tool, ...functionParts(tool) });
  }
  return entries;
}

function outputTool(entry, encodedName) {
  if (entry.kind === "custom") {
    return {
      type: "function", name: encodedName,
      ...(typeof entry.tool.description === "string" ? { description: entry.tool.description } : {}),
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    };
  }
  const parameters = entry.parameters === undefined ? undefined : providerToolSchema(entry.parameters);
  const result = { ...entry.nested, type: "function", name: encodedName, ...(parameters === undefined ? {} : { parameters }) };
  delete result.inputSchema;
  delete result.strict;
  return result;
}

function originalName(entry) { return entry.kind === "namespace" ? `${entry.namespace}__${entry.name}` : entry.name; }

function exactInput(argumentsText) {
  if (typeof argumentsText !== "string") fail();
  let value; try { value = JSON.parse(argumentsText); } catch { fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.input !== "string") fail();
  return value.input;
}

const STRICT_KEYS = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items"]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function assertJsonLiteral(value, state = { nodes: 0 }, depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return; }
  if (!value || typeof value !== "object" || depth > MAX_GRAPH_DEPTH || state.nodes++ >= MAX_GRAPH_NODES) fail();
  if (Array.isArray(value)) { for (const item of value) assertJsonLiteral(item, state, depth + 1); return; }
  for (const item of Object.values(value)) assertJsonLiteral(item, state, depth + 1);
}

function assertStrictSchema(schema, seen = new WeakSet(), state = { nodes: 0 }, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > MAX_GRAPH_DEPTH || state.nodes++ >= MAX_GRAPH_NODES || seen.has(schema)) fail();
  seen.add(schema);
  const keys = Object.keys(schema);
  if (keys.some((key) => !STRICT_KEYS.has(key))) fail();
  if (schema.type !== undefined && (typeof schema.type !== "string" || !JSON_TYPES.has(schema.type))) fail();
  if (schema.enum !== undefined) { if (!Array.isArray(schema.enum) || !schema.enum.length) fail(); for (const value of schema.enum) assertJsonLiteral(value); }
  if (schema.const !== undefined) assertJsonLiteral(schema.const);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail();
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") fail();
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) fail();
    for (const value of Object.values(schema.properties)) assertStrictSchema(value, seen, state, depth + 1);
  }
  if (schema.items !== undefined) assertStrictSchema(schema.items, seen, state, depth + 1);
}

function parseArguments(argumentsText) { if (typeof argumentsText !== "string") fail(); try { return JSON.parse(argumentsText); } catch { fail(); } }

function jsonEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  const leftKeys = Object.keys(left); const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

function schemaAccepts(value, schema) {
  if (Object.hasOwn(schema, "const") && !jsonEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonEqual(entry, value))) return false;
  if (schema.type !== undefined) {
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (schema.type !== actual && !(schema.type === "integer" && Number.isInteger(value))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? Object.create(null);
    if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) { if (schema.additionalProperties === false) return false; }
      else if (!schemaAccepts(child, properties[key])) return false;
    }
  }
  return !Array.isArray(value) || schema.items === undefined || value.every((item) => schemaAccepts(item, schema.items));
}

function mappingForCall(state, item) {
  if (!item || typeof item !== "object" || typeof item.name !== "string") fail();
  const kind = item.type === "custom_tool_call" || item.type === "custom_tool_call_output" ? "custom" : item.namespace === undefined ? "function" : "namespace";
  return state.byOriginal.get(callKey(kind, item.namespace, item.name));
}

function registerHistory(state, item) {
  if (typeof item.call_id !== "string" || !item.call_id || state.callIds.has(item.call_id)) fail();
  const entry = mappingForCall(state, item);
  if (!entry) fail();
  state.callIds.set(item.call_id, entry);
}

function lowerInputItem(item, state) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    registerHistory(state, item);
    const entry = state.callIds.get(item.call_id);
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
    if (typeof item.call_id !== "string" || !state.callIds.has(item.call_id)) fail();
    const entry = state.callIds.get(item.call_id);
    if ((item.type === "custom_tool_call_output") !== (entry.kind === "custom")) fail();
    return entry.kind === "custom" ? { ...item, type: "function_call_output" } : item;
  }
  return item;
}

function choiceFor(choice, state, usesFunctions) {
  if (!usesFunctions || choice === undefined) return { toolChoice: choice, forcedRequirement: undefined };
  if (choice === "auto" || choice === "none") return { toolChoice: choice, forcedRequirement: undefined };
  if (choice === "required") return { toolChoice: "auto", forcedRequirement: Object.freeze({ type: "any" }) };
  if (!choice || typeof choice !== "object" || typeof choice.type !== "string" || typeof choice.name !== "string" || !choice.name) fail();
  let kind;
  if (choice.type === "custom" && choice.namespace === undefined) kind = "custom";
  else if (choice.type === "function") kind = choice.namespace === undefined ? "function" : "namespace";
  else fail();
  const entry = state.byOriginal.get(callKey(kind, choice.namespace, choice.name));
  if (!entry) fail();
  return { toolChoice: "auto", forcedRequirement: Object.freeze({ type: "named", kind, namespace: choice.namespace, name: choice.name }) };
}

export function encodeToolDialect(options = {}) {
  const request = safeSnapshot(options);
  if (typeof request.input === "string") request.input = [{ role: "user", content: request.input }];
  const usesFunctions = profileUsesFunctions(request.profile);
  if (!usesFunctions) {
    const mapping = Object.freeze({ entries: Object.freeze([]) });
    const build = Object.freeze({ tools: ownData(options, "tools"), toolChoice: ownData(options, "toolChoice"), input: ownData(options, "input"), mapping, forcedRequirement: undefined, strictValidators: Object.freeze([]) });
    MAPPING_STATE.set(mapping, { native: true }); BUILD_STATE.set(build, { native: true });
    return build;
  }
  const state = { byEncodedName: new Map(), byOriginal: new Map(), callIds: new Map(), returnedCallIds: new Map(), itemCalls: new Map(), strictValidators: new Map() };
  const names = new Set();
  const builtTools = declarationEntries(request.tools).map((entry) => {
    const encodedName = entry.kind === "function" && UPSTREAM_NAME.test(entry.name) ? entry.name : encodedToolName(entry.kind, originalName(entry));
    if (names.has(encodedName) || state.byEncodedName.has(encodedName)) fail();
    names.add(encodedName);
    const record = Object.freeze({ ...entry, encodedName });
    state.byEncodedName.set(encodedName, record); state.byOriginal.set(callKey(entry.kind, entry.namespace, entry.name), record);
    return outputTool(record, encodedName);
  });
  const loweredInput = request.input === undefined ? undefined : Array.isArray(request.input) ? request.input.map((item) => lowerInputItem(item, state)) : fail();
  const selected = choiceFor(request.toolChoice, state, true);
  for (const entry of state.byEncodedName.values()) {
    if (entry.kind === "custom" || entry.nested.strict !== true) continue;
    const schema = providerToolSchema(entry.parameters); // normalize nullable root first
    // A nullable object root is the one documented provider normalization.
    // Every other unsupported source form must be rejected, not erased by the
    // provider-facing repair before the local strict validator can see it.
    const sourceSchema = isExactNullableObjectRoot(entry.parameters)
      ? { ...entry.parameters, type: "object" }
      : entry.parameters;
    assertStrictSchema(sourceSchema);
    assertStrictSchema(schema);
    state.strictValidators.set(entry.encodedName, schema);
  }
  const mapping = Object.freeze({ entries: Object.freeze([...state.byEncodedName.values()].map((entry) => Object.freeze({ kind: entry.kind, name: entry.name, namespace: entry.namespace, encodedName: entry.encodedName }))) });
  const build = Object.freeze({ tools: builtTools, toolChoice: selected.toolChoice, input: loweredInput, mapping, forcedRequirement: selected.forcedRequirement, strictValidators: Object.freeze([...state.strictValidators.keys()]) });
  MAPPING_STATE.set(mapping, state); BUILD_STATE.set(build, { state, forcedRequirement: selected.forcedRequirement });
  return build;
}

function isExactNullableObjectRoot(schema) {
  if (!Array.isArray(schema?.type) || schema.type.length !== 2) return false;
  return new Set(schema.type).size === 2 && schema.type.includes("object") && schema.type.includes("null");
}

function restoreItem(item, state, context) {
  if (!item || typeof item !== "object" || item.type !== "function_call") return item;
  if (typeof item.name !== "string" || typeof item.call_id !== "string" || !item.call_id || state.callIds.has(item.call_id)) fail();
  const entry = state.byEncodedName.get(item.name);
  if (!entry) fail();
  if (context.seenCallIds.has(item.call_id)) fail();
  context.seenCallIds.add(item.call_id);
  const prior = state.returnedCallIds.get(item.call_id);
  if (prior && (!context.lifecycleCallIds.has(item.call_id) || prior.entry !== entry || prior.itemId !== item.id || item.id === undefined)) fail();
  const strictSchema = state.strictValidators.get(item.name);
  if (strictSchema && item.arguments !== "" && !schemaAccepts(parseArguments(item.arguments), strictSchema)) fail();
  if (entry.kind === "custom" && item.arguments !== "") exactInput(item.arguments);
  if (!prior) state.returnedCallIds.set(item.call_id, { entry, itemId: item.id });
  if (entry.kind === "custom") {
    const { arguments: _arguments, ...rest } = item;
    return { ...rest, type: "custom_tool_call", name: entry.name, ...(item.arguments === "" ? {} : { input: exactInput(item.arguments) }) };
  }
  return entry.kind === "namespace" ? { ...item, name: entry.name, namespace: entry.namespace } : { ...item, name: entry.name };
}

function restoreOutput(item, state) {
  if (!item || typeof item !== "object" || !["function_call_output", "custom_tool_call_output"].includes(item.type)) return item;
  if (typeof item.call_id !== "string" || !state.callIds.has(item.call_id)) fail();
  const entry = state.callIds.get(item.call_id);
  if ((item.type === "custom_tool_call_output") !== (entry.kind === "custom")) fail();
  return entry.kind === "custom" ? { ...item, type: "custom_tool_call_output" } : item;
}

function restoreValue(value, state, context) {
  if (!value || typeof value !== "object") return value;
  const item = restoreOutput(restoreItem(value, state, context), state);
  if (Array.isArray(item.output)) return { ...item, output: item.output.map((entry) => restoreValue(entry, state, context)) };
  if (Array.isArray(item.response?.output)) return { ...item, response: { ...item.response, output: item.response.output.map((entry) => restoreValue(entry, state, context)) } };
  return item.item ? { ...item, item: restoreValue(item.item, state, context) } : item;
}

function safeEventSnapshot(value, code = "tool_mapping_error") {
  const event = safeSnapshot(value, { nodes: 0 }, new WeakSet(), 0, code);
  if (!event || typeof event !== "object" || Array.isArray(event)) fail(code);
  if (event.type === "response.completed") {
    if (event.response !== undefined) {
      if (!event.response || typeof event.response !== "object" || Array.isArray(event.response) || !Array.isArray(event.response.output)) fail(code);
    } else if (!Array.isArray(event.output)) fail(code);
  }
  return event;
}

function lifecycleCallIds(event, state) {
  const allowed = new Set();
  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    const tracked = state.itemCalls.get(event.item.id);
    if (!tracked || !tracked.added || tracked.done || !tracked.argumentsDone) fail();
    if (event.item.call_id !== tracked.callId || state.byEncodedName.get(event.item.name) !== tracked.entry || event.item.arguments !== tracked.finalArguments) fail();
    tracked.done = true;
    allowed.add(tracked.callId);
  }
  if (event.type === "response.completed") {
    if (!state.itemCalls.size) return allowed;
    const calls = eventFunctionCalls(event);
    if (calls.length !== state.itemCalls.size) fail();
    const byCallId = new Map();
    for (const tracked of state.itemCalls.values()) {
      if (byCallId.has(tracked.callId)) fail();
      byCallId.set(tracked.callId, tracked);
    }
    const terminal = [];
    const seenItemIds = new Set();
    const seenCallIds = new Set();
    for (const call of calls) {
      if (typeof call.id !== "string" || !call.id || typeof call.call_id !== "string" || !call.call_id
        || seenItemIds.has(call.id) || seenCallIds.has(call.call_id)) fail();
      seenItemIds.add(call.id); seenCallIds.add(call.call_id);
      const trackedByItem = state.itemCalls.get(call.id);
      const trackedByCall = byCallId.get(call.call_id);
      if (!trackedByItem || !trackedByCall || trackedByItem !== trackedByCall) fail();
      const tracked = trackedByItem;
      const prior = state.returnedCallIds.get(call.call_id);
      const entry = state.byEncodedName.get(call.name);
      if (!tracked.done || tracked.terminal || tracked.entry !== entry || tracked.callId !== call.call_id || tracked.finalArguments !== call.arguments || prior?.entry !== tracked.entry || prior?.itemId !== call.id) fail();
      allowed.add(tracked.callId);
      terminal.push(tracked);
    }
    for (const tracked of terminal) tracked.terminal = true;
  }
  return allowed;
}

function lifecycleItem(event, state) {
  const item = event.item;
  if (!item || item.type !== "function_call" || typeof item.id !== "string" || !item.id || typeof item.call_id !== "string" || !item.call_id) return;
  const entry = state.byEncodedName.get(item.name);
  if (!entry) fail();
  const existing = state.itemCalls.get(item.id);
  if (event.type === "response.output_item.added") {
    if (existing) fail();
    state.itemCalls.set(item.id, { entry, callId: item.call_id, added: true, argumentsDone: item.arguments !== "", finalArguments: item.arguments !== "" ? item.arguments : undefined, argumentBytes: typeof item.arguments === "string" ? Buffer.byteLength(item.arguments) : 0 });
  } else if (!existing || existing.entry !== entry || existing.callId !== item.call_id) fail();
}

export function restoreToolEvent(event, mapping) {
  const state = stateFor(mapping);
  const safeEvent = safeEventSnapshot(event);
  if (state.native) return event;
  const type = safeEvent?.type;
  if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
    if (typeof safeEvent.item_id !== "string" || !safeEvent.item_id) fail();
    const tracked = state.itemCalls.get(safeEvent.item_id);
    if (!tracked || !tracked.added || tracked.argumentsDone) fail();
    if (type.endsWith("delta")) {
      if (typeof safeEvent.delta !== "string") fail();
      tracked.argumentBytes += Buffer.byteLength(safeEvent.delta);
      if (!Number.isSafeInteger(tracked.argumentBytes) || tracked.argumentBytes > FORCED_MAX_BYTES) fail();
      return tracked.entry.kind === "custom" ? undefined : { ...safeEvent };
    }
    if (typeof safeEvent.arguments !== "string" || Buffer.byteLength(safeEvent.arguments) > FORCED_MAX_BYTES) fail();
    tracked.argumentsDone = true; tracked.finalArguments = safeEvent.arguments;
    const strictSchema = state.strictValidators.get(tracked.entry.encodedName);
    if (strictSchema && !schemaAccepts(parseArguments(safeEvent.arguments), strictSchema)) fail();
    if (tracked.entry.kind !== "custom") return { ...safeEvent };
    const { arguments: _arguments, ...metadata } = safeEvent;
    return { ...metadata, type: "response.custom_tool_call_input.done", input: exactInput(tracked.finalArguments) };
  }
  const context = { lifecycleCallIds: lifecycleCallIds(safeEvent, state), seenCallIds: new Set() };
  const restored = restoreValue(safeEvent, state, context);
  if (safeEvent?.type === "response.output_item.added" && safeEvent.item?.type === "function_call") lifecycleItem(safeEvent, state);
  return restored;
}

function forcedBufferHeader(buffer) {
  const bytes = ownData(buffer, "bytes", "forced_tool_buffer_limit");
  const elapsedMs = ownData(buffer, "elapsedMs", "forced_tool_buffer_timeout");
  const events = ownData(buffer, "events", "forced_tool_buffer_limit");
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > FORCED_MAX_BYTES) fail("forced_tool_buffer_limit");
  if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > FORCED_MAX_MS) fail("forced_tool_buffer_timeout");
  if (!Array.isArray(events)) fail("required_tool_not_called");
  const length = ownData(events, "length", "required_tool_not_called");
  if (!Number.isSafeInteger(length) || length < 0 || length > FORCED_MAX_BYTES) fail("required_tool_not_called");
  return { events, length };
}

function eventFunctionCalls(event) {
  const calls = [];
  if (event.item?.type === "function_call") calls.push(event.item);
  if (Array.isArray(event.output)) for (const item of event.output) if (item?.type === "function_call") calls.push(item);
  if (Array.isArray(event.response?.output)) for (const item of event.response.output) if (item?.type === "function_call") calls.push(item);
  return calls;
}

function validateInvocation(invocation, state) {
  if (!invocation.completed || typeof invocation.arguments !== "string") fail("required_tool_not_called");
  if (invocation.entry.kind === "custom") exactInput(invocation.arguments);
  const strictSchema = state.strictValidators.get(invocation.entry.encodedName);
  if (strictSchema && !schemaAccepts(parseArguments(invocation.arguments), strictSchema)) fail("required_tool_not_called");
}

function mergeForcedCompletedSet(calls, byItemId, byCallId, state) {
  if (calls.length !== byItemId.size || byCallId.size !== byItemId.size) fail("required_tool_not_called");
  const terminal = [];
  const seenItemIds = new Set();
  const seenCallIds = new Set();
  for (const call of calls) {
    if (typeof call.id !== "string" || !call.id || typeof call.call_id !== "string" || !call.call_id
      || typeof call.name !== "string" || state.callIds.has(call.call_id)
      || seenItemIds.has(call.id) || seenCallIds.has(call.call_id)) fail("required_tool_not_called");
    seenItemIds.add(call.id); seenCallIds.add(call.call_id);
    const invocationByItem = byItemId.get(call.id);
    const invocationByCall = byCallId.get(call.call_id);
    if (!invocationByItem || !invocationByCall || invocationByItem !== invocationByCall) fail("required_tool_not_called");
    const entry = state.byEncodedName.get(call.name);
    if (!invocationByItem.streamed || !invocationByItem.completed || invocationByItem.terminal
      || invocationByItem.entry !== entry || invocationByItem.arguments !== call.arguments) fail("required_tool_not_called");
    terminal.push(invocationByItem);
  }
  for (const invocation of terminal) invocation.terminal = true;
}

export function validateForcedToolResult(buffer, build) {
  const buildState = buildStateFor(build);
  if (!buildState.forcedRequirement) return;
  const { events, length } = forcedBufferHeader(buffer);
  const byCallId = new Map();
  const byItemId = new Map();
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownData(events, String(index), "required_tool_not_called");
    if (descriptor === undefined) fail("required_tool_not_called");
    const event = safeEventSnapshot(descriptor, "required_tool_not_called");
    const type = event.type;
    if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const invocation = byItemId.get(event.item_id);
      if (!invocation || invocation.completed || invocation.argumentsDone || (type.endsWith("delta") && typeof event.delta !== "string")) fail("required_tool_not_called");
      if (type.endsWith("done")) {
        if (typeof event.arguments !== "string") fail("required_tool_not_called");
        invocation.argumentsDone = true;
        invocation.arguments = event.arguments;
      }
      continue;
    }
    const calls = eventFunctionCalls(event);
    if (type === "response.completed" && byItemId.size) {
      mergeForcedCompletedSet(calls, byItemId, byCallId, buildState.state);
      continue;
    }
    for (const call of calls) {
      if (typeof call.call_id !== "string" || !call.call_id || typeof call.name !== "string" || buildState.state.callIds.has(call.call_id)) fail("required_tool_not_called");
      const entry = buildState.state.byEncodedName.get(call.name);
      if (!entry) fail("required_tool_not_called");
      const existing = byCallId.get(call.call_id);
      if (type === "response.output_item.added") {
        if (existing || typeof call.id !== "string" || !call.id || byItemId.has(call.id)) fail("required_tool_not_called");
        const invocation = { entry, callId: call.call_id, itemId: call.id, arguments: call.arguments === "" ? undefined : call.arguments, argumentsDone: call.arguments !== "", completed: false, streamed: true, terminal: false };
        byCallId.set(call.call_id, invocation); byItemId.set(call.id, invocation);
      } else if (type === "response.output_item.done") {
        const invocation = byItemId.get(call.id);
        if (!invocation || invocation !== existing || invocation.entry !== entry || invocation.completed || !invocation.argumentsDone || call.arguments !== invocation.arguments) fail("required_tool_not_called");
        invocation.completed = true;
      } else {
        if (existing) fail("required_tool_not_called");
        if (typeof call.arguments !== "string") fail("required_tool_not_called");
        byCallId.set(call.call_id, { entry, callId: call.call_id, itemId: call.id, arguments: call.arguments, argumentsDone: true, completed: true, streamed: false, terminal: type === "response.completed" });
      }
    }
  }
  const invocations = [...byCallId.values()];
  if (!invocations.length) fail("required_tool_not_called");
  for (const invocation of invocations) validateInvocation(invocation, buildState.state);
  if (buildState.forcedRequirement.type === "named") {
    const required = buildState.state.byOriginal.get(callKey(buildState.forcedRequirement.kind, buildState.forcedRequirement.namespace, buildState.forcedRequirement.name));
    if (!invocations.some((invocation) => invocation.entry === required)) fail("required_tool_mismatch");
  }
}

export function createForcedToolBuffer(options = {}) {
  const build = ownData(options, "build");
  buildStateFor(build);
  const abort = ownData(options, "abort") ?? (() => {});
  const byteCounter = ownData(options, "byteCounter") ?? ((chunk) => Buffer.byteLength(chunk));
  const clock = ownData(options, "clock") ?? (() => Date.now());
  const signal = ownData(options, "signal");
  const onUsage = ownData(options, "onUsage");
  if (typeof abort !== "function" || typeof byteCounter !== "function" || typeof clock !== "function" || (onUsage !== undefined && typeof onUsage !== "function")) fail();
  let terminal = false; let aborted = false; let bytes = 0; let usage; let listener; let lastClock = -Infinity;
  // The private snapshot remains frozen; delivery gets an independent copy so
  // an observer cannot mutate buffer state (or break cancellation by throwing
  // on a frozen argument).
  const deliverUsage = () => { if (usage !== undefined) onUsage?.(publicUsageCopy(usage)); };
  const cleanup = () => {
    if (!listener) return;
    try { signal.removeEventListener("abort", listener); } catch { /* listener cleanup is best effort */ }
    listener = undefined;
  };
  const cancel = () => {
    if (terminal) return;
    terminal = true; aborted = true; cleanup();
    try { deliverUsage(); } finally { abort(); }
  };
  const initialClock = () => {
    let value; try { value = clock(); } catch { fail("forced_tool_buffer_timeout"); }
    if (!Number.isFinite(value)) fail("forced_tool_buffer_timeout");
    lastClock = value; return value;
  };
  const startedAt = initialClock();
  const readClock = () => {
    let value; try { value = clock(); } catch { cancel(); fail("forced_tool_buffer_timeout"); }
    if (!Number.isFinite(value) || value < lastClock) { cancel(); fail("forced_tool_buffer_timeout"); }
    lastClock = value; return value;
  };
  const deadline = () => {
    const now = readClock();
    if (now - startedAt > FORCED_MAX_MS) { cancel(); fail("forced_tool_buffer_timeout"); }
    return now;
  };
  const abortFromCaller = () => cancel();
  if (signal) {
    let alreadyAborted; try { alreadyAborted = signal.aborted; } catch { fail(); }
    if (alreadyAborted) abortFromCaller();
    else {
      listener = abortFromCaller;
      try { signal.addEventListener("abort", listener, { once: true }); } catch { fail(); }
    }
  }
  return Object.freeze({
    push(chunk) {
      if (terminal) return false;
      deadline();
      let counted; try { counted = byteCounter(chunk); } catch { cancel(); fail("forced_tool_buffer_limit"); }
      if (!Number.isSafeInteger(counted) || counted < 0 || bytes > Number.MAX_SAFE_INTEGER - counted || bytes + counted > FORCED_MAX_BYTES) { cancel(); fail("forced_tool_buffer_limit"); }
      bytes += counted; return true;
    },
    observeUsage(nextUsage) {
      if (terminal) return false;
      try { usage = privateUsageSnapshot(nextUsage); } catch (error) { cancel(); throw error; }
      return true;
    },
    finish(events) {
      if (terminal) return false;
      const now = deadline();
      try { validateForcedToolResult({ bytes, elapsedMs: now - startedAt, events }, build); } catch (error) { cancel(); throw error; }
      terminal = true; cleanup(); deliverUsage(); return true;
    },
    abortFromCaller,
    get state() { return Object.freeze({ bytes, usage: usage === undefined ? undefined : deepFreezeSnapshot(publicUsageCopy(usage)), aborted, relayedBytes: 0, retries: 0, failovers: 0 }); },
  });
}

export const FORCED_TOOL_BUFFER_LIMIT_BYTES = FORCED_MAX_BYTES;
export const FORCED_TOOL_BUFFER_TIMEOUT_MS = FORCED_MAX_MS;
