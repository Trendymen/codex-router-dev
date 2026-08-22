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
  return text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const line = block.split(/\r?\n/).find((part) => part.startsWith("data:"));
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
  "reasoning_final_mismatch",
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
    { code: "reasoning_index_mismatch" },
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
