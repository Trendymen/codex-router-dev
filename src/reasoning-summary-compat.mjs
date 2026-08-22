import { createHash } from "node:crypto";

const MAX_ITEMS = 1_024;
const MAX_PARTS_PER_ITEM = 1_024;
const MAX_PART_TEXT_BYTES = 8 * 1024 * 1024;

export class ReasoningProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReasoningProtocolError";
    this.code = code;
  }
}

function protocol(code) {
  return new ReasoningProtocolError(code);
}

function exactArray(value) {
  return Array.isArray(value) ? value : null;
}

function textPart(part, type) {
  if (!part || typeof part !== "object" || part.type !== type || typeof part.text !== "string") {
    throw protocol("reasoning_final_mismatch");
  }
  return part.text;
}

function emptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

// This is deliberately the sole final-shape selector for streaming and JSON
// responses. Shape is a provider contract, never inferred from received deltas.
export function selectedFinalParts(sourceKind, finalItem) {
  if (!finalItem || typeof finalItem !== "object") throw protocol("reasoning_final_mismatch");
  if (sourceKind === "raw-content") {
    const content = exactArray(finalItem.content);
    if (!content || !emptyArray(finalItem.summary)) throw protocol("reasoning_final_mismatch");
    return content.map((part) => textPart(part, "reasoning_text"));
  }
  if (sourceKind === "provider-summary" || sourceKind === "hybrid-summary") {
    const summary = exactArray(finalItem.summary);
    if (!summary || !emptyArray(finalItem.content)) throw protocol("reasoning_final_mismatch");
    return summary.map((part) => textPart(part, "summary_text"));
  }
  if (sourceKind === "anthropic-thinking") {
    const thinking = exactArray(finalItem.thinking) ?? exactArray(finalItem.content);
    if (!thinking) throw protocol("reasoning_final_mismatch");
    return thinking.map((part) => textPart(part, "thinking"));
  }
  throw protocol("reasoning_final_mismatch");
}

function generatedItemId(responseId, outputIndex) {
  return `rsn_${createHash("sha256").update(`${responseId}:${outputIndex}`).digest("base64url").slice(0, 24)}`;
}

function canonicalItem(item, id, summary, status = "completed") {
  const { thinking: _thinking, reasoning_content: _reasoningContent, encrypted_content: _encryptedContent, ...base } =
    item && typeof item === "object" ? item : {};
  return {
    ...base,
    id,
    type: "reasoning",
    status: item?.status || status,
    summary: summary.map((text) => ({ type: "summary_text", text })),
    content: [],
  };
}

function parseBlock(bytes) {
  const text = bytes.toString("utf8");
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith("data:"));
  if (index < 0) return null;
  const value = lines[index].slice(5).trimStart();
  if (!value || value === "[DONE]") return null;
  try {
    return { lines, index, newline: text.includes("\r\n") ? "\r\n" : "\n", event: JSON.parse(value) };
  } catch {
    return null;
  }
}

function writeBlock(parsed, event) {
  const lines = [...parsed.lines];
  lines[parsed.index] = `data: ${JSON.stringify(event)}`;
  return Buffer.from(lines.join(parsed.newline), "utf8");
}

function synthesize(parsed, type, event) {
  const lines = parsed.lines.some((line) => line.startsWith("event:")) ? [`event: ${type}`] : [];
  lines.push(`data: ${JSON.stringify({ type, ...event })}`);
  return Buffer.from(`${lines.join(parsed.newline)}${parsed.newline}${parsed.newline}`, "utf8");
}

function requireIndex(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_ITEMS * MAX_PARTS_PER_ITEM) {
    throw protocol("reasoning_index_mismatch");
  }
  return value;
}

function requireText(value) {
  if (typeof value !== "string") throw protocol("reasoning_final_mismatch");
  return value;
}

function contiguous(indices) {
  const ordered = [...indices].sort((left, right) => left - right);
  return ordered.every((index, expected) => index === expected);
}

function displayMode(model) {
  const mode = model?.reasoningDisplayMode;
  if (mode !== "summary-compat" && mode !== "raw-preserve") {
    throw new Error("Invalid Node model contract: reasoningDisplayMode must be one of summary-compat, raw-preserve");
  }
  return mode;
}

function finalShape(model, supplied) {
  const shape = supplied ?? model?.effectiveFinalReasoningShape ?? model?.finalReasoningShape;
  if (!["raw-content", "provider-summary", "hybrid-summary", "anthropic-thinking"].includes(shape)) {
    throw protocol("reasoning_final_mismatch");
  }
  return shape;
}

export function createRawPreserveTransform() {
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
    },
  });
}

export function normalizeRawReasoningResponse(json) {
  return json;
}

export function createReasoningCompatTransform({ responseId, model, finalShape: suppliedFinalShape } = {}) {
  displayMode(model);
  const shape = finalShape(model, suppliedFinalShape);
  const items = new Map();
  const indexes = new Map();
  let terminal = false;
  let sawEvent = false;
  let buffer = Buffer.alloc(0);

  function itemId(event, outputIndex) {
    const id = event?.item?.id ?? event?.item_id;
    if (typeof id === "string" && id) return id;
    return generatedItemId(String(responseId || "resp_unknown"), outputIndex);
  }

  function stateFor(id, part = false) {
    const item = items.get(id);
    if (!item) throw protocol(part ? "reasoning_part_without_item" : "reasoning_delta_without_item");
    if (item.done) throw protocol("reasoning_delta_after_done");
    return item;
  }

  function start(event, parsed) {
    const outputIndex = requireIndex(event.output_index);
    const id = itemId(event, outputIndex);
    if (items.has(id) || indexes.has(outputIndex)) throw protocol("reasoning_duplicate_item");
    if (items.size >= MAX_ITEMS) throw protocol("reasoning_index_mismatch");
    const item = { id, outputIndex, initial: event.item, parts: new Map(), done: false, queued: null };
    items.set(id, item);
    indexes.set(outputIndex, id);
    return writeBlock(parsed, {
      ...event,
      output_index: outputIndex,
      item: canonicalItem(event.item, id, [], "in_progress"),
    });
  }

  function startPart(item, index, parsed, event, controller) {
    requireIndex(index);
    if (item.parts.has(index)) throw protocol("reasoning_duplicate_part");
    if (item.parts.size >= MAX_PARTS_PER_ITEM) throw protocol("reasoning_index_mismatch");
    const part = { index, text: "", textDone: false, done: false };
    item.parts.set(index, part);
    controller.enqueue(synthesize(parsed, "response.reasoning_summary_part.added", {
      output_index: item.outputIndex,
      item_id: item.id,
      summary_index: index,
      part: { type: "summary_text", text: "" },
    }));
    return part;
  }

  function append(part, delta, allowDelayedDone = false) {
    if (part.done || (part.textDone && !allowDelayedDone)) throw protocol("reasoning_delta_after_done");
    const text = requireText(delta);
    if (Buffer.byteLength(part.text) + Buffer.byteLength(text) > MAX_PART_TEXT_BYTES) {
      throw protocol("reasoning_final_mismatch");
    }
    part.text += text;
  }

  function delayedTextDone(item, index) {
    const part = item.parts.get(index);
    if (!part) throw protocol("reasoning_part_without_item");
    if (part.textDone) throw protocol("reasoning_duplicate_done");
    part.textDone = true;
  }

  function closePart(item, part, parsed, controller) {
    if (part.done) throw protocol("reasoning_duplicate_done");
    part.textDone = true;
    part.done = true;
    controller.enqueue(synthesize(parsed, "response.reasoning_summary_text.done", {
      output_index: item.outputIndex,
      item_id: item.id,
      summary_index: part.index,
      text: part.text,
    }));
    controller.enqueue(synthesize(parsed, "response.reasoning_summary_part.done", {
      output_index: item.outputIndex,
      item_id: item.id,
      summary_index: part.index,
      part: { type: "summary_text", text: part.text },
    }));
  }

  function queueItemDone(item, finalItem, parsed, controller, status = "completed") {
    item.done = true;
    const summary = [...item.parts.values()].sort((left, right) => left.index - right.index).map((part) => part.text);
    item.queued = () => controller.enqueue(synthesize(parsed, "response.output_item.done", {
      output_index: item.outputIndex,
      item: canonicalItem(finalItem ?? item.initial, item.id, summary, status),
    }));
  }

  function flushQueued(controller) {
    for (;;) {
      const queued = [...items.values()]
        .filter((item) => item.queued)
        .sort((left, right) => left.outputIndex - right.outputIndex);
      const next = queued.find((item) => ![...items.values()].some((other) => !other.done && other.outputIndex < item.outputIndex));
      if (!next) return;
      const queuedEmit = next.queued;
      next.queued = null;
      queuedEmit(controller);
    }
  }

  function ensureFinalItem(event, parsed, controller) {
    const outputIndex = requireIndex(event.output_index);
    const id = itemId(event, outputIndex);
    let item = items.get(id);
    if (!item) {
      if (indexes.has(outputIndex)) throw protocol("reasoning_duplicate_item");
      if (items.size >= MAX_ITEMS) throw protocol("reasoning_index_mismatch");
      item = { id, outputIndex, initial: event.item, parts: new Map(), done: false, queued: null };
      items.set(id, item);
      indexes.set(outputIndex, id);
      controller.enqueue(synthesize(parsed, "response.output_item.added", {
        output_index: outputIndex,
        item: canonicalItem(event.item, id, [], "in_progress"),
      }));
    }
    if (item.done) throw protocol("reasoning_duplicate_done");
    return item;
  }

  function closeWithFinal(event, parsed, controller) {
    const item = ensureFinalItem(event, parsed, controller);
    const finalParts = selectedFinalParts(shape, event.item);
    if (!contiguous(item.parts.keys())) throw protocol("reasoning_index_mismatch");
    for (const index of item.parts.keys()) {
      if (index >= finalParts.length) throw protocol("reasoning_final_part_missing");
    }
    for (let index = 0; index < finalParts.length; index += 1) {
      let part = item.parts.get(index);
      if (!part) part = startPart(item, index, parsed, event, controller);
      const finalText = finalParts[index];
      if (!finalText.startsWith(part.text)) throw protocol("reasoning_final_mismatch");
      const suffix = finalText.slice(part.text.length);
      if (suffix) {
        append(part, suffix, true);
        controller.enqueue(synthesize(parsed, "response.reasoning_summary_text.delta", {
          output_index: item.outputIndex,
          item_id: item.id,
          summary_index: index,
          delta: suffix,
        }));
      }
      closePart(item, part, parsed, controller);
    }
    queueItemDone(item, event.item, parsed, controller);
    flushQueued(controller);
  }

  function closePartial(item, parsed, controller, status = "incomplete") {
    if (item.done) return;
    if (!contiguous(item.parts.keys())) throw protocol("reasoning_index_mismatch");
    for (const part of [...item.parts.values()].sort((left, right) => left.index - right.index)) {
      closePart(item, part, parsed, controller);
    }
    queueItemDone(item, item.initial, parsed, controller, status);
  }

  function terminalEvent(event, parsed, controller) {
    const type = event.type;
    const output = Array.isArray(event.response?.output) ? event.response.output : [];
    const anonymousFinals = [];
    const finals = new Map();
    for (const item of output.filter((candidate) => candidate?.type === "reasoning")) {
      if (typeof item.id === "string" && item.id) finals.set(item.id, item);
      else anonymousFinals.push(item);
    }
    const anonymousStates = [...items.values()].sort((left, right) => left.outputIndex - right.outputIndex);
    if (type === "response.completed") {
      for (const item of [...items.values()].filter((item) => !item.done).sort((left, right) => left.outputIndex - right.outputIndex)) {
        const finalItem = finals.get(item.id) ?? anonymousFinals.shift();
        if (!finalItem) throw protocol("reasoning_unclosed_at_terminal");
        closeWithFinal({ output_index: item.outputIndex, item: finalItem }, parsed, controller);
      }
    } else {
      for (const item of [...items.values()].sort((left, right) => left.outputIndex - right.outputIndex)) closePartial(item, parsed, controller);
    }
    flushQueued(controller);
    const normalizedOutput = output.map((item) => {
      if (item?.type !== "reasoning") return item;
      const id = typeof item.id === "string" && item.id ? item.id : undefined;
      const state = (id && items.get(id)) ?? anonymousStates.shift();
      return state
        ? canonicalItem(item, state.id, [...state.parts.values()].sort((left, right) => left.index - right.index).map((part) => part.text), type === "response.completed" ? "completed" : "incomplete")
        : item;
    });
    terminal = true;
    if (!event.response || normalizedOutput === output) {
      controller.enqueue(Buffer.from(parsed.lines.join(parsed.newline), "utf8"));
      return;
    }
    controller.enqueue(writeBlock(parsed, { ...event, response: { ...event.response, output: normalizedOutput } }));
  }

  function handle(parsed, controller) {
    const event = parsed.event;
    const type = event?.type;
    if (terminal) return;
    sawEvent = true;
    if (type === "response.output_item.added" && event.item?.type === "reasoning") {
      controller.enqueue(start(event, parsed));
      return;
    }
    if (type === "response.reasoning_summary_part.added") {
      const item = stateFor(String(event.item_id), true);
      const index = requireIndex(event.summary_index);
      startPart(item, index, parsed, event, controller);
      return;
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const item = stateFor(String(event.item_id));
      const index = requireIndex(type === "response.reasoning_text.delta" ? event.content_index : event.summary_index);
      let part = item.parts.get(index);
      if (!part) {
        if (type !== "response.reasoning_text.delta") throw protocol("reasoning_part_without_item");
        part = startPart(item, index, parsed, event, controller);
      }
      append(part, event.delta);
      controller.enqueue(synthesize(parsed, "response.reasoning_summary_text.delta", {
        output_index: item.outputIndex,
        item_id: item.id,
        summary_index: index,
        delta: event.delta,
      }));
      return;
    }
    if (type === "response.reasoning_summary_text.done") {
      delayedTextDone(stateFor(String(event.item_id)), requireIndex(event.summary_index));
      return;
    }
    if (type === "response.reasoning_summary_part.done") return;
    if (type === "response.output_item.done" && event.item?.type === "reasoning") {
      closeWithFinal(event, parsed, controller);
      return;
    }
    if (["response.completed", "response.incomplete", "response.failed"].includes(type)) {
      terminalEvent(event, parsed, controller);
      return;
    }
    controller.enqueue(Buffer.from(parsed.lines.join(parsed.newline), "utf8"));
  }

  function emitBlocks(controller, flush = false) {
    for (;;) {
      const crlf = buffer.indexOf(Buffer.from("\r\n\r\n"));
      const lf = buffer.indexOf(Buffer.from("\n\n"));
      const at = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf;
      const separator = at === crlf ? 4 : 2;
      if (at < 0) {
        if (flush && buffer.length) {
          const remainder = buffer;
          buffer = Buffer.alloc(0);
          const parsed = parseBlock(remainder);
          if (parsed) handle(parsed, controller);
          else controller.enqueue(remainder);
        }
        if (flush && sawEvent && !terminal) throw protocol("upstream_stream_truncated");
        return;
      }
      const block = buffer.subarray(0, at);
      const terminator = buffer.subarray(at, at + separator);
      buffer = buffer.subarray(at + separator);
      const parsed = parseBlock(block);
      const terminalBefore = terminal;
      if (parsed) handle(parsed, controller);
      else controller.enqueue(block);
      if (!terminalBefore) controller.enqueue(terminator);
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer = Buffer.concat([buffer, chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk)]);
      emitBlocks(controller);
    },
    flush(controller) {
      emitBlocks(controller, true);
    },
  });
}

export function normalizeReasoningResponse(json, model) {
  if (displayMode(model) === "raw-preserve") return normalizeRawReasoningResponse(json);
  const shape = finalShape(model);
  if (!json || typeof json !== "object" || !Array.isArray(json.output)) return json;
  return {
    ...json,
    output: json.output.map((item) => {
      if (item?.type !== "reasoning") return item;
      const parts = selectedFinalParts(shape, item);
      return canonicalItem(item, item.id || generatedItemId(String(json.id || "resp_unknown"), item.output_index || 0), parts);
    }),
  };
}

export function reasoningTransformForModel(model, options = {}) {
  if (model?.effectiveTransport === "native-openai") return undefined;
  if (displayMode(model) === "raw-preserve") return createRawPreserveTransform();
  return createReasoningCompatTransform({ ...options, model });
}
