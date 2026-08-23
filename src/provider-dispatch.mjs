import { adaptAnthropicMessages, buildAnthropicMessagesRequest } from "./anthropic-messages-adapter.mjs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { adaptOpenAIResponses, buildOpenAIResponsesRequest, createResponsesRelayContext } from "./openai-responses-adapter.mjs";
import { providerEndpoint } from "./provider-endpoint.mjs";
import { fetchWithRetry } from "./upstream-retry.mjs";
import { classifyRoutedFailure, FAILOVER_BUDGET_MS, MAX_FAILOVER_HOPS, providerCooldown, recordProviderCooldown } from "./model-failover.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";
import { estimateInputTokens } from "./response-usage.mjs";
import { proofMatchesModel } from "./model-contract.mjs";
import { readProtocolProof } from "./protocol-proof.mjs";
import { endpointForModel, resolveProviderBaseUrl } from "./model-registry.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { inputHasImage } from "./vision-bridge.mjs";
import { flattenNamespaceTools } from "./namespace-relay.mjs";
import { collaborationToolAvailable } from "./subagent-completion.mjs";

const PROTOCOL_PROBE_BYPASS = Symbol("protocol-probe-bypass");
const RAW_RESPONSE_ADAPTER_MODE = Symbol("raw-response-adapter-mode");

// Appendix D is intentionally independent of the native ChatGPT retry knobs.
// A routed request is cheap only until its first response byte is committed;
// after that point neither retry nor model failover can safely replay it.
export const DIRECT_RETRY_LIMIT = 2;
export const DIRECT_RETRY_BACKOFF_MS = 250;
export const DIRECT_RETRY_BUDGET_MS = 5_000;
export const PROTOCOL_PROOF_TIMEOUT_MS = 180_000;
export const PROTOCOL_PROOF_MAX_RAW_BYTES = 8 * 1024 * 1024;
export const PROTOCOL_PROOF_MAX_WORK = 3 * PROTOCOL_PROOF_MAX_RAW_BYTES + 65_536;

function probeLimit(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`invalid protocol proof ${label}`);
  }
  return value;
}

function probeResourceError(code, status) {
  return Object.assign(new Error(code), { code, status });
}

function callerAbortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The protocol proof was aborted by the caller.", "AbortError");
}

function createProtocolProbeResources(options) {
  const timeoutMs = probeLimit(options.timeoutMs, PROTOCOL_PROOF_TIMEOUT_MS, PROTOCOL_PROOF_TIMEOUT_MS, "timeout");
  const maxRawBytes = probeLimit(options.maxRawBytes, PROTOCOL_PROOF_MAX_RAW_BYTES, PROTOCOL_PROOF_MAX_RAW_BYTES, "raw byte limit");
  const maxWork = probeLimit(options.maxWork, PROTOCOL_PROOF_MAX_WORK, PROTOCOL_PROOF_MAX_WORK, "work limit");
  const callerSignal = options.signal;
  const controller = new AbortController();
  let rawBytes = 0;
  let work = 0;
  let abortKind;
  let abortReason;
  let callerListener;

  const abort = (kind, reason) => {
    if (controller.signal.aborted) return false;
    abortKind = kind;
    abortReason = reason;
    controller.abort(reason);
    return true;
  };
  if (callerSignal) {
    callerListener = () => abort("caller", callerAbortReason(callerSignal));
    if (callerSignal.aborted) callerListener();
    else callerSignal.addEventListener("abort", callerListener, { once: true });
  }
  const timer = setTimeout(
    () => abort("deadline", probeResourceError("protocol_probe_timeout", 504)),
    timeoutMs,
  );

  const failResource = () => {
    const error = probeResourceError("protocol_probe_resource_limit", 413);
    abort("resource", error);
    throw error;
  };
  return {
    signal: controller.signal,
    consumeBytes(count) {
      if (!Number.isSafeInteger(count) || count < 0) failResource();
      rawBytes += count;
      if (!Number.isSafeInteger(rawBytes) || rawBytes > maxRawBytes) failResource();
    },
    consumeWork(count = 1) {
      if (!Number.isSafeInteger(count) || count < 0) failResource();
      work += count;
      if (!Number.isSafeInteger(work) || work > maxWork) failResource();
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw abortReason || probeResourceError("protocol_probe_timeout", 504);
    },
    wait(operation) {
      this.throwIfAborted();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          callback(value);
        };
        const onAbort = () => finish(reject, abortReason || probeResourceError("protocol_probe_timeout", 504));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(operation).then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        );
      });
    },
    isCallerAbort() { return abortKind === "caller"; },
    safeErrorCode(error) {
      if (error?.code === "protocol_probe_timeout" || error?.code === "protocol_probe_resource_limit") return error.code;
      return "protocol_probe_transport_error";
    },
    close() {
      clearTimeout(timer);
      if (callerListener) callerSignal.removeEventListener("abort", callerListener);
    },
  };
}

export function parseRetryAfter(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
  }
  const date = Date.parse(text);
  if (!Number.isFinite(date)) return undefined;
  const seconds = Math.ceil((date - Date.now()) / 1_000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

const RESPONSES_MARKERS = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "reasoning",
  "compaction",
  "response.output_item.added",
  "response.output_text.delta",
]);

function cloneJson(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function modelWithBaseUrl(model, context = {}) {
  const baseUrl = context.baseUrl || model?.baseUrl;
  if (!baseUrl) throw new TypeError("Node model requires a provider baseUrl");
  return { ...model, baseUrl };
}

function transportRequest(model, payload, context) {
  const credential = context.credential;
  if (model.effectiveTransport === "openai-responses") {
    return buildOpenAIResponsesRequest({ model, payload, credential });
  }
  if (model.effectiveTransport === "anthropic-messages") {
    return buildAnthropicMessagesRequest({
      model,
      payload,
      credential,
      internalKey: context.internalKey,
      requestContext: context,
    });
  }
  if (model.effectiveTransport === "native-openai") {
    throw new TypeError("native-openai is not a routed provider transport");
  }
  throw new TypeError(`Unsupported routed transport: ${model.effectiveTransport}`);
}

/**
 * Build a provider request from the pristine caller payload. This function
 * deliberately has no retry/failover state and never mutates either argument;
 * every subsequent hop calls it again with the same pristine value.
 */
export function buildRoutedRequest(pristinePayload, model, context = {}) {
  if (!pristinePayload || typeof pristinePayload !== "object" || Array.isArray(pristinePayload)) {
    throw new TypeError("pristine payload must be an object");
  }
  if (!model || typeof model !== "object") throw new TypeError("routed model is required");
  if (!["native-openai", "openai-responses", "anthropic-messages"].includes(model.effectiveTransport)) {
    throw Object.assign(new Error("The selected model is not available in the Node router."), { code: "provider_not_available_in_node_build", status: 501 });
  }
  if (model.rolloutState === "experimental" && context.protocolProbeBypass !== PROTOCOL_PROBE_BYPASS && !proofMatchesModel(context.proof || readProtocolProof(model.slug), model)) {
    throw Object.assign(new Error("The selected canary model has no matching protocol proof."), { code: "model_not_enabled", status: 404 });
  }
  if (model.effectiveTransport === "native-openai") {
    const rawBody = context.rawBody;
    if (!Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) {
      throw new TypeError("native-openai dispatch requires the pristine raw body");
    }
    return Object.freeze({ model, pristinePayload, payload: pristinePayload, transport: "native-openai", body: Buffer.from(rawBody), url: context.url, headers: context.headers || {}, context: { ...context } });
  }
  const selected = modelWithBaseUrl(model, context);
  const payload = cloneJson(pristinePayload);
  const request = transportRequest(selected, payload, context);
  return Object.freeze({
    ...request,
    url: request.url instanceof URL ? request.url.href : request.url,
    model: selected,
    pristinePayload,
    payload,
    transport: selected.effectiveTransport,
    context: { ...context },
  });
}

function markerSet(input, out = new Set(), seen = new Set()) {
  if (!input || typeof input !== "object" || seen.has(input)) return out;
  seen.add(input);
  if (Array.isArray(input)) {
    for (const value of input) markerSet(value, out, seen);
    return out;
  }
  if (typeof input.type === "string" && RESPONSES_MARKERS.has(input.type)) out.add(input.type);
  for (const value of Object.values(input)) markerSet(value, out, seen);
  return out;
}

export function requestMarkers(payload) {
  return markerSet(payload);
}

/**
 * Return false for a candidate that would change the wire contract already
 * present in the caller's conversation. Native OpenAI is never a routed
 * failover candidate; Responses-only history also cannot cross into Chat.
 */
export function canFailoverTo(candidate, sourceModel, payload, { proof } = {}) {
  if (!candidate || !sourceModel) return false;
  if (!candidate.slug || candidate.slug === sourceModel.slug) return false;
  if (candidate.effectiveTransport === "native-openai") return false;
  if (canonicalProviderId(candidate.provider) === canonicalProviderId(sourceModel.provider)) return false;
  if (candidate.effectiveTransport !== sourceModel.effectiveTransport) return false;
  if (candidate.toolDialect && sourceModel.toolDialect && candidate.toolDialect !== sourceModel.toolDialect) return false;
  if (candidate.routable === false || candidate.listed === false || candidate.visible === false) return false;
  if (providerCooldown(candidate.provider)) return false;
  const estimatedTokens = estimateInputTokens(JSON.stringify(payload ?? {}));
  if (Number.isFinite(candidate.contextWindow) && candidate.contextWindow < estimatedTokens) return false;
  const needsImage = inputHasImage(Array.isArray(payload?.input) ? payload.input : []);
  if (needsImage && !(candidate.inputModalities || []).includes("image") && candidate.visionBridge === false) return false;
  const namespaces = flattenNamespaceTools(payload?.tools, { bridgeToolSearch: false }).namespaces;
  const needsCollaboration = collaborationToolAvailable(namespaces);
  if (needsCollaboration && (candidate.multiAgentVersion || "v1") !== "v2") return false;
  if (candidate.rolloutState === "experimental") {
    const matchingProof = proof || readProtocolProof(candidate.slug);
    if (!proofMatchesModel(matchingProof, candidate)) return false;
  }
  const markers = requestMarkers(payload);
  if (markers.size && candidate.effectiveTransport !== "openai-responses") return false;
  if (markers.has("reasoning") && candidate.reasoningDisplayMode === "raw-preserve") return false;
  return true;
}

export function rankRoutedCandidates(candidates, sourceModel, payload, options = {}) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => canFailoverTo(candidate, sourceModel, payload, options))
    .filter((candidate) => !options.usedModels?.has(candidate.slug))
    .filter((candidate) => !options.usedProviderFamilies?.has(canonicalProviderId(candidate.provider)))
    .sort((left, right) => Number(left.priority ?? 999) - Number(right.priority ?? 999) || String(left.slug).localeCompare(String(right.slug)))
    .slice(0, options.limit ?? MAX_FAILOVER_HOPS);
}

function shouldFailover(response, bodyText) {
  if (!response) return false;
  return classifyRoutedFailure({
    status: response.status,
    bodyText,
    retryAfterSeconds: Number(response.headers?.get?.("retry-after")),
  }).swap;
}

function candidateList(options, current, payload) {
  const supplied = typeof options.failoverCandidates === "function"
    ? options.failoverCandidates(current, payload)
    : options.failoverCandidates;
  return rankRoutedCandidates(supplied, current, payload, options);
}

function candidateCredential(options, candidate) {
  const resolved = options.credentialFor?.(candidate);
  if (resolved !== undefined && resolved !== null && resolved !== "") return resolved;
  if (candidate?.keyless === true || candidate?.authMode === "anonymous") {
    return { value: undefined, source: "explicit keyless/anonymous marker" };
  }
  return undefined;
}

function adapterFor(built, upstream, options) {
  const requestContext = {
    ...(built.context || {}),
    signal: options.signal || built.context?.signal,
    toolBuild: built.toolBuild,
    relayContext: createResponsesRelayContext(),
  };
  if (built.transport === "openai-responses") {
    return adaptOpenAIResponses({ model: built.model, upstream, requestContext });
  }
  if (built.transport === "native-openai") {
    return adaptOpenAIResponses({ model: built.model, upstream, requestContext });
  }
  return adaptAnthropicMessages({ model: built.model, upstream, requestContext });
}

/**
 * Dispatch a built request. No adapter is attached until the final upstream
 * response is selected, which keeps all retries/failovers strictly before the
 * first relayed byte. The returned transforms can be passed to pipeResponse.
 */
export async function dispatchRoutedRequest(built, options = {}) {
  if (!built?.url || !built?.body) throw new TypeError("built routed request is required");
  const fetchImpl = options.fetchImpl || fetch;
  const callerSignal = options.signal || built.context?.signal;
  let deadlineController;
  let deadlineTimer;
  let signal = callerSignal;
  const startedAt = options.now ? options.now() : Date.now();
  const retryOptions = {
    retries: options.retries ?? DIRECT_RETRY_LIMIT,
    backoffMs: options.backoffMs ?? DIRECT_RETRY_BACKOFF_MS,
    budgetMs: options.retryBudgetMs ?? DIRECT_RETRY_BUDGET_MS,
    signal,
    fetchImpl,
    sleepImpl: options.sleepImpl,
    now: options.now,
    canRetry: () => options.relayedBytes ? options.relayedBytes() === 0 : true,
    onRetry: options.onRetry,
  };
  let currentBuilt = built;
  let currentModel = built.model;
  let hops = 0;
  let retries = 0;
  const failures = [];
  const usedModels = new Set([currentModel.slug]);
  const usedProviderFamilies = new Set([canonicalProviderId(currentModel.provider)]);
  let originalFailure;
  let failoverStartedAt;
  try {
   for (;;) {
    const attempted = await fetchWithRetry(currentBuilt.url, {
      method: "POST",
      headers: currentBuilt.headers,
      body: currentBuilt.body,
      signal,
    }, retryOptions);
    retries += attempted.retries || 0;
    const upstream = attempted.response;
    if (!upstream) {
      if (attempted.failure) throw attempted.failure;
      throw new Error("routed provider returned no response");
    }
    if (upstream.ok || (upstream.status >= 200 && upstream.status < 300)) {
      // Only this module can select the raw diagnostic mode. In particular,
      // do not instantiate an adapter and then ignore it: Messages adapters
      // own AbortSignal listeners and must have a real pipeline lifecycle.
      const rawResponse = options.adapterMode === RAW_RESPONSE_ADAPTER_MODE;
      const adapter = rawResponse ? undefined : adapterFor(currentBuilt, upstream, { ...options, signal });
      return Object.freeze({
        response: upstream,
        adapter,
        transforms: adapter?.transforms || [],
        model: currentModel,
        built: currentBuilt,
        retries,
        hops,
        failures,
        elapsedMs: (options.now ? options.now() : Date.now()) - startedAt,
      });
    }
    const bodyText = await upstream.text().catch(() => "");
    originalFailure ??= { status: upstream.status, bodyText, headers: upstream.headers };
    failures.push({ model: currentModel, providerFamily: canonicalProviderId(currentModel.provider), kind: "response", status: upstream.status });
    const failureNow = options.now ? options.now() : Date.now();
    const verdict = classifyRoutedFailure({
      status: upstream.status,
      bodyText,
      retryAfterSeconds: parseRetryAfter(upstream.headers?.get?.("retry-after")),
      now: failureNow,
    });
    if (verdict.swap) {
      failoverStartedAt ??= failureNow;
      recordProviderCooldown(currentModel.provider, { ...verdict, now: failureNow });
    }
    if (!verdict.swap || hops >= MAX_FAILOVER_HOPS) {
      const finalFailure = hops ? originalFailure : { status: upstream.status, bodyText, headers: upstream.headers };
      return Object.freeze({
        response: new Response(finalFailure.bodyText, { status: finalFailure.status, headers: finalFailure.headers }),
        model: hops ? built.model : currentModel,
        built: hops ? built : currentBuilt,
        retries,
        hops,
        failures,
        elapsedMs: (options.now ? options.now() : Date.now()) - startedAt,
      });
    }
    const currentNow = options.now ? options.now() : Date.now();
    const elapsed = currentNow - startedAt;
    const failoverElapsed = currentNow - (failoverStartedAt ?? currentNow);
    const failoverBudgetMs = options.failoverBudgetMs ?? FAILOVER_BUDGET_MS;
    if (failoverElapsed >= failoverBudgetMs) {
      return Object.freeze({ response: new Response(originalFailure.bodyText, { status: originalFailure.status, headers: originalFailure.headers }), model: built.model, built, retries, hops, failures, elapsedMs: elapsed });
    }
    const candidate = rankRoutedCandidates(
      typeof options.failoverCandidates === "function" ? options.failoverCandidates(currentModel, built.pristinePayload) : options.failoverCandidates,
      currentModel,
      built.pristinePayload,
      { ...options, usedModels, usedProviderFamilies },
    )
      .filter((entry) => !usedModels.has(entry.slug))
      .map((entry) => ({ model: entry, credential: candidateCredential(options, entry) }))
      .find((entry) => entry.credential !== undefined);
    if (!candidate) {
      return Object.freeze({ response: new Response(originalFailure.bodyText, { status: originalFailure.status, headers: originalFailure.headers }), model: built.model, built, retries, hops, failures, elapsedMs: elapsed });
    }
    if (!deadlineController) {
      deadlineController = new AbortController();
      deadlineTimer = setTimeout(() => deadlineController.abort(new Error("routed failover budget exceeded")), failoverBudgetMs - failoverElapsed);
      signal = callerSignal
        ? (AbortSignal.any ? AbortSignal.any([callerSignal, deadlineController.signal]) : callerSignal)
        : deadlineController.signal;
      retryOptions.signal = signal;
    }
    hops += 1;
    usedModels.add(candidate.model.slug);
    usedProviderFamilies.add(canonicalProviderId(candidate.model.provider));
    currentModel = candidate.model;
    currentBuilt = buildRoutedRequest(built.pristinePayload, candidate.model, {
      ...built.context,
      ...options,
      signal,
      credential: candidate.credential,
      baseUrl: options.baseUrlFor?.(candidate.model) ?? candidate.model.baseUrl,
    });
   }
  } catch (error) {
    if (deadlineController?.signal.aborted && !callerSignal?.aborted && originalFailure) {
      return Object.freeze({
        response: new Response(originalFailure.bodyText, { status: originalFailure.status, headers: originalFailure.headers }),
        model: built.model,
        built,
        retries,
        hops,
        failures,
        elapsedMs: (options.now ? options.now() : Date.now()) - startedAt,
        aborted: true,
      });
    }
    if (originalFailure && !callerSignal?.aborted) {
      failures.push({
        model: currentModel,
        providerFamily: canonicalProviderId(currentModel.provider),
        kind: "transport",
        errorCode: typeof error?.cause?.code === "string" ? error.cause.code : typeof error?.code === "string" ? error.code : undefined,
      });
      return Object.freeze({
        response: new Response(originalFailure.bodyText, { status: originalFailure.status, headers: originalFailure.headers }),
        model: built.model,
        built,
        retries,
        hops,
        failures,
        elapsedMs: (options.now ? options.now() : Date.now()) - startedAt,
      });
    }
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

export async function readDispatchBody(result) {
  if (!result?.response?.body) return Buffer.alloc(0);
  const chunks = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  const source = Readable.fromWeb(result.response.body);
  await pipeline(source, ...(result.transforms || []), sink);
  return Buffer.concat(chunks);
}

export function routedProviderEndpoint(baseUrl, transport) {
  return providerEndpoint(baseUrl, transport === "anthropic-messages" ? "messages" : "responses");
}

const PROBE_TOOL = Object.freeze({
  type: "function",
  name: "codex_router_probe",
  description: "Protocol proof tool",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({ value: Object.freeze({ type: "string" }) }),
    required: Object.freeze(["value"]),
    additionalProperties: false,
  }),
  strict: true,
});

function rawEvents(text) {
  const events = [];
  for (const block of String(text).split(/\r\n\r\n|\n\n|\r\r/)) {
    const data = block.split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

function rawDocument(text, contentType) {
  if (String(contentType).toLowerCase().includes("text/event-stream")) {
    const events = rawEvents(text);
    const terminal = [...events].reverse().find((event) => ["response.completed", "response.incomplete", "response.failed"].includes(event?.type));
    if (terminal) return { events, payload: terminal.response || terminal };
    const started = events.find((event) => event?.type === "message_start")?.message;
    if (started && typeof started === "object") {
      const blocks = new Map();
      let usage = started.usage && typeof started.usage === "object" ? { ...started.usage } : undefined;
      for (const event of events) {
        if (event?.type === "content_block_start" && Number.isSafeInteger(event.index) && event.content_block && typeof event.content_block === "object") {
          blocks.set(event.index, { ...event.content_block });
          continue;
        }
        if (event?.type === "content_block_delta" && Number.isSafeInteger(event.index)) {
          const block = blocks.get(event.index);
          const delta = event.delta;
          if (!block || !delta || typeof delta !== "object") continue;
          if (delta.type === "thinking_delta") block.thinking = `${block.thinking || ""}${delta.thinking || ""}`;
          if (delta.type === "text_delta") block.text = `${block.text || ""}${delta.text || ""}`;
          if (delta.type === "input_json_delta") block._arguments = `${block._arguments || ""}${delta.partial_json || ""}`;
          continue;
        }
        if (event?.type === "message_delta" && event.usage && typeof event.usage === "object") usage = { ...(usage || {}), ...event.usage };
      }
      const content = [...blocks.entries()].sort((left, right) => left[0] - right[0]).map(([, block]) => {
        if (block.type !== "tool_use" || block.input !== undefined || block._arguments === undefined) return block;
        try { return { ...block, input: JSON.parse(block._arguments), _arguments: undefined }; }
        catch { return block; }
      });
      return { events, payload: { ...started, content, usage } };
    }
    return { events, payload: {} };
  }
  try { return { events: [], payload: JSON.parse(text) }; }
  catch { return { events: [], payload: {} }; }
}

function outputItems(document) {
  if (Array.isArray(document?.payload?.output)) return document.payload.output;
  if (Array.isArray(document?.payload?.content)) return document.payload.content;
  return [];
}

function textFromRaw(document) {
  const payload = document?.payload || {};
  if (typeof payload.output_text === "string" && payload.output_text) return payload.output_text;
  return outputItems(document).flatMap((item) => {
    if (typeof item?.text === "string") return [item.text];
    return Array.isArray(item?.content) ? item.content.map((part) => part?.text).filter((text) => typeof text === "string") : [];
  }).join("");
}

function rawToolCall(document) {
  const item = outputItems(document).find((entry) => entry?.type === "function_call" || entry?.type === "tool_use");
  if (!item) return undefined;
  const name = item.name;
  const callId = item.call_id ?? item.id;
  const args = item.arguments ?? (item.input === undefined ? undefined : JSON.stringify(item.input));
  if (typeof name !== "string" || !name || typeof callId !== "string" || !callId || typeof args !== "string") return undefined;
  let parsed;
  try { parsed = JSON.parse(args); } catch { return undefined; }
  return { type: "function_call", id: item.id || `fc_${callId}`, call_id: callId, name, arguments: args, parsed };
}

function rawUsage(document) {
  const payload = document?.payload || {};
  const usage = payload.usage ?? [...(document?.events || [])].reverse().find((event) => event?.usage)?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (![input, output].every((value) => Number.isFinite(value) && value >= 0)) return undefined;
  const total = Number.isFinite(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : input + output;
  return { input_tokens: input, output_tokens: output, total_tokens: total, totalDerived: usage.total_tokens === undefined, rawFields: Object.keys(usage).sort() };
}

function measuredReasoningShape(document) {
  const item = outputItems(document).find((entry) => entry?.type === "reasoning" || entry?.type === "thinking");
  if (!item) return "unverified";
  const summary = Array.isArray(item.summary) && item.summary.length > 0;
  const content = Array.isArray(item.content) && item.content.length > 0;
  const thinking = item.type === "thinking" || (Array.isArray(item.thinking) ? item.thinking.length > 0 : typeof item.thinking === "string" && item.thinking.length > 0);
  if (thinking) return "anthropic-thinking";
  if (summary && content) return "hybrid-summary";
  if (summary) return "provider-summary";
  if (content) return "raw-content";
  return "unverified";
}

function probeRuntime(model, options) {
  const endpoint = endpointForModel(model);
  const baseUrl = options.baseUrl ?? resolveProviderBaseUrl(endpoint).baseUrl;
  const credential = options.credential ?? resolveProviderCredential(endpoint);
  if (!baseUrl) throw Object.assign(new Error("protocol probe transport is unavailable"), { code: "protocol_probe_transport_unavailable", status: 503 });
  if (!credential && endpoint?.authMode !== "anonymous" && endpoint?.keyless !== true && model?.authMode !== "anonymous" && model?.keyless !== true) {
    throw Object.assign(new Error("protocol probe credential is unavailable"), { code: "protocol_probe_credential_missing", status: 503 });
  }
  return { baseUrl, credential, internalKey: options.internalKey, fetchImpl: options.fetchImpl, signal: options.signal, resources: options.resources };
}

async function readRawProbeBody(response, resources) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let cancelled = false;
  const cancelOnce = async (reason) => {
    if (cancelled) return;
    cancelled = true;
    try { await reader.cancel(reason); } catch {}
  };
  try {
    for (;;) {
      resources.consumeWork();
      const { done, value } = await resources.wait(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) throw probeResourceError("protocol_probe_resource_limit", 413);
      resources.consumeBytes(value.byteLength);
      resources.consumeWork(value.byteLength);
      chunks.push(Buffer.from(value));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    resources.consumeWork(Buffer.byteLength(raw));
    return raw;
  } catch (error) {
    await cancelOnce(error);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function rawProbeRequest(model, payload, runtime) {
  runtime.resources.throwIfAborted();
  const built = buildRoutedRequest(payload, model, {
    baseUrl: runtime.baseUrl,
    credential: runtime.credential,
    internalKey: runtime.internalKey,
    signal: runtime.signal,
    protocolProbeBypass: PROTOCOL_PROBE_BYPASS,
  });
  const result = await runtime.resources.wait(dispatchRoutedRequest(built, {
    fetchImpl: runtime.fetchImpl,
    signal: runtime.signal,
    retries: 0,
    failoverCandidates: [],
    adapterMode: RAW_RESPONSE_ADAPTER_MODE,
  }));
  const contentType = result.response.headers.get("content-type") || "application/json";
  const raw = await readRawProbeBody(result.response, runtime.resources);
  return { ok: result.response.ok, status: result.response.status, contentType, raw, document: rawDocument(raw, contentType), request: JSON.parse(Buffer.from(built.body).toString("utf8")) };
}

function observedDetail(parts) {
  return Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined));
}

// INTERNAL quota-confirmed diagnostic path. It calls the same pristine
// builder/dispatcher as ordinary routed traffic, but its unforgeable bypass is
// accepted only here so an experimental exact slug can earn its first proof.
// Raw provider bytes are consumed before any response adapter/summary transform.
export async function dispatchProtocolProbe(model, options = {}) {
  if (options.retry !== false || options.failover !== false) {
    throw Object.assign(new Error("protocol probes disable retry and failover"), {
      code: "protocol_probe_options_invalid",
      status: 500,
    });
  }
  if (options.confirmed !== true) {
    throw Object.assign(new Error("protocol probe requires explicit quota confirmation"), { code: "quota_confirmation_required", status: 409 });
  }
  if (!model?.slug) throw new TypeError("protocol probe model is required");
  if (options.targetSlug !== undefined && options.targetSlug !== model.slug) {
    throw Object.assign(new Error("protocol probe target slug mismatch"), { code: "protocol_probe_target_mismatch", status: 409 });
  }
  if (options.allowLive === false && typeof options.fetchImpl !== "function") {
    throw Object.assign(new Error("protocol probe is unavailable without an injected transport"), { code: "protocol_probe_not_implemented", status: 501 });
  }
  const resources = createProtocolProbeResources(options);
  const runtime = probeRuntime(model, { ...options, signal: resources.signal, resources });
  const checks = [];
  let measuredFinalReasoningShape = "unverified";
  const capture = async (name, operation) => {
    try {
      const result = await operation();
      checks.push({ name, ...result });
    } catch (error) {
      if (resources.isCallerAbort()) throw error;
      checks.push({ name, ok: false, status: Number(error?.status) || 502, detail: "diagnostic transport failed", observed: { errorCode: resources.safeErrorCode(error) } });
    }
  };
  try {
  await capture("nonstream", async () => {
    const response = await rawProbeRequest(model, { model: model.slug, stream: false, input: "Reply with exactly PROBE_BASIC_OK." }, runtime);
    const text = textFromRaw(response.document);
    return { ok: response.ok && text.includes("PROBE_BASIC_OK"), status: response.status, detail: response.ok ? "raw non-stream basic response observed" : "basic request failed", observed: observedDetail({ contentType: response.contentType, rawBytes: Buffer.byteLength(response.raw), textMatched: text.includes("PROBE_BASIC_OK") }) };
  });
  await capture("stream-reasoning", async () => {
    const nonstream = await rawProbeRequest(model, { model: model.slug, stream: false, input: "PROBE_REASONING_RAW: reason briefly, then answer." }, runtime);
    const streamed = await rawProbeRequest(model, { model: model.slug, stream: true, input: "PROBE_REASONING_STREAM: reason briefly, then answer." }, runtime);
    const nonstreamShape = measuredReasoningShape(nonstream.document);
    const streamShape = measuredReasoningShape(streamed.document);
    const lifecycle = streamed.document.events.some((event) => ["response.output_item.added", "response.reasoning_summary_part.added", "response.reasoning_summary_text.delta", "response.reasoning_text.delta", "content_block_start", "content_block_delta"].includes(event?.type));
    measuredFinalReasoningShape = streamShape !== "unverified" ? streamShape : nonstreamShape;
    const legal = ["provider-summary", "raw-content", "hybrid-summary", "anthropic-thinking"].includes(measuredFinalReasoningShape);
    return { ok: nonstream.ok && streamed.ok && lifecycle && legal && (nonstreamShape === streamShape || nonstreamShape === "unverified" || streamShape === "unverified"), status: streamed.status, detail: legal ? `raw reasoning lifecycle and ${measuredFinalReasoningShape} final shape observed` : "raw reasoning lifecycle/final shape missing", observed: observedDetail({ nonstreamShape, streamShape, lifecycle, nonstreamRawBytes: Buffer.byteLength(nonstream.raw), streamRawBytes: Buffer.byteLength(streamed.raw) }) };
  });
  await capture("auto-tool", async () => {
    const response = await rawProbeRequest(model, { model: model.slug, stream: false, input: "PROBE_AUTO_TOOL: call codex_router_probe with value ok.", tools: [PROBE_TOOL], tool_choice: "auto" }, runtime);
    const call = rawToolCall(response.document);
    return { ok: response.ok && call?.name === PROBE_TOOL.name && call?.parsed?.value === "ok", status: response.status, detail: call ? "raw automatic tool call and arguments observed" : "automatic tool call missing", observed: observedDetail({ name: call?.name, callId: call?.call_id, argumentsValid: call?.parsed?.value === "ok", rawBytes: Buffer.byteLength(response.raw) }) };
  });
  await capture("continuation", async () => {
    const first = await rawProbeRequest(model, { model: model.slug, stream: false, input: "PROBE_CONTINUATION_START: call codex_router_probe with value ok.", tools: [PROBE_TOOL], tool_choice: "required" }, runtime);
    const call = rawToolCall(first.document);
    if (!first.ok || !call) return { ok: false, status: first.status, detail: "continuation tool call missing", observed: observedDetail({ firstRawBytes: Buffer.byteLength(first.raw) }) };
    const followup = await rawProbeRequest(model, { model: model.slug, stream: false, input: [call, { type: "function_call_output", call_id: call.call_id, output: "PROBE_CONTINUATION_OK" }], tools: [PROBE_TOOL], tool_choice: "auto" }, runtime);
    const text = textFromRaw(followup.document);
    return { ok: followup.ok && text.includes("PROBE_CONTINUATION_OK"), status: followup.status, detail: followup.ok ? "actual tool-result continuation follow-up observed" : "continuation follow-up failed", observed: observedDetail({ callId: call.call_id, followupTextMatched: text.includes("PROBE_CONTINUATION_OK"), firstRawBytes: Buffer.byteLength(first.raw), followupRawBytes: Buffer.byteLength(followup.raw) }) };
  });
  await capture("usage", async () => {
    const response = await rawProbeRequest(model, { model: model.slug, stream: false, input: "PROBE_USAGE: reply with ok." }, runtime);
    const usage = rawUsage(response.document);
    return { ok: response.ok && Boolean(usage), status: response.status, detail: usage ? "authoritative raw usage fields observed" : "authoritative usage missing", observed: observedDetail({ ...usage, rawBytes: Buffer.byteLength(response.raw) }) };
  });
    const verdict = checks.length === 5 && checks.every((check) => check.ok) ? "passing" : "failed";
    return Object.freeze({ model: model.slug, transport: model.effectiveTransport, verdict, measuredFinalReasoningShape, checks: Object.freeze(checks), ok: verdict === "passing" });
  } finally {
    resources.close();
  }
}
