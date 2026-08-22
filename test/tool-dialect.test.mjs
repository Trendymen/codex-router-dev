import assert from "node:assert/strict";
import test from "node:test";

import {
  ToolDialectError,
  createForcedToolBuffer,
  encodedToolName,
  encodeToolDialect,
  restoreToolEvent,
  validateForcedToolResult,
} from "../src/tool-dialect.mjs";

const functionsProfile = { provider: "deepseek", toolDialect: "responses-functions" };
const glmProfile = { provider: "glm", toolDialect: "responses-functions" };

const customTool = { type: "custom", name: "computer", description: "Drive the computer" };
const customCall = {
  type: "custom_tool_call",
  id: "fc_1",
  call_id: "call_1",
  name: "computer",
  input: "move the pointer",
};

function mappedCall(build, overrides = {}) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: build.tools[0].name,
      arguments: JSON.stringify({ input: "move the pointer" }),
      ...overrides,
    },
  };
}

function mappedOutput(build, overrides = {}) {
  return { type: "response.completed", output: [mappedCall(build, overrides).item] };
}

function twoCallLifecycle(build, { unfinishedSecond = false } = {}) {
  const name = build.tools[0].name;
  const added = [
    { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "" },
    { type: "function_call", id: "fc_2", call_id: "call_2", name, arguments: "" },
  ];
  const final = [
    { ...added[0], arguments: '{"input":"first"}' },
    { ...added[1], arguments: '{"input":"second"}' },
  ];
  const events = added.map((item) => ({ type: "response.output_item.added", item }));
  events.push(
    { type: "response.function_call_arguments.done", item_id: added[0].id, arguments: final[0].arguments },
    { type: "response.output_item.done", item: final[0] },
  );
  if (!unfinishedSecond) events.push(
    { type: "response.function_call_arguments.done", item_id: added[1].id, arguments: final[1].arguments },
    { type: "response.output_item.done", item: final[1] },
  );
  return { events, final };
}

function completedWith(output) {
  return { type: "response.completed", response: { output } };
}

function code(thunk) {
  assert.throws(thunk, (error) => error instanceof ToolDialectError && error.code === "tool_mapping_error");
}

test("encodes namespace and custom names with the exact stable hash form", () => {
  assert.equal(
    encodedToolName("custom", "a b/工具"),
    "cr_a_b____LOZRJOT7TSDLNPFJ",
  );
  assert.match(encodedToolName("namespace", "x".repeat(80)), /^cr_x{40}_[A-Z2-7]{16}$/);
  assert.notEqual(encodedToolName("custom", "same"), encodedToolName("namespace", "same"));
});

test("custom declarations round-trip through one required input string", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  assert.deepEqual(build.tools[0].parameters, {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  });
  assert.deepEqual(restoreToolEvent(mappedOutput(build), build.mapping), { type: "response.completed", output: [customCall] });
});

test("preserves valid native function names but rejects mapped-name collisions", () => {
  const build = encodeToolDialect({
    tools: [{ type: "function", name: "run_ok", parameters: { type: "object" } }],
    input: [],
    profile: functionsProfile,
  });
  assert.equal(build.tools[0].name, "run_ok");
  code(() => encodeToolDialect({
    tools: [{ type: "function", name: "run_ok" }, { type: "function", name: "run_ok" }],
    input: [], profile: functionsProfile,
  }));
});

test("lowers namespace and custom continuation history from the declaration map", () => {
  const build = encodeToolDialect({
    tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }] }, customTool],
    input: [
      { type: "function_call", call_id: "old_namespace", namespace: "mcp", name: "read", arguments: "{}" },
      { type: "custom_tool_call", call_id: "old_custom", name: "computer", input: "inspect" },
      { type: "custom_tool_call_output", call_id: "old_custom", output: "done" },
    ],
    profile: functionsProfile,
  });
  assert.equal(build.input[0].namespace, undefined);
  assert.match(build.input[0].name, /^cr_mcp__read_/);
  assert.deepEqual(JSON.parse(build.input[1].arguments), { input: "inspect" });
  assert.equal(build.input[1].type, "function_call");
  assert.equal(build.input[2].type, "function_call_output");
});

test("rejects unknown names, duplicate or foreign call IDs and invalid custom arguments", () => {
  const build = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  code(() => restoreToolEvent(mappedOutput(build, { name: "unknown" }), build.mapping));
  code(() => restoreToolEvent(mappedOutput(build, { arguments: JSON.stringify({ input: "x", extra: true }) }), build.mapping));
  restoreToolEvent(mappedOutput(build), build.mapping);
  code(() => restoreToolEvent(mappedOutput(build, { id: "fc_other" }), build.mapping));
  code(() => encodeToolDialect({
    tools: [customTool],
    input: [{ type: "custom_tool_call_output", call_id: "foreign", output: "x" }],
    profile: functionsProfile,
  }));
});

test("restores one streamed call lifecycle without accepting the call ID for another item", () => {
  const build = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const added = { type: "response.output_item.added", item: mappedCall(build).item };
  const done = { type: "response.output_item.done", item: mappedCall(build).item };
  assert.equal(restoreToolEvent(added, build.mapping).item.type, "custom_tool_call");
  assert.equal(restoreToolEvent(done, build.mapping).item.type, "custom_tool_call");
  code(() => restoreToolEvent(mappedCall(build, { id: "fc_reused" }), build.mapping));
});

test("normalizes function schemas and enforces DeepSeek/Qwen choices locally", () => {
  const build = encodeToolDialect({
    tools: [{ type: "function", name: "paint", strict: true, parameters: { type: "object", properties: { color: { type: "string" } } } }],
    toolChoice: { type: "function", name: "paint" }, input: [], profile: functionsProfile,
  });
  assert.equal(build.tools[0].strict, undefined);
  assert.equal(build.tools[0].parameters.type, "object");
  assert.equal(build.toolChoice, "auto");
  assert.deepEqual(build.forcedRequirement, { type: "named", name: "paint", kind: "function", namespace: undefined });
  assert.equal(build.strictValidators.length, 1);
  assert.deepEqual(encodeToolDialect({ tools: [], toolChoice: "none", input: [], profile: functionsProfile }).toolChoice, "none");
  assert.deepEqual(encodeToolDialect({ tools: [], toolChoice: "required", input: [], profile: functionsProfile }).toolChoice, "auto");
});

test("locally rejects strict function arguments that violate the normalized object schema", () => {
  const build = encodeToolDialect({
    tools: [{ type: "function", name: "paint", strict: true, parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false } }],
    input: [], profile: functionsProfile,
  });
  const valid = mappedOutput({ ...build, tools: [{ name: "paint" }] }, { name: "paint", arguments: '{"color":"blue"}' });
  assert.equal(restoreToolEvent(valid, build.mapping).output[0].name, "paint");
  const invalid = mappedOutput({ ...build, tools: [{ name: "paint" }] }, { call_id: "call_bad", name: "paint", arguments: '{"color":1}' });
  code(() => restoreToolEvent(invalid, build.mapping));
});

test("GLM keeps native declarations, strict schemas, and all supported choices", () => {
  const tool = { type: "function", name: "paint", strict: true, parameters: { type: "object" } };
  for (const choice of ["auto", "none", "required", { type: "function", name: "paint" }]) {
    const build = encodeToolDialect({ tools: [tool], toolChoice: choice, input: [], profile: glmProfile });
    assert.deepEqual(build.tools, [tool]);
    assert.deepEqual(build.toolChoice, choice);
    assert.equal(build.forcedRequirement, undefined);
  }
});

test("GLM native dialect returns pristine declarations, choice and continuation by identity", () => {
  const tools = [
    { type: "function", name: "工具 name", strict: true, parameters: { type: "object", oneOf: [] } },
    { type: "custom", name: "computer" },
    { type: "namespace", name: "mcp__工具", tools: [{ type: "function", name: "读" }] },
  ];
  const input = [{ type: "custom_tool_call", call_id: "c", name: "computer", input: "原样" }];
  const choice = { type: "function", name: "工具 name" };
  const build = encodeToolDialect({ tools, toolChoice: choice, input, profile: glmProfile });
  assert.equal(build.tools, tools);
  assert.equal(build.input, input);
  assert.equal(build.toolChoice, choice);
  assert.deepEqual(tools[0], { type: "function", name: "工具 name", strict: true, parameters: { type: "object", oneOf: [] } });
});

test("normalizes a top-level string input before request-local lowering", () => {
  const build = encodeToolDialect({ input: "plain continuation", tools: [], toolChoice: undefined, profile: { provider: "qwen-plan" } });
  assert.deepEqual(build.input, [{ role: "user", content: "plain continuation" }]);
});

test("streamed custom arguments are restored only when done while strict arguments validate then", () => {
  const custom = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const call = mappedCall(custom).item;
  assert.deepEqual(restoreToolEvent({ type: "response.output_item.added", item: { ...call, arguments: "" } }, custom.mapping).item, {
    type: "custom_tool_call", id: "fc_1", call_id: "call_1", name: "computer",
  });
  assert.equal(restoreToolEvent({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"input":"move' }, custom.mapping), undefined);
  assert.deepEqual(restoreToolEvent({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 4, sequence_number: 9, arguments: '{"input":"move pointer"}' }, custom.mapping), {
    type: "response.custom_tool_call_input.done", item_id: "fc_1", output_index: 4, sequence_number: 9, input: "move pointer",
  });
  assert.equal(restoreToolEvent({ type: "response.output_item.done", item: { ...call, arguments: '{"input":"move pointer"}' } }, custom.mapping).item.input, "move pointer");

  const strict = encodeToolDialect({ tools: [{ type: "function", name: "paint", strict: true, parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] } }], input: [], profile: functionsProfile });
  const strictCall = { type: "function_call", id: "fc_strict", call_id: "call_strict", name: "paint", arguments: "" };
  assert.doesNotThrow(() => restoreToolEvent({ type: "response.output_item.added", item: strictCall }, strict.mapping));
  code(() => restoreToolEvent({ type: "response.function_call_arguments.done", item_id: "fc_strict", arguments: '{"color":1}' }, strict.mapping));
});

test("mapping is opaque and strict declaration rejects unsupported schema forms", () => {
  const build = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  assert.throws(() => { build.mapping.byEncodedName = new Map(); }, TypeError);
  assert.deepEqual(Object.keys(build.mapping), ["entries"]);
  code(() => restoreToolEvent(mappedOutput(build), { entries: build.mapping.entries }));
  for (const schema of [
    { type: "object", minimum: 1 }, { type: "object", properties: { s: { type: "string", pattern: "." } } },
    { type: "array", minItems: 1 }, { type: "object", anyOf: [] }, { type: "object", not: {} },
    { type: "object", additionalProperties: { type: "string" } },
  ]) {
    code(() => encodeToolDialect({ tools: [{ type: "function", name: "strict", strict: true, parameters: schema }], input: [], profile: functionsProfile }));
  }
});

test("forced validation admits exact byte/time limits and rejects their first excess", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  validateForcedToolResult({ bytes: 8 * 1024 * 1024, elapsedMs: 30_000, events: [mappedOutput(build)] }, build);
  assert.throws(() => validateForcedToolResult({ bytes: 8 * 1024 * 1024 + 1, elapsedMs: 0, events: [] }, build), /forced_tool_buffer_limit/);
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 30_001, events: [] }, build), /forced_tool_buffer_timeout/);
});

test("forced validation records a matching call and reports no-call or named mismatch", () => {
  const named = encodeToolDialect({ tools: [{ type: "function", name: "paint" }, { type: "function", name: "erase" }], toolChoice: { type: "function", name: "paint" }, input: [], profile: functionsProfile });
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [] }, named), /required_tool_not_called/);
  const other = { type: "response.completed", output: [{ type: "function_call", call_id: "new", name: "erase", arguments: "{}" }] };
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [other] }, named), /required_tool_mismatch/);
});

test("forced buffer uses injected counters and clock at exact limits without relaying or retrying", () => {
  let now = 0;
  let aborts = 0;
  let observedUsage;
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  const buffer = createForcedToolBuffer({
    build,
    clock: () => now,
    byteCounter: (chunk) => chunk.size,
    abort: () => { aborts += 1; },
    onUsage: (usage) => { observedUsage = usage; },
  });
  assert.equal(buffer.push({ size: 8 * 1024 * 1024 }), true);
  buffer.observeUsage({ input_tokens: 7 });
  now = 30_000;
  assert.equal(buffer.finish([mappedOutput(build)]), true);
  assert.deepEqual(buffer.state, { bytes: 8 * 1024 * 1024, usage: { input_tokens: 7 }, aborted: false, relayedBytes: 0, retries: 0, failovers: 0 });
  assert.equal(aborts, 0);
  assert.equal(buffer.observeUsage({ input_tokens: 8 }), false);
  assert.equal(buffer.finish([]), false);
  assert.equal(aborts, 0);
  assert.deepEqual(observedUsage, { input_tokens: 7 });
  assert.deepEqual(buffer.state, { bytes: 8 * 1024 * 1024, usage: { input_tokens: 7 }, aborted: false, relayedBytes: 0, retries: 0, failovers: 0 });
});

test("forced buffer aborts exactly once on the first excess byte or caller cancellation", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  let byteAborts = 0;
  const tooLarge = createForcedToolBuffer({ build, byteCounter: (chunk) => chunk.size, abort: () => { byteAborts += 1; } });
  assert.equal(tooLarge.push({ size: 8 * 1024 * 1024 }), true);
  assert.throws(() => tooLarge.push({ size: 1 }), /forced_tool_buffer_limit/);
  assert.equal(tooLarge.push({ size: 1 }), false);
  assert.equal(byteAborts, 1);
  assert.deepEqual(tooLarge.state, { bytes: 8 * 1024 * 1024, usage: undefined, aborted: true, relayedBytes: 0, retries: 0, failovers: 0 });

  const controller = new AbortController();
  let callerAborts = 0;
  const cancelled = createForcedToolBuffer({ build, signal: controller.signal, abort: () => { callerAborts += 1; } });
  controller.abort();
  controller.abort();
  assert.equal(cancelled.push("ignored"), false);
  assert.equal(callerAborts, 1);
  assert.deepEqual(cancelled.state, { bytes: 0, usage: undefined, aborted: true, relayedBytes: 0, retries: 0, failovers: 0 });
});

test("custom stream keeps wrapper private and rejects reversed, duplicate, post-done, and cross-item lifecycle events", () => {
  const build = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const call = mappedCall(build).item;
  code(() => restoreToolEvent({ type: "response.function_call_arguments.delta", item_id: "missing", delta: "x" }, build.mapping));
  assert.equal(restoreToolEvent({ type: "response.output_item.added", item: { ...call, arguments: "" } }, build.mapping).item.type, "custom_tool_call");
  assert.equal(restoreToolEvent({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"input":"x' }, build.mapping), undefined);
  const done = restoreToolEvent({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 2, sequence_number: 3, arguments: '{"input":"x"}' }, build.mapping);
  assert.deepEqual(done, { type: "response.custom_tool_call_input.done", item_id: "fc_1", output_index: 2, sequence_number: 3, input: "x" });
  code(() => restoreToolEvent({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "x" }, build.mapping));
  assert.equal(restoreToolEvent({ type: "response.output_item.done", item: { ...call, arguments: '{"input":"x"}' } }, build.mapping).item.input, "x");
  code(() => restoreToolEvent({ type: "response.output_item.done", item: call }, build.mapping));
  code(() => restoreToolEvent({ type: "response.output_item.added", item: { ...call, id: "fc_1", call_id: "other", arguments: "" } }, build.mapping));
});

test("forced named choice retains exact kind namespace and name privately", () => {
  const namespaceTool = { type: "namespace", name: "mcp__apps", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] };
  const build = encodeToolDialect({ tools: [namespaceTool, { type: "function", name: "run", parameters: { type: "object" } }], toolChoice: { type: "function", namespace: "mcp__apps", name: "run" }, input: [], profile: functionsProfile });
  assert.ok(Object.isFrozen(build.forcedRequirement));
  assert.deepEqual(build.forcedRequirement, { type: "named", kind: "namespace", namespace: "mcp__apps", name: "run" });
  const foreign = { type: "response.completed", output: [{ type: "function_call", call_id: "c", name: "run", arguments: "{}" }] };
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [foreign] }, build), /required_tool_mismatch/);
  const matching = { type: "response.completed", output: [{ type: "function_call", call_id: "n", name: build.tools[0].name, arguments: "{}" }] };
  assert.doesNotThrow(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [matching] }, build));
  for (const choice of [{ type: "unknown", name: "run" }, { type: "custom", namespace: "mcp__apps", name: "run" }]) {
    code(() => encodeToolDialect({ tools: [namespaceTool], toolChoice: choice, input: [], profile: functionsProfile }));
  }
});

test("strict namespace validation normalizes nullable roots and compares bounded structural enum and const", () => {
  const tool = { type: "namespace", name: "mcp", tools: [{ type: "function", name: "set", strict: true, parameters: {
    type: ["object", "null"], properties: {
      payload: { type: "object", enum: [{ lane: "a" }], const: { lane: "a" } },
    }, required: ["payload"], additionalProperties: false,
  } }] };
  const build = encodeToolDialect({ tools: [tool], input: [], profile: functionsProfile });
  assert.equal(build.tools[0].parameters.type, "object");
  const valid = { type: "response.completed", output: [{ type: "function_call", id: "ok", call_id: "ok", name: build.tools[0].name, arguments: '{"payload":{"lane":"a"}}' }] };
  assert.equal(restoreToolEvent(valid, build.mapping).output[0].namespace, "mcp");
  const invalid = { ...valid, output: valid.output.map((item) => ({ ...item, id: "bad", call_id: "bad", arguments: '{"payload":{"lane":"b"}' })) };
  code(() => restoreToolEvent(invalid, build.mapping));
});

test("forced direct validation rejects invalid numeric counters and invalid calls as a whole", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  for (const buffer of [
    { bytes: NaN, elapsedMs: 0, events: [] }, { bytes: -1, elapsedMs: 0, events: [] },
    { bytes: Number.MAX_SAFE_INTEGER + 1, elapsedMs: 0, events: [] }, { bytes: 0, elapsedMs: Infinity, events: [] },
    { bytes: 0, elapsedMs: -1, events: [] },
  ]) assert.throws(() => validateForcedToolResult(buffer, build), ToolDialectError);
  const valid = mappedOutput(build);
  const duplicate = { ...valid, output: valid.output.map((item) => ({ ...item })) };
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [valid, duplicate] }, build), /required_tool_not_called/);
  const unknown = { ...valid, output: valid.output.map((item) => ({ ...item, call_id: "u", name: "not_declared" })) };
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [unknown] }, build), /required_tool_not_called/);
});

test("buffer seals invalid clocks and counters, cleans listeners, and reports immutable usage before one abort", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  const listeners = new Set();
  const signal = { aborted: false, addEventListener(_name, listener) { listeners.add(listener); }, removeEventListener(_name, listener) { listeners.delete(listener); } };
  const trace = []; let now = 5;
  const buffer = createForcedToolBuffer({ build, signal, clock: () => now, abort: () => trace.push("abort"), onUsage: (usage) => { trace.push("usage"); usage.input_tokens = 999; } });
  const rawUsage = { input_tokens: 7 };
  buffer.observeUsage(rawUsage); rawUsage.input_tokens = 8;
  now = 4;
  assert.throws(() => buffer.push("x"), /forced_tool_buffer_timeout/);
  assert.deepEqual(trace, ["usage", "abort"]);
  assert.equal(listeners.size, 0);
  assert.equal(buffer.push("x"), false);
  assert.ok(Object.isFrozen(buffer.state.usage));
  assert.equal(buffer.state.usage.input_tokens, 7);
  let counterAborts = 0;
  const invalidCounter = createForcedToolBuffer({ build, byteCounter: () => NaN, abort: () => { counterAborts += 1; } });
  assert.throws(() => invalidCounter.push("x"), /forced_tool_buffer_limit/);
  assert.equal(counterAborts, 1);
});

test("descriptor-only bounded reads turn hostile graphs into ToolDialectError without invoking getters", () => {
  let reads = 0;
  const getterTool = { type: "function", get name() { reads += 1; return "run"; } };
  code(() => encodeToolDialect({ tools: [getterTool], input: [], profile: functionsProfile }));
  assert.equal(reads, 0);
  const cyclic = []; cyclic.push(cyclic);
  code(() => encodeToolDialect({ tools: [], input: cyclic, profile: functionsProfile }));
  const proxy = new Proxy({}, { ownKeys() { throw new Error("decoy"); } });
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  assert.throws(() => restoreToolEvent(proxy, build.mapping), ToolDialectError);
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, get events() { throw new Error("decoy"); } }, build), ToolDialectError);
  const deep = {}; let cursor = deep;
  for (let index = 0; index < 30; index += 1) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => restoreToolEvent(deep, build.mapping), ToolDialectError);
  code(() => encodeToolDialect({ tools: [customTool], input: [{ type: "function_call", call_id: "x", name: "unknown", arguments: "{}" }], profile: functionsProfile }));
});

test("stream lifecycle rejects done without added, conflicts, and keeps ordinary function deltas", () => {
  const custom = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const customCall = mappedCall(custom).item;
  code(() => restoreToolEvent({ type: "response.output_item.done", item: customCall }, custom.mapping));
  restoreToolEvent({ type: "response.output_item.added", item: { ...customCall, arguments: "" } }, custom.mapping);
  restoreToolEvent({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, sequence_number: 2, arguments: '{"input":"final"}' }, custom.mapping);
  code(() => restoreToolEvent({ type: "response.output_item.done", item: { ...customCall, arguments: '{"input":"conflict"}' } }, custom.mapping));

  const functions = encodeToolDialect({ tools: [{ type: "function", name: "paint", parameters: { type: "object" } }], input: [], profile: functionsProfile });
  restoreToolEvent({ type: "response.output_item.added", item: { type: "function_call", id: "fn", call_id: "fn_call", name: "paint", arguments: "" } }, functions.mapping);
  assert.deepEqual(restoreToolEvent({ type: "response.function_call_arguments.delta", item_id: "fn", output_index: 4, sequence_number: 5, delta: '{"color"' }, functions.mapping), {
    type: "response.function_call_arguments.delta", item_id: "fn", output_index: 4, sequence_number: 5, delta: '{"color"',
  });
});

test("strict nullable root accepts only the exact object-null union", () => {
  for (const type of [["object", "string"], ["null", "object", "null"], ["object"], ["null", "object", "number"]]) {
    code(() => encodeToolDialect({ tools: [{ type: "function", name: "strict", strict: true, parameters: { type, properties: {} } }], input: [], profile: functionsProfile }));
  }
  assert.doesNotThrow(() => encodeToolDialect({ tools: [{ type: "function", name: "strict", strict: true, parameters: { type: ["null", "object"], properties: {} } }], input: [], profile: functionsProfile }));
  for (const unsupported of [{ oneOf: [] }, { anyOf: [] }, { minimum: 1 }]) {
    code(() => encodeToolDialect({ tools: [{
      type: "function", name: "strict", strict: true,
      parameters: { type: ["object", "null"], properties: { value: { type: "string" } }, ...unsupported },
    }], input: [], profile: functionsProfile }));
  }
});

test("restores completed output as the exact terminal representation of custom and strict namespace streams", () => {
  const custom = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const customItem = mappedCall(custom, { arguments: "" }).item;
  restoreToolEvent({ type: "response.output_item.added", item: customItem }, custom.mapping);
  restoreToolEvent({ type: "response.function_call_arguments.done", item_id: customItem.id, arguments: '{"input":"final"}' }, custom.mapping);
  restoreToolEvent({ type: "response.output_item.done", item: { ...customItem, arguments: '{"input":"final"}' } }, custom.mapping);
  assert.deepEqual(restoreToolEvent({
    type: "response.completed",
    response: { output: [{ ...customItem, arguments: '{"input":"final"}' }] },
  }, custom.mapping).response.output[0], {
    type: "custom_tool_call", id: "fc_1", call_id: "call_1", name: "computer", input: "final",
  });

  const namespaceTool = { type: "namespace", name: "mcp", tools: [{
    type: "function", name: "paint", strict: true,
    parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false },
  }] };
  const namespaced = encodeToolDialect({ tools: [namespaceTool], input: [], profile: functionsProfile });
  const namespaceItem = { type: "function_call", id: "ns_item", call_id: "ns_call", name: namespaced.tools[0].name, arguments: "" };
  restoreToolEvent({ type: "response.output_item.added", item: namespaceItem }, namespaced.mapping);
  restoreToolEvent({ type: "response.function_call_arguments.done", item_id: namespaceItem.id, arguments: '{"color":"blue"}' }, namespaced.mapping);
  restoreToolEvent({ type: "response.output_item.done", item: { ...namespaceItem, arguments: '{"color":"blue"}' } }, namespaced.mapping);
  assert.deepEqual(restoreToolEvent({
    type: "response.completed",
    response: { output: [{ ...namespaceItem, arguments: '{"color":"blue"}' }] },
  }, namespaced.mapping).response.output[0], {
    ...namespaceItem, name: "paint", namespace: "mcp", arguments: '{"color":"blue"}',
  });
});

test("rejects completed output that conflicts with a streamed invocation identity or final arguments", () => {
  const build = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const item = mappedCall(build, { arguments: "" }).item;
  restoreToolEvent({ type: "response.output_item.added", item }, build.mapping);
  restoreToolEvent({ type: "response.function_call_arguments.done", item_id: item.id, arguments: '{"input":"final"}' }, build.mapping);
  restoreToolEvent({ type: "response.output_item.done", item: { ...item, arguments: '{"input":"final"}' } }, build.mapping);
  for (const conflicting of [
    { ...item, arguments: '{"input":"different"}' },
    { ...item, id: "other_item", arguments: '{"input":"final"}' },
    { ...item, call_id: "other_call", arguments: '{"input":"final"}' },
  ]) code(() => restoreToolEvent({ type: "response.completed", response: { output: [conflicting] } }, build.mapping));
});

test("forced validation merges exact completed terminal calls but rejects conflicting completed calls", () => {
  const custom = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  const customItem = mappedCall(custom, { arguments: "" }).item;
  const customLifecycle = [
    { type: "response.output_item.added", item: customItem },
    { type: "response.function_call_arguments.done", item_id: customItem.id, arguments: '{"input":"final"}' },
    { type: "response.output_item.done", item: { ...customItem, arguments: '{"input":"final"}' } },
  ];
  const customCompleted = { type: "response.completed", response: { output: [{ ...customItem, arguments: '{"input":"final"}' }] } };
  assert.doesNotThrow(() => validateForcedToolResult({ bytes: 1, elapsedMs: 1, events: [...customLifecycle, customCompleted] }, custom));
  const conflictingCustom = { type: "response.completed", response: { output: [{ ...customItem, arguments: '{"input":"different"}' }] } };
  assert.throws(() => validateForcedToolResult({ bytes: 1, elapsedMs: 1, events: [...customLifecycle, conflictingCustom] }, custom), /required_tool_not_called/);

  const namespaceTool = { type: "namespace", name: "mcp", tools: [{
    type: "function", name: "paint", strict: true,
    parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false },
  }] };
  const namespaced = encodeToolDialect({
    tools: [namespaceTool], toolChoice: { type: "function", namespace: "mcp", name: "paint" }, input: [], profile: functionsProfile,
  });
  const namespaceItem = { type: "function_call", id: "ns_item", call_id: "ns_call", name: namespaced.tools[0].name, arguments: "" };
  const namespaceEvents = [
    { type: "response.output_item.added", item: namespaceItem },
    { type: "response.function_call_arguments.done", item_id: namespaceItem.id, arguments: '{"color":"blue"}' },
    { type: "response.output_item.done", item: { ...namespaceItem, arguments: '{"color":"blue"}' } },
    { type: "response.completed", response: { output: [{ ...namespaceItem, arguments: '{"color":"blue"}' }] } },
  ];
  assert.doesNotThrow(() => validateForcedToolResult({ bytes: 1, elapsedMs: 1, events: namespaceEvents }, namespaced));
});

test("completed restoration requires the exact set of two streamed invocations", () => {
  const build = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const { events, final } = twoCallLifecycle(build);
  for (const event of events) restoreToolEvent(event, build.mapping);
  const message = { type: "message", id: "msg_1", content: [] };
  const restored = restoreToolEvent(completedWith([message, ...final]), build.mapping).response.output;
  assert.deepEqual({ ...restored[0] }, message);
  assert.deepEqual(restored.slice(1), [
    { type: "custom_tool_call", id: "fc_1", call_id: "call_1", name: "computer", input: "first" },
    { type: "custom_tool_call", id: "fc_2", call_id: "call_2", name: "computer", input: "second" },
  ]);
});

for (const [name, completedCalls, unfinishedSecond = false] of [
  ["omitted", (final) => [final[0]]],
  ["extra", (final) => [...final, { ...final[0], id: "fc_3", call_id: "call_3" }]],
  ["same item with different call", (final) => [final[0], { ...final[1], call_id: "other_call" }]],
  ["same call with different item", (final) => [final[0], { ...final[1], id: "other_item" }]],
  ["duplicate", (final) => [...final, { ...final[1] }]],
  ["different declaration", (final, build) => [final[0], { ...final[1], name: build.tools[1].name }]],
  ["unfinished", (final) => final, true],
]) {
  test(`completed restoration rejects ${name} streamed invocation sets`, () => {
    const build = encodeToolDialect({ tools: [customTool, { type: "custom", name: "keyboard" }], input: [], profile: functionsProfile });
    const { events, final } = twoCallLifecycle(build, { unfinishedSecond });
    for (const event of events) restoreToolEvent(event, build.mapping);
    code(() => restoreToolEvent(completedWith(completedCalls(final, build)), build.mapping));
  });
}

test("forced validation requires the exact set of two streamed invocations", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  const { events, final } = twoCallLifecycle(build);
  const message = { type: "message", id: "msg_1", content: [] };
  assert.doesNotThrow(() => validateForcedToolResult({
    bytes: 1, elapsedMs: 1, events: [...events, completedWith([message, ...final])],
  }, build));
});

for (const [name, completedCalls, unfinishedSecond = false] of [
  ["omitted", (final) => [final[0]]],
  ["extra", (final) => [...final, { ...final[0], id: "fc_3", call_id: "call_3" }]],
  ["same item with different call", (final) => [final[0], { ...final[1], call_id: "other_call" }]],
  ["same call with different item", (final) => [final[0], { ...final[1], id: "other_item" }]],
  ["duplicate", (final) => [...final, { ...final[1] }]],
  ["different declaration", (final, build) => [final[0], { ...final[1], name: build.tools[1].name }]],
  ["unfinished", (final) => final, true],
]) {
  test(`forced validation rejects ${name} streamed invocation sets`, () => {
    const build = encodeToolDialect({ tools: [customTool, { type: "custom", name: "keyboard" }], toolChoice: "required", input: [], profile: functionsProfile });
    const { events, final } = twoCallLifecycle(build, { unfinishedSecond });
    assert.throws(() => validateForcedToolResult({
      bytes: 1, elapsedMs: 1, events: [...events, completedWith(completedCalls(final, build))],
    }, build), /required_tool_not_called/);
  });
}

test("standalone completed responses register tool calls without streaming state", () => {
  const restored = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  const { final } = twoCallLifecycle(restored);
  assert.equal(restoreToolEvent(completedWith(final), restored.mapping).response.output.length, 2);

  const forced = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  assert.doesNotThrow(() => validateForcedToolResult({
    bytes: 1, elapsedMs: 1, events: [completedWith(twoCallLifecycle(forced).final)],
  }, forced));
});

test("rejects unsafe event roots and non-array completed response output with ToolDialectError", () => {
  const restored = encodeToolDialect({ tools: [customTool], input: [], profile: functionsProfile });
  code(() => restoreToolEvent(null, restored.mapping));
  code(() => restoreToolEvent({ type: "response.completed", response: { output: {} } }, restored.mapping));

  const forced = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [null] }, forced), (error) => error instanceof ToolDialectError && error.code === "required_tool_not_called");
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [{ type: "response.completed", response: { output: {} } }] }, forced), (error) => error instanceof ToolDialectError && error.code === "required_tool_not_called");
});

test("forced result merges one streamed invocation and admits more than 512 bounded events", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  const call = mappedCall(build).item;
  const events = [{ type: "response.output_item.added", item: { ...call, arguments: "" } }];
  for (let index = 0; index < 513; index += 1) events.push({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: index === 512 ? '{"input":"ok"}' : "" });
  events.push({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"input":"ok"}' });
  events.push({ type: "response.output_item.done", item: { ...call, arguments: '{"input":"ok"}' } });
  assert.doesNotThrow(() => validateForcedToolResult({ bytes: 1, elapsedMs: 1, events }, build));
  const reused = [...events, { type: "response.output_item.added", item: { ...call, id: "other", arguments: '{"input":"other"}' } }];
  assert.throws(() => validateForcedToolResult({ bytes: 1, elapsedMs: 1, events: reused }, build), /required_tool_not_called/);
});

test("nested authoritative usage is isolated and invalid replacement cancels after prior delivery", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  const delivered = []; let aborts = 0;
  const buffer = createForcedToolBuffer({ build, abort: () => { aborts += 1; }, onUsage: (usage) => delivered.push(usage) });
  const source = { input_tokens: 3, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: [{ reasoning_tokens: 1 }] };
  buffer.observeUsage(source);
  source.input_tokens_details.cached_tokens = 99;
  assert.equal(buffer.state.usage.input_tokens_details.cached_tokens, 2);
  const invalid = { get input_tokens() { throw new Error("getter"); } };
  assert.throws(() => buffer.observeUsage(invalid), ToolDialectError);
  assert.equal(aborts, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].input_tokens_details.cached_tokens, 2);
  assert.equal(buffer.observeUsage(source), false);
});
