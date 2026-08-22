import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createRawPreserveTransform,
  createReasoningCompatTransform,
  normalizeRawReasoningResponse,
  normalizeReasoningResponse,
  reasoningTransformForModel,
  selectedFinalParts,
} from "../src/reasoning-summary-compat.mjs";

const fixtures = new URL("./fixtures/reasoning-events/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), "utf8"));
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function events(text) {
  return text.split(/(?:\r\n|\r|\n){2}/).filter(Boolean).map((block) => {
    const line = block.split(/\r\n|\r|\n/).find((part) => part.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }).filter(Boolean);
}

async function transform(chunks, options) {
  const transformer = createReasoningCompatTransform(options);
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();
  const received = [];
  const drain = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      received.push(Buffer.from(next.value));
    }
  })();
  drain.catch(() => {});
  try {
    for (const chunk of chunks) await writer.write(Buffer.from(chunk));
    await writer.close();
    await drain;
  } catch (error) {
    await reader.cancel().catch(() => {});
    await drain.catch(() => {});
    throw error;
  }
  return Buffer.concat(received).toString("utf8");
}

function model(finalReasoningShape = "provider-summary") {
  return { reasoningDisplayMode: "summary-compat", effectiveFinalReasoningShape: finalReasoningShape };
}

test("strict final suffix is emitted before one delayed text-done", async () => {
  const source = fixture("strict-final-suffix");
  const output = await transform(source.events.map(sse), { responseId: "resp_suffix", model: model(source.finalShape) });
  assert.deepEqual(events(output).map((event) => event.type), [
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const outputEvents = events(output);
  assert.equal(outputEvents[3].delta, " world");
  assert.equal(outputEvents[4].text, "hello world");
  assert.deepEqual(outputEvents[6].item.content, []);
  assert.deepEqual(outputEvents[6].item.summary, [{ type: "summary_text", text: "hello world" }]);
});

test("interleaved items and parts retain isolated indexes and close in final order", async () => {
  const source = fixture("interleaved-items-parts");
  const outputEvents = events(await transform(source.events.map(sse), { responseId: "resp_interleaved", model: model(source.finalShape) }));
  assert.deepEqual(outputEvents.filter((event) => event.type === "response.output_item.done").map((event) => [event.output_index, event.item.id, event.item.summary]), [
    [0, "rs_1", [{ type: "summary_text", text: "A0" }, { type: "summary_text", text: "A1" }]],
    [1, "rs_2", [{ type: "summary_text", text: "B0" }]],
  ]);
  assert.equal(outputEvents.at(-1).type, "response.completed");
  assert.deepEqual(outputEvents.at(-1).response.output.map((item) => item.content), [[], []]);
});

test("final-only and generated Anthropic reasoning items synthesize stable summary lifecycles", async () => {
  const source = fixture("final-only-anthropic");
  const outputEvents = events(await transform(source.events.map(sse), { responseId: source.responseId, model: model(source.finalShape) }));
  const done = outputEvents.find((event) => event.type === "response.output_item.done");
  assert.match(done.item.id, /^rsn_[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(done.item.summary, [{ type: "summary_text", text: "thought 1" }, { type: "summary_text", text: "thought 2" }]);
  assert.equal(outputEvents.filter((event) => event.type === "response.reasoning_summary_text.done").length, 2);
  assert.deepEqual(outputEvents.at(-1).response.output[0].content, []);
  assert.equal("thinking" in outputEvents.at(-1).response.output[0], false);
});

test("selected final parts enforces each declared final source shape", () => {
  const source = fixture("final-shapes");
  assert.deepEqual(selectedFinalParts("raw-content", source.raw), ["raw 0", "raw 1"]);
  assert.deepEqual(selectedFinalParts("provider-summary", source.provider), ["summary 0", "summary 1"]);
  assert.deepEqual(selectedFinalParts("hybrid-summary", source.hybrid), ["authoritative"]);
  assert.deepEqual(selectedFinalParts("anthropic-thinking", source.anthropic), ["think 0", "think 1"]);
  assert.throws(() => selectedFinalParts("raw-content", source.badRaw), { code: "reasoning_final_mismatch" });
});

test("raw deltas use content indexes and hybrid final summaries remain one-to-one", async () => {
  const source = fixture("raw-delta-hybrid");
  const outputEvents = events(await transform(source.events.map(sse), { responseId: "resp_raw", model: model(source.finalShape) }));
  const parts = outputEvents.filter((event) => event.type === "response.reasoning_summary_part.added");
  assert.deepEqual(parts.map((event) => event.summary_index), [0, 1]);
  const done = outputEvents.find((event) => event.type === "response.output_item.done");
  assert.deepEqual(done.item.summary, [{ type: "summary_text", text: "first" }, { type: "summary_text", text: "second" }]);
  assert.deepEqual(done.item.content, []);
});

test("streaming final-only items use the declared selector for every verified shape", async () => {
  const source = fixture("final-only-shapes");
  for (const sample of source.samples) {
    const outputEvents = events(await transform(sample.events.map(sse), { responseId: `resp_${sample.shape}`, model: model(sample.shape) }));
    const done = outputEvents.find((event) => event.type === "response.output_item.done");
    assert.deepEqual(done.item.summary.map((part) => part.text), sample.expected, sample.shape);
    assert.deepEqual(done.item.content, [], sample.shape);
  }
});

for (const code of [
  "reasoning_delta_without_item",
  "reasoning_part_without_item",
  "reasoning_duplicate_item",
  "reasoning_duplicate_part",
  "reasoning_delta_after_done",
  "reasoning_duplicate_done",
  "reasoning_index_mismatch",
  "reasoning_final_part_missing",
  "reasoning_unclosed_at_terminal",
]) {
  test(`rejects Appendix A internal reason ${code}`, async () => {
    const source = fixture(`error-${code}`);
    await assert.rejects(
      () => transform(source.events.map(sse), { responseId: "resp_errors", model: model(source.finalShape || "provider-summary") }),
      { code },
    );
  });
}

test("incomplete and failed terminals close open reasoning before one terminal", async () => {
  for (const name of ["incomplete", "failed"]) {
    const source = fixture(name);
    const outputEvents = events(await transform(source.events.map(sse), { responseId: `resp_${name}`, model: model(source.finalShape) }));
    assert.equal(outputEvents.at(-1).type, `response.${name}`);
    assert.equal(outputEvents.filter((event) => event.type === "response.output_item.done").length, 1);
  }
});

test("post-terminal events are ignored and unknown nonreasoning bytes stay exact", async () => {
  const source = fixture("post-terminal-and-unknown");
  const input = Buffer.concat([Buffer.from(source.prefix, "utf8"), Buffer.from(source.events.map(sse).join(""), "utf8"), Buffer.from(source.suffix, "utf8")]);
  const output = await transform([input.subarray(0, 19), input.subarray(19)], { responseId: "resp_post", model: model(source.finalShape) });
  assert.ok(output.startsWith(source.prefix));
  assert.ok(output.includes(source.suffix));
  assert.equal(events(output).filter((event) => event.type === "response.completed").length, 1);
  assert.equal(output.includes("post terminal"), false);
});

test("state limits reject an unbounded number of reasoning items", async () => {
  const source = fixture("limit-items");
  const eventsAtLimit = Array.from({ length: 1_025 }, (_, output_index) => ({
    ...source.events[0],
    output_index,
    item: { id: `rs_${output_index}`, type: "reasoning" },
  }));
  await assert.rejects(
    () => transform(eventsAtLimit.map(sse), { responseId: "resp_limit", model: model(source.finalShape) }),
    { code: "reasoning_limit_exceeded" },
  );
});

test("EOF without one terminal event fails as upstream_stream_truncated", async () => {
  const source = fixture("error-upstream_stream_truncated");
  await assert.rejects(
    () => transform(source.events.map(sse), { responseId: "resp_eof", model: model(source.finalShape) }),
    { code: "upstream_stream_truncated" },
  );
});

test("raw preserve leaves reasoning SSE, final JSON, and unknown bytes value-identical", async () => {
  const source = fixture("raw-preserve");
  const transformer = createRawPreserveTransform();
  const writer = transformer.writable.getWriter();
  const reader = transformer.readable.getReader();
  const input = Buffer.from(source.sse, "utf8");
  const read = reader.read();
  await writer.write(input);
  assert.deepEqual(Buffer.from((await read).value), input);
  await writer.close();
  assert.strictEqual(normalizeRawReasoningResponse(source.final), source.final);
  assert.deepEqual(normalizeRawReasoningResponse(source.final), source.final);
});

test("non-streaming normalization mirrors stream final parts and leaves native or raw paths alone", () => {
  const source = fixture("final-shapes");
  const normalized = normalizeReasoningResponse({ output: [source.provider] }, model("provider-summary"));
  assert.deepEqual(normalized.output[0].summary, [{ type: "summary_text", text: "summary 0" }, { type: "summary_text", text: "summary 1" }]);
  assert.deepEqual(normalized.output[0].content, []);
  assert.equal(reasoningTransformForModel({ effectiveTransport: "native-openai", reasoningDisplayMode: "summary-compat" }), undefined);
  assert.ok(reasoningTransformForModel({ effectiveTransport: "openai-responses", reasoningDisplayMode: "raw-preserve" }));
  assert.throws(() => reasoningTransformForModel({ effectiveTransport: "openai-responses", reasoningDisplayMode: "unknown" }), /Invalid Node model contract/);
});

test("non-prefix final closes the visible lifecycle before one safe mismatch observation", async () => {
  const observations = [];
  const source = [
    { type: "response.output_item.added", output_index: 0, item: { id: "rs_mismatch", type: "reasoning" } },
    { type: "response.reasoning_summary_part.added", output_index: 0, item_id: "rs_mismatch", summary_index: 0, part: { type: "summary_text", text: "" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_mismatch", summary_index: 0, delta: "visible" },
    { type: "response.output_item.done", output_index: 0, item: { id: "rs_mismatch", type: "reasoning", summary: [{ type: "summary_text", text: "conflict" }], content: [] } },
    { type: "response.completed", response: { output: [{ id: "rs_mismatch", type: "reasoning", summary: [{ type: "summary_text", text: "conflict" }], content: [] }] } },
  ];
  const output = events(await transform(source.map(sse), {
    responseId: "resp_mismatch",
    model: model(),
    observeReasoningProtocol: (event) => observations.push(event),
  }));
  assert.deepEqual(output.filter((event) => event.type.includes("summary") || event.type === "response.output_item.done").map((event) => event.type), [
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
  ]);
  assert.equal(output.find((event) => event.type === "response.output_item.done").item.summary[0].text, "visible");
  assert.deepEqual(observations.map((event) => event.code), ["reasoning_final_mismatch"]);
  assert.equal(JSON.stringify(observations).includes("visible"), false);
  assert.equal(JSON.stringify(observations).includes("conflict"), false);
});

test("reasoning item events require matching nonempty IDs, output indexes, and wire-ordered parts", async () => {
  const base = { type: "response.output_item.added", output_index: 0, item: { id: "rs_order", type: "reasoning" } };
  for (const [code, source] of [
    ["reasoning_duplicate_item", [{ ...base }, { ...base, output_index: 1, item: { id: "", type: "reasoning" } }]],
    ["reasoning_index_mismatch", [{ ...base }, { type: "response.reasoning_summary_part.added", output_index: 1, item_id: "rs_order", summary_index: 0, part: { type: "summary_text", text: "" } }]],
    ["reasoning_index_mismatch", [{ ...base }, { type: "response.reasoning_summary_part.added", output_index: 0, item_id: "rs_order", summary_index: 1, part: { type: "summary_text", text: "" } }]],
  ]) {
    await assert.rejects(() => transform(source.map(sse), { responseId: "resp_identity", model: model() }), { code });
  }
});

test("upstream part-done has one delayed downstream close and rejects reverse or post-done deltas", async () => {
  const open = { type: "response.output_item.added", output_index: 0, item: { id: "rs_part_done", type: "reasoning" } };
  const part = { type: "response.reasoning_summary_part.added", output_index: 0, item_id: "rs_part_done", summary_index: 0, part: { type: "summary_text", text: "" } };
  const textDone = { type: "response.reasoning_summary_text.done", output_index: 0, item_id: "rs_part_done", summary_index: 0 };
  const partDone = { type: "response.reasoning_summary_part.done", output_index: 0, item_id: "rs_part_done", summary_index: 0 };
  await assert.rejects(() => transform([open, part, partDone].map(sse), { responseId: "resp_reverse", model: model() }), { code: "reasoning_duplicate_done" });
  await assert.rejects(() => transform([open, part, textDone, partDone, { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_part_done", summary_index: 0, delta: "late" }].map(sse), { responseId: "resp_late", model: model() }), { code: "reasoning_delta_after_done" });
  const output = events(await transform([open, part, textDone, partDone,
    { type: "response.output_item.done", output_index: 0, item: { id: "rs_part_done", type: "reasoning", summary: [{ type: "summary_text", text: "" }], content: [] } },
    { type: "response.completed", response: { output: [{ id: "rs_part_done", type: "reasoning", summary: [{ type: "summary_text", text: "" }], content: [] }] } },
  ].map(sse), { responseId: "resp_done", model: model() }));
  assert.equal(output.filter((event) => event.type === "response.reasoning_summary_part.done").length, 1);
});

test("preserves trusted reasoning envelopes while clearing raw thinking and module-owns statuses", async () => {
  const envelope = "cr.reasoning.v1.placeholder";
  const source = [
    { type: "response.output_item.added", output_index: 0, item: { id: "rs_envelope", type: "reasoning", status: "completed", encrypted_content: envelope, thinking: [{ type: "thinking", text: "private" }] } },
    { type: "response.output_item.done", output_index: 0, item: { id: "rs_envelope", type: "reasoning", status: "failed", summary: [], content: [] } },
    { type: "response.completed", response: { output: [{ id: "rs_envelope", type: "reasoning", status: "failed", summary: [], content: [] }] } },
  ];
  const output = events(await transform(source.map(sse), { responseId: "resp_envelope", model: model() }));
  const added = output.find((event) => event.type === "response.output_item.added");
  const done = output.find((event) => event.type === "response.output_item.done");
  assert.equal(added.item.status, "in_progress");
  assert.equal(done.item.status, "completed");
  assert.equal(done.item.encrypted_content, envelope);
  assert.equal("thinking" in done.item, false);
  assert.equal(JSON.stringify(output.at(-1).response.output[0]).includes("private"), false);
});

test("SSE framer accepts multiline CR data and preserves unknown bytes across chunk boundaries", async () => {
  const unknown = Buffer.from("event: provider\rdata: {\"type\":\"provider.unknown\",\"note\":\"keep\"}\r\r", "utf8");
  const target = Buffer.from(
    "event: response.output_item.added\rdata: {\"type\":\"response.output_item.added\",\rdata: \"output_index\":0,\rdata: \"item\":{\"id\":\"rs_cr\",\"type\":\"reasoning\"}}\r\r",
    "utf8",
  );
  const terminal = Buffer.from(sse({ type: "response.completed", response: { output: [{ id: "rs_cr", type: "reasoning", summary: [], content: [] }] } }), "utf8");
  const input = Buffer.concat([unknown, target, terminal]);
  const output = await transform([...input].map((byte) => Buffer.from([byte])), { responseId: "resp_cr", model: model() });
  assert.deepEqual(Buffer.from(output, "utf8").subarray(0, unknown.length), unknown);
  assert.equal(events(output).some((event) => event.type === "response.output_item.done"), true);
});

test("empty, done-only, and over-limit frames fail safely while post-terminal data is observed", async () => {
  for (const body of [[], ["data: [DONE]\n\n"]]) {
    await assert.rejects(() => transform(body, { responseId: "resp_empty", model: model() }), { code: "upstream_stream_truncated" });
  }
  await assert.rejects(
    () => transform(["data: {\"type\":\"provider.unknown\",\"payload\":\"12345\"}\n\n"], { responseId: "resp_limit", model: model(), maxPendingFrameBytes: 32 }),
    { code: "reasoning_limit_exceeded" },
  );
  const observed = [];
  await transform([
    sse({ type: "response.completed", response: { output: [] } }),
    sse({ type: "provider.after_terminal", value: 1 }),
  ], { responseId: "resp_terminal", model: model(), observeReasoningProtocol: (event) => observed.push(event) });
  assert.deepEqual(observed.map((event) => event.code), ["event_after_terminal"]);
});

test("terminal finals and non-streaming anonymous items match one-to-one without collisions", async () => {
  const start = [
    { type: "response.output_item.added", output_index: 0, item: { id: "rs_0", type: "reasoning" } },
    { type: "response.output_item.added", output_index: 1, item: { id: "rs_1", type: "reasoning" } },
  ];
  for (const terminal of [
    { output: [{ id: "rs_0", type: "reasoning", summary: [], content: [] }] },
    { output: [{ id: "rs_unknown", type: "reasoning", summary: [], content: [] }, { id: "rs_0", type: "reasoning", summary: [], content: [] }] },
    { output: [{ id: "rs_0", type: "reasoning", summary: [], content: [] }, { id: "rs_0", type: "reasoning", summary: [], content: [] }] },
  ]) {
    await assert.rejects(() => transform([...start, { type: "response.completed", response: terminal }].map(sse), { responseId: "resp_terminal_identity", model: model() }), { code: "reasoning_unclosed_at_terminal" });
  }
  const normalized = normalizeReasoningResponse({ id: "resp_anonymous", output: [
    { type: "reasoning", summary: [], content: [] },
    { type: "reasoning", summary: [], content: [] },
  ] }, model());
  assert.equal(new Set(normalized.output.map((item) => item.id)).size, 2);
  assert.deepEqual(normalized.output.map((item) => item.content), [[], []]);
  assert.throws(() => normalizeReasoningResponse({ output: [
    { id: "rs_same", type: "reasoning", output_index: 0, summary: [], content: [] },
    { id: "rs_same", type: "reasoning", output_index: 1, summary: [], content: [] },
  ] }, model()), { code: "reasoning_duplicate_item" });
});
