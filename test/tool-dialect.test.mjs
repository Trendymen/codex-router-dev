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
  assert.deepEqual(restoreToolEvent(mappedCall(build), build.mapping), {
    type: "response.output_item.done",
    item: customCall,
  });
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
  code(() => restoreToolEvent(mappedCall(build, { name: "unknown" }), build.mapping));
  code(() => restoreToolEvent(mappedCall(build, { arguments: JSON.stringify({ input: "x", extra: true }) }), build.mapping));
  restoreToolEvent(mappedCall(build), build.mapping);
  code(() => restoreToolEvent(mappedCall(build, { id: "fc_other" }), build.mapping));
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
    tools: [{ type: "function", name: "paint", strict: true, parameters: { type: ["object", "null"], properties: { color: { type: "string" } } } }],
    toolChoice: { type: "function", name: "paint" }, input: [], profile: functionsProfile,
  });
  assert.equal(build.tools[0].strict, undefined);
  assert.equal(build.tools[0].parameters.type, "object");
  assert.equal(build.toolChoice, "auto");
  assert.deepEqual(build.forcedRequirement, { type: "named", name: "paint" });
  assert.equal(build.strictValidators.size, 1);
  assert.deepEqual(encodeToolDialect({ tools: [], toolChoice: "none", input: [], profile: functionsProfile }).toolChoice, "none");
  assert.deepEqual(encodeToolDialect({ tools: [], toolChoice: "required", input: [], profile: functionsProfile }).toolChoice, "auto");
});

test("locally rejects strict function arguments that violate the normalized object schema", () => {
  const build = encodeToolDialect({
    tools: [{ type: "function", name: "paint", strict: true, parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"], additionalProperties: false } }],
    input: [], profile: functionsProfile,
  });
  const valid = mappedCall({ ...build, tools: [{ name: "paint" }] }, { name: "paint", arguments: '{"color":"blue"}' });
  assert.equal(restoreToolEvent(valid, build.mapping).item.name, "paint");
  const invalid = mappedCall({ ...build, tools: [{ name: "paint" }] }, { call_id: "call_bad", name: "paint", arguments: '{"color":1}' });
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

test("forced validation admits exact byte/time limits and rejects their first excess", () => {
  const build = encodeToolDialect({ tools: [customTool], toolChoice: "required", input: [], profile: functionsProfile });
  validateForcedToolResult({ bytes: 8 * 1024 * 1024, elapsedMs: 30_000, events: [mappedCall(build)] }, build);
  assert.throws(() => validateForcedToolResult({ bytes: 8 * 1024 * 1024 + 1, elapsedMs: 0, events: [] }, build), /forced_tool_buffer_limit/);
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 30_001, events: [] }, build), /forced_tool_buffer_timeout/);
});

test("forced validation records a matching call and reports no-call or named mismatch", () => {
  const named = encodeToolDialect({ tools: [{ type: "function", name: "paint" }, { type: "function", name: "erase" }], toolChoice: { type: "function", name: "paint" }, input: [], profile: functionsProfile });
  assert.throws(() => validateForcedToolResult({ bytes: 0, elapsedMs: 0, events: [] }, named), /required_tool_not_called/);
  const other = { type: "response.output_item.done", item: { type: "function_call", call_id: "new", name: "erase", arguments: "{}" } };
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
  now = 30_000;
  assert.equal(buffer.finish([mappedCall(build)]), true);
  assert.deepEqual(buffer.state, { bytes: 8 * 1024 * 1024, usage: undefined, aborted: false, relayedBytes: 0, retries: 0, failovers: 0 });
  assert.equal(aborts, 0);
  buffer.observeUsage({ input_tokens: 7 });
  now = 30_001;
  assert.throws(() => buffer.finish([]), /forced_tool_buffer_timeout/);
  assert.equal(aborts, 1);
  assert.deepEqual(observedUsage, { input_tokens: 7 });
  assert.deepEqual(buffer.state, { bytes: 8 * 1024 * 1024, usage: { input_tokens: 7 }, aborted: true, relayedBytes: 0, retries: 0, failovers: 0 });
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
