import { createHash } from "node:crypto";

const MAX_PENDING_FRAME_BYTES = 256 * 1024;
const MAX_REASONING_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS = 1_024;
const MAX_PARTS = 1_024;
const MAX_WORK = 65_536;

export class ReasoningProtocolError extends Error {
  constructor(code) { super(code); this.name = "ReasoningProtocolError"; this.code = code; }
}
const fail = (code) => { throw new ReasoningProtocolError(code); };
const nonempty = (value, code = "reasoning_duplicate_item") => {
  if (typeof value !== "string" || !value) fail(code);
  return value;
};
const indexOf = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) fail("reasoning_index_mismatch");
  return value;
};
const generatedId = (responseId, outputIndex) => `rsn_${createHash("sha256").update(`${responseId}:${outputIndex}`).digest("base64url").slice(0, 24)}`;

function finalPart(part, type) {
  if (!part || typeof part !== "object" || part.type !== type || typeof part.text !== "string") fail("reasoning_final_mismatch");
  return part.text;
}

export function selectedFinalParts(sourceKind, item) {
  if (!item || typeof item !== "object") fail("reasoning_final_mismatch");
  if (sourceKind === "raw-content") {
    if (!Array.isArray(item.content) || !Array.isArray(item.summary) || item.summary.length) fail("reasoning_final_mismatch");
    return item.content.map((part) => finalPart(part, "reasoning_text"));
  }
  if (sourceKind === "provider-summary" || sourceKind === "hybrid-summary") {
    if (!Array.isArray(item.summary) || !Array.isArray(item.content) || item.content.length) fail("reasoning_final_mismatch");
    return item.summary.map((part) => finalPart(part, "summary_text"));
  }
  if (sourceKind === "anthropic-thinking") {
    const thinking = Array.isArray(item.thinking) ? item.thinking : item.content;
    if (!Array.isArray(thinking)) fail("reasoning_final_mismatch");
    return thinking.map((part) => finalPart(part, "thinking"));
  }
  fail("reasoning_final_mismatch");
}

function mode(model) {
  if (!["summary-compat", "raw-preserve"].includes(model?.reasoningDisplayMode)) {
    throw new Error("Invalid Node model contract: reasoningDisplayMode must be one of summary-compat, raw-preserve");
  }
  return model.reasoningDisplayMode;
}
function shape(model, supplied) {
  const value = supplied ?? model?.effectiveFinalReasoningShape ?? model?.finalReasoningShape;
  if (!["raw-content", "provider-summary", "hybrid-summary", "anthropic-thinking"].includes(value)) fail("reasoning_final_mismatch");
  return value;
}
function canonicalItem(source, id, summary, status) {
  const safe = source && typeof source === "object" ? source : {};
  const envelope = typeof safe.encrypted_content === "string" ? safe.encrypted_content : undefined;
  const { thinking: _thinking, reasoning_content: _reasoning, content: _content, summary: _summary, status: _status, encrypted_content: _envelope, ...rest } = safe;
  return { ...rest, id, type: "reasoning", status, summary: summary.map((text) => ({ type: "summary_text", text })), content: [], ...(envelope === undefined ? {} : { encrypted_content: envelope }) };
}
function frame(type, payload, eol = "\n") { return Buffer.from(`data: ${JSON.stringify({ type, ...payload })}${eol}${eol}`, "utf8"); }
function parseSse(raw) {
  const text = raw.toString("utf8");
  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
  const body = text.endsWith(`${eol}${eol}`) ? text.slice(0, -eol.length * 2) : text;
  const data = [];
  for (const line of body.split(/\r\n|\n|\r/)) if (line.startsWith("data:")) data.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5));
  if (!data.length) return null;
  const value = data.join("\n");
  if (value === "[DONE]") return { done: true, eol };
  try { return { event: JSON.parse(value), eol }; } catch { return null; }
}

class Framer {
  #chunks = []; #bytes = 0; #tail = ""; #limit;
  constructor(limit) { this.#limit = limit; }
  push(chunk, emit) {
    let start = 0;
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const next = this.#tail + String.fromCharCode(chunk[offset]);
      const boundary = next.endsWith("\n\n") || next.endsWith("\r\r") || next.endsWith("\r\n\r\n");
      this.#tail = next.slice(-3);
      if (!boundary) continue;
      this.#append(chunk.subarray(start, offset + 1));
      emit(Buffer.concat(this.#chunks));
      this.#chunks = []; this.#bytes = 0; this.#tail = ""; start = offset + 1;
    }
    if (start < chunk.length) this.#append(chunk.subarray(start));
  }
  #append(chunk) {
    if (!chunk.length) return;
    this.#bytes += chunk.length;
    if (this.#bytes > this.#limit) fail("reasoning_limit_exceeded");
    this.#chunks.push(chunk);
  }
  finish() { return this.#bytes > 0; }
}

export function createRawPreserveTransform() {
  return new TransformStream({ transform(chunk, controller) { controller.enqueue(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)); } });
}
export function normalizeRawReasoningResponse(json) { return json; }

export function createReasoningCompatTransform({
  responseId = "resp_unknown", model, finalShape, observeReasoningProtocol,
  maxPendingFrameBytes = MAX_PENDING_FRAME_BYTES, maxReasoningBytes = MAX_REASONING_BYTES,
  maxItems = MAX_ITEMS, maxParts = MAX_PARTS, maxWork = MAX_WORK, signal,
} = {}) {
  mode(model);
  const sourceKind = shape(model, finalShape);
  if (!Number.isSafeInteger(maxPendingFrameBytes) || maxPendingFrameBytes < 1) fail("reasoning_limit_exceeded");
  const items = new Map(); const byIndex = new Map(); const framer = new Framer(maxPendingFrameBytes);
  let terminal = false; let canceled = Boolean(signal?.aborted); let frames = 0; let bytes = 0; let work = 0;
  const observe = (code, item, extra = {}) => {
    try { observeReasoningProtocol?.(Object.freeze({ code, ...(item ? { outputIndex: item.outputIndex } : {}), ...extra })); } catch {}
  };
  const spend = (count = 0, units = 1) => {
    bytes += count; work += units;
    if (bytes > maxReasoningBytes || work > maxWork) fail("reasoning_limit_exceeded");
  };
  const partText = (part) => part.chunks.join("");
  const addText = (part, value, suffix = false) => {
    if (typeof value !== "string") fail("reasoning_final_mismatch");
    if (part.closed || ((part.upstreamPartDone || part.textDone) && !suffix)) fail("reasoning_delta_after_done");
    spend(Buffer.byteLength(value)); part.chunks.push(value);
  };
  const requireItem = (id, outputIndex, reason = "reasoning_delta_without_item") => {
    const item = items.get(nonempty(id, reason));
    if (!item) fail(reason);
    if (indexOf(outputIndex) !== item.outputIndex) fail("reasoning_index_mismatch");
    if (item.closed) fail("reasoning_delta_after_done");
    return item;
  };
  const addPart = (item, summaryIndex, eol, controller) => {
    const index = indexOf(summaryIndex);
    if (item.parts.has(index)) fail("reasoning_duplicate_part");
    if (index !== item.nextPartIndex) fail("reasoning_index_mismatch");
    if (item.parts.size >= maxParts) fail("reasoning_limit_exceeded");
    spend();
    const part = { index, chunks: [], textDone: false, upstreamPartDone: false, closed: false };
    item.nextPartIndex += 1; item.parts.set(index, part);
    controller.enqueue(frame("response.reasoning_summary_part.added", { output_index: item.outputIndex, item_id: item.id, summary_index: index, part: { type: "summary_text", text: "" } }, eol));
    return part;
  };
  const closePart = (item, part, eol, controller) => {
    if (part.closed) return;
    part.textDone = true; part.closed = true;
    const text = partText(part);
    controller.enqueue(frame("response.reasoning_summary_text.done", { output_index: item.outputIndex, item_id: item.id, summary_index: part.index, text }, eol));
    controller.enqueue(frame("response.reasoning_summary_part.done", { output_index: item.outputIndex, item_id: item.id, summary_index: part.index, part: { type: "summary_text", text } }, eol));
  };
  const closeItem = (item, source, status, eol, controller) => {
    if (item.closed) return;
    item.closed = true; item.summary = [...item.parts.values()].map(partText);
    const basis = item.envelope && !source?.encrypted_content ? { ...source, encrypted_content: item.envelope } : source ?? item.source;
    item.pendingDone = () => controller.enqueue(frame("response.output_item.done", { output_index: item.outputIndex, item: canonicalItem(basis, item.id, item.summary, status) }, eol));
  };
  const flushDone = () => {
    for (;;) {
      const candidate = [...items.values()]
        .filter((item) => item.pendingDone)
        .sort((a, b) => a.outputIndex - b.outputIndex)
        .find((item) => ![...items.values()].some((other) => !other.closed && other.outputIndex < item.outputIndex));
      if (!candidate) return;
      const emit = candidate.pendingDone;
      candidate.pendingDone = null;
      emit();
    }
  };
  const start = (event, eol, controller) => {
    const outputIndex = indexOf(event.output_index); const id = nonempty(event.item?.id);
    if (items.has(id) || byIndex.has(outputIndex)) fail("reasoning_duplicate_item");
    if (items.size >= maxItems) fail("reasoning_limit_exceeded");
    spend();
    const item = { id, outputIndex, source: event.item, envelope: typeof event.item?.encrypted_content === "string" ? event.item.encrypted_content : undefined, parts: new Map(), nextPartIndex: 0, closed: false, summary: null, pendingDone: null, mismatchObserved: false };
    items.set(id, item); byIndex.set(outputIndex, item);
    controller.enqueue(frame("response.output_item.added", { output_index: outputIndex, item: canonicalItem(event.item, id, [], "in_progress") }, eol));
  };
  const reconcile = (item, finalItem, eol, controller) => {
    const parts = selectedFinalParts(sourceKind, finalItem);
    spend(parts.reduce((sum, value) => sum + Buffer.byteLength(value), 0));
    let mismatch = false;
    for (let index = 0; index < item.nextPartIndex; index += 1) {
      if (!item.parts.has(index)) fail("reasoning_index_mismatch");
      if (index >= parts.length) fail("reasoning_final_part_missing");
    }
    for (let index = 0; index < parts.length; index += 1) {
      let part = item.parts.get(index);
      if (!part) part = addPart(item, index, eol, controller);
      const emitted = partText(part);
      if (parts[index].startsWith(emitted)) {
        const suffix = parts[index].slice(emitted.length);
        if (suffix) {
          addText(part, suffix, true);
          controller.enqueue(frame("response.reasoning_summary_text.delta", { output_index: item.outputIndex, item_id: item.id, summary_index: index, delta: suffix }, eol));
        }
      } else mismatch = true;
      closePart(item, part, eol, controller);
    }
    closeItem(item, finalItem, "completed", eol, controller);
    flushDone();
    if (mismatch && !item.mismatchObserved) {
      item.mismatchObserved = true;
      observe("reasoning_final_mismatch", item, { partCount: parts.length });
    }
  };
  const partial = (item, eol, controller) => {
    if (item.closed) return;
    for (let index = 0; index < item.nextPartIndex; index += 1) closePart(item, item.parts.get(index), eol, controller);
    closeItem(item, item.source, "incomplete", eol, controller);
  };
  const ensureFinal = (event, eol, controller) => {
    const outputIndex = indexOf(event.output_index); const id = nonempty(event.item?.id);
    const existing = items.get(id);
    if (existing) {
      if (existing.outputIndex !== outputIndex) fail("reasoning_index_mismatch");
      if (existing.closed) fail("reasoning_duplicate_done");
      return existing;
    }
    if (byIndex.has(outputIndex)) fail("reasoning_duplicate_item");
    if (items.size >= maxItems) fail("reasoning_limit_exceeded");
    const item = { id, outputIndex, source: event.item, envelope: typeof event.item?.encrypted_content === "string" ? event.item.encrypted_content : undefined, parts: new Map(), nextPartIndex: 0, closed: false, summary: null, pendingDone: null, mismatchObserved: false };
    items.set(id, item); byIndex.set(outputIndex, item); spend();
    controller.enqueue(frame("response.output_item.added", { output_index: outputIndex, item: canonicalItem(event.item, id, [], "in_progress") }, eol));
    return item;
  };
  const terminalOutput = (event, eol, controller) => {
    const output = Array.isArray(event.response?.output) ? event.response.output : [];
    if (event.type === "response.completed") {
      const finals = output.filter((item) => item?.type === "reasoning"); const used = new Set(); const anonymous = [];
      for (const final of finals) {
        if (final.id === undefined || final.id === null) { anonymous.push(final); continue; }
        const item = items.get(nonempty(final.id));
        if (!item || used.has(item)) fail("reasoning_unclosed_at_terminal");
        if (final.output_index !== undefined && indexOf(final.output_index) !== item.outputIndex) fail("reasoning_index_mismatch");
        used.add(item);
        if (!item.closed) reconcile(item, final, eol, controller);
        else if (JSON.stringify(item.summary) !== JSON.stringify(selectedFinalParts(sourceKind, final)) && !item.mismatchObserved) {
          item.mismatchObserved = true;
          observe("reasoning_final_mismatch", item, { partCount: item.summary.length });
        }
      }
      const candidates = [...items.values()].filter((item) => !used.has(item)).sort((a, b) => a.outputIndex - b.outputIndex);
      if (anonymous.length !== candidates.length) fail("reasoning_unclosed_at_terminal");
      for (let index = 0; index < anonymous.length; index += 1) {
        const item = candidates[index]; const final = anonymous[index];
        if (final.output_index !== undefined && indexOf(final.output_index) !== item.outputIndex) fail("reasoning_index_mismatch");
        if (!item.closed) reconcile(item, final, eol, controller);
      }
    } else for (const item of [...items.values()].sort((a, b) => a.outputIndex - b.outputIndex)) partial(item, eol, controller);
    flushDone();
    const anonymousStates = [...items.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    const rewritten = output.map((item) => {
      if (item?.type !== "reasoning") return item;
      const state = item.id ? items.get(item.id) : anonymousStates.shift();
      if (!state) fail("reasoning_unclosed_at_terminal");
      const basis = state.envelope && !item.encrypted_content ? { ...item, encrypted_content: state.envelope } : item;
      return canonicalItem(basis, state.id, state.summary ?? [], event.type === "response.completed" ? "completed" : "incomplete");
    });
    terminal = true;
    controller.enqueue(frame(event.type, { ...event, response: { ...event.response, output: rewritten } }, eol));
  };
  const process = (raw, controller) => {
    frames += 1; if (frames > maxWork) fail("reasoning_limit_exceeded");
    const parsed = parseSse(raw);
    if (terminal) { if (parsed?.event) observe("event_after_terminal"); return; }
    if (!parsed || parsed.done) { controller.enqueue(raw); return; }
    const event = parsed.event; const eol = parsed.eol;
    if (event?.type === "response.output_item.added" && event.item?.type === "reasoning") return start(event, eol, controller);
    if (event?.type === "response.reasoning_summary_part.added") return addPart(requireItem(event.item_id, event.output_index, "reasoning_part_without_item"), event.summary_index, eol, controller);
    if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event?.type)) {
      const item = requireItem(event.item_id, event.output_index); const index = indexOf(event.type === "response.reasoning_text.delta" ? event.content_index : event.summary_index);
      let part = item.parts.get(index);
      if (!part) { if (event.type !== "response.reasoning_text.delta") fail("reasoning_part_without_item"); part = addPart(item, index, eol, controller); }
      addText(part, event.delta);
      controller.enqueue(frame("response.reasoning_summary_text.delta", { output_index: item.outputIndex, item_id: item.id, summary_index: index, delta: event.delta }, eol)); return;
    }
    if (event?.type === "response.reasoning_summary_text.done") {
      const item = requireItem(event.item_id, event.output_index); const part = item.parts.get(indexOf(event.summary_index));
      if (!part) fail("reasoning_part_without_item"); if (part.textDone || part.upstreamPartDone || part.closed) fail("reasoning_duplicate_done"); part.textDone = true; return;
    }
    if (event?.type === "response.reasoning_summary_part.done") {
      const item = requireItem(event.item_id, event.output_index); const part = item.parts.get(indexOf(event.summary_index));
      if (!part || !part.textDone || part.upstreamPartDone || part.closed) fail("reasoning_duplicate_done"); part.upstreamPartDone = true; return;
    }
    if (event?.type === "response.output_item.done" && event.item?.type === "reasoning") return reconcile(ensureFinal(event, eol, controller), event.item, eol, controller);
    if (["response.completed", "response.incomplete", "response.failed"].includes(event?.type)) return terminalOutput(event, eol, controller);
    controller.enqueue(raw);
  };
  signal?.addEventListener?.("abort", () => { canceled = true; }, { once: true });
  return new TransformStream({
    transform(chunk, controller) { if (!canceled) framer.push(chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(chunk), (raw) => process(raw, controller)); },
    flush() { if (!canceled && (framer.finish() || !terminal)) fail("upstream_stream_truncated"); },
  });
}

export function normalizeReasoningResponse(json, model) {
  if (mode(model) === "raw-preserve") return normalizeRawReasoningResponse(json);
  const sourceKind = shape(model);
  if (!json || typeof json !== "object" || !Array.isArray(json.output)) return json;
  const indexes = new Set(); const ids = new Set();
  return { ...json, output: json.output.map((item, arrayIndex) => {
    if (item?.type !== "reasoning") return item;
    const outputIndex = item.output_index === undefined ? arrayIndex : indexOf(item.output_index);
    if (indexes.has(outputIndex)) fail("reasoning_index_mismatch"); indexes.add(outputIndex);
    const id = item.id === undefined || item.id === null ? generatedId(String(json.id || "resp_unknown"), outputIndex) : nonempty(item.id);
    if (ids.has(id)) fail("reasoning_duplicate_item"); ids.add(id);
    return canonicalItem(item, id, selectedFinalParts(sourceKind, item), "completed");
  }) };
}
export function reasoningTransformForModel(model, options = {}) {
  if (model?.effectiveTransport === "native-openai") return undefined;
  return mode(model) === "raw-preserve" ? createRawPreserveTransform() : createReasoningCompatTransform({ ...options, model });
}
