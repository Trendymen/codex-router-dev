import { createHash } from "node:crypto";

import { namespaceToolEntries } from "./namespace-relay.mjs";
import { providerToolSchema } from "./tool-schema-root.mjs";

const UPSTREAM_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FORCED_MAX_BYTES = 8 * 1024 * 1024;
const FORCED_MAX_MS = 30_000;

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
  if (!item || typeof item !== "object" || typeof item.name !== "string") fail();
  const isCustom = item.type === "custom_tool_call" || item.type === "custom_tool_call_output";
  const kind = isCustom ? "custom" : item.namespace === undefined ? "function" : "namespace";
  const key = callKey(kind, item.namespace, item.name);
  return mapping.byOriginal.get(key) ?? (kind === "function" ? mapping.byOriginal.get(callKey("custom", undefined, item.name)) : undefined);
}

function registerHistory(mapping, item) {
  if (typeof item.call_id !== "string" || !item.call_id) fail();
  if (mapping.callIds.has(item.call_id)) fail();
  mapping.callIds.set(item.call_id, mappingForCall(mapping, item));
}

function lowerInputItem(item, mapping) {
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
  if (!usesFunctions || toolChoice === undefined) return { toolChoice, forcedRequirement: undefined };
  if (toolChoice === "auto" || toolChoice === "none") return { toolChoice, forcedRequirement: undefined };
  if (toolChoice === "required") return { toolChoice: "auto", forcedRequirement: { type: "any" } };
  if (toolChoice && typeof toolChoice === "object" && toolChoice.type === "function" && typeof toolChoice.name === "string") {
    const entry = mapping.byOriginal.get(callKey("function", undefined, toolChoice.name));
    if (!entry) fail();
    return { toolChoice: "auto", forcedRequirement: { type: "named", name: toolChoice.name } };
  }
  fail();
}

export function encodeToolDialect({ tools, toolChoice, input, profile } = {}) {
  const usesFunctions = profileUsesFunctions(profile);
  const mapping = { byEncodedName: new Map(), byOriginal: new Map(), callIds: new Map(), returnedCallIds: new Map() };
  const entries = declarationEntries(tools);
  const names = new Set();
  const builtTools = entries.map((entry) => {
    const original = originalName(entry);
    const mayPreserve = entry.kind === "function" && UPSTREAM_NAME.test(entry.name);
    const encodedName = mayPreserve ? entry.name : encodedToolName(entry.kind, original);
    if (names.has(encodedName) || mapping.byEncodedName.has(encodedName)) fail();
    names.add(encodedName);
    const record = Object.freeze({ ...entry, encodedName });
    mapping.byEncodedName.set(encodedName, record);
    mapping.byOriginal.set(callKey(entry.kind, entry.namespace, entry.name), record);
    return outputTool(entry, encodedName, usesFunctions);
  });
  const loweredInput = Array.isArray(input) ? input.map((item) => lowerInputItem(item, mapping)) : input;
  const selected = choiceFor(toolChoice, mapping, usesFunctions);
  const strictValidators = new Map();
  if (usesFunctions) {
    for (const entry of mapping.byEncodedName.values()) {
      if (entry.kind === "function" && entry.nested.strict === true) {
        strictValidators.set(entry.encodedName, providerToolSchema(entry.parameters));
      }
    }
  }
  mapping.strictValidators = strictValidators;
  return { tools: builtTools, toolChoice: selected.toolChoice, input: loweredInput, mapping, forcedRequirement: selected.forcedRequirement, strictValidators };
}

function restoreItem(item, mapping) {
  if (!item || typeof item !== "object" || item.type !== "function_call") return item;
  if (typeof item.name !== "string" || typeof item.call_id !== "string" || !item.call_id) fail();
  const entry = mapping.byEncodedName.get(item.name);
  if (!entry || mapping.callIds.has(item.call_id)) fail();
  const prior = mapping.returnedCallIds.get(item.call_id);
  if (prior && (prior.entry !== entry || prior.itemId !== item.id || item.id === undefined)) fail();
  if (entry.kind === "custom") {
    const input = exactInput(item.arguments);
    const { arguments: _arguments, ...rest } = item;
    if (!prior) mapping.returnedCallIds.set(item.call_id, { entry, itemId: item.id });
    return { ...rest, type: "custom_tool_call", name: entry.name, input };
  }
  const strictSchema = mapping.strictValidators?.get(item.name);
  if (strictSchema && !schemaAccepts(parseArguments(item.arguments), strictSchema)) fail();
  if (!prior) mapping.returnedCallIds.set(item.call_id, { entry, itemId: item.id });
  return entry.kind === "namespace" ? { ...item, name: entry.name, namespace: entry.namespace } : { ...item, name: entry.name };
}

function restoreOutput(item, mapping) {
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
  if (!mapping?.byEncodedName || !mapping?.callIds || !mapping?.returnedCallIds) fail();
  return restoreValue(event, mapping);
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
  if (build.forcedRequirement.type === "named") {
    const matched = calls.some((call) => {
      const entry = build.mapping.byEncodedName.get(call.name);
      return entry?.name === build.forcedRequirement.name;
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
  const startedAt = clock();
  let bytes = 0;
  let aborted = false;
  let usage;
  const cancel = () => {
    if (aborted) return;
    aborted = true;
    abort();
  };
  const deadline = () => {
    if (clock() - startedAt <= FORCED_MAX_MS) return;
    cancel();
    fail("forced_tool_buffer_timeout");
  };
  const abortFromCaller = () => {
    cancel();
  };
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  return {
    push(chunk) {
      if (aborted) return false;
      deadline();
      const nextBytes = bytes + byteCounter(chunk);
      if (nextBytes > FORCED_MAX_BYTES) {
        cancel();
        fail("forced_tool_buffer_limit");
      }
      bytes = nextBytes;
      return true;
    },
    observeUsage(nextUsage) {
      usage = nextUsage;
      onUsage?.(nextUsage);
    },
    finish(events) {
      if (aborted) return false;
      deadline();
      validateForcedToolResult({ bytes, elapsedMs: clock() - startedAt, events }, build);
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
