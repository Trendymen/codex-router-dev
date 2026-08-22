import { adaptAnthropicMessages, buildAnthropicMessagesRequest } from "./anthropic-messages-adapter.mjs";
import { adaptOpenAIResponses, buildOpenAIResponsesRequest, createResponsesRelayContext } from "./openai-responses-adapter.mjs";
import { providerEndpoint } from "./provider-endpoint.mjs";
import { fetchWithRetry } from "./upstream-retry.mjs";
import { classifyRoutedFailure, FAILOVER_BUDGET_MS, MAX_FAILOVER_HOPS } from "./model-failover.mjs";
import { proofMatchesModel } from "./model-contract.mjs";
import { readProtocolProof } from "./protocol-proof.mjs";

// Appendix D is intentionally independent of the native ChatGPT retry knobs.
// A routed request is cheap only until its first response byte is committed;
// after that point neither retry nor model failover can safely replay it.
export const DIRECT_RETRY_LIMIT = 2;
export const DIRECT_RETRY_BACKOFF_MS = 250;
export const DIRECT_RETRY_BUDGET_MS = 5_000;
export function protocolProbeArgv(model) {
  if (!model?.slug) throw new TypeError("protocol probe model is required");
  return Object.freeze(["src/compatibility-test.mjs", model.slug, "--live", "--yes", "--json"]);
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
  if (model.rolloutState === "experimental" && !proofMatchesModel(context.proof || readProtocolProof(model.slug), model)) {
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
  if (candidate.provider === sourceModel.provider) return false;
  if (candidate.routable === false || candidate.listed === false || candidate.visible === false) return false;
  if (candidate.rolloutState === "experimental") {
    const matchingProof = proof || readProtocolProof(candidate.slug);
    if (!proofMatchesModel(matchingProof, candidate)) return false;
  }
  const markers = requestMarkers(payload);
  if (markers.size && candidate.effectiveTransport !== "openai-responses") return false;
  if (markers.has("reasoning") && candidate.reasoningDisplayMode === "raw-preserve") return false;
  return true;
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
  return (Array.isArray(supplied) ? supplied : [])
    .filter((candidate) => canFailoverTo(candidate, current, payload, options))
    .slice(0, MAX_FAILOVER_HOPS);
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
  const signal = options.signal || built.context?.signal;
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
      const adapter = adapterFor(currentBuilt, upstream, options);
      return Object.freeze({
        response: upstream,
        adapter,
        transforms: adapter.transforms,
        model: currentModel,
        built: currentBuilt,
        retries,
        hops,
        failures,
        elapsedMs: (options.now ? options.now() : Date.now()) - startedAt,
      });
    }
    const bodyText = await upstream.text().catch(() => "");
    failures.push({ model: currentModel, status: upstream.status });
    const verdict = classifyRoutedFailure({
      status: upstream.status,
      bodyText,
      retryAfterSeconds: Number(upstream.headers?.get?.("retry-after")),
    });
    if (!verdict.swap || hops >= MAX_FAILOVER_HOPS) {
      return Object.freeze({
        response: new Response(bodyText, { status: upstream.status, headers: upstream.headers }),
        model: currentModel,
        built: currentBuilt,
        retries,
        hops,
        failures,
        elapsedMs: (options.now ? options.now() : Date.now()) - startedAt,
      });
    }
    const elapsed = (options.now ? options.now() : Date.now()) - startedAt;
    if (elapsed >= (options.failoverBudgetMs ?? FAILOVER_BUDGET_MS)) {
      return Object.freeze({ response: new Response(bodyText, { status: upstream.status, headers: upstream.headers }), model: currentModel, built: currentBuilt, retries, hops, failures, elapsedMs: elapsed });
    }
    const [candidate] = candidateList(options, currentModel, built.pristinePayload)
      .filter((entry) => !usedModels.has(entry.slug));
    if (!candidate) {
      return Object.freeze({ response: new Response(bodyText, { status: upstream.status, headers: upstream.headers }), model: currentModel, built: currentBuilt, retries, hops, failures, elapsedMs: elapsed });
    }
    hops += 1;
    usedModels.add(candidate.slug);
    currentModel = candidate;
    currentBuilt = buildRoutedRequest(built.pristinePayload, candidate, {
      ...built.context,
      ...options,
      credential: options.credentialFor?.(candidate) ?? candidate.credential ?? built.context?.credential,
      baseUrl: options.baseUrlFor?.(candidate) ?? candidate.baseUrl,
    });
  }
}

export function routedProviderEndpoint(baseUrl, transport) {
  return providerEndpoint(baseUrl, transport === "anthropic-messages" ? "messages" : "responses");
}

// Phase 1 owns the quota gate, while this seam owns the exact command shape.
// Keeping the command construction here prevents a future proof path from
// substituting a generic "command ran" check for the compatibility verdict.
// The injected runner is the unit-test seam; production live execution is
// deliberately unavailable until the explicit Phase 5 quota gate is opened.
export async function dispatchProtocolProbe(model, options = {}, { runProbe } = {}) {
  if (options.retry !== false || options.failover !== false) {
    throw Object.assign(new Error("protocol probes disable retry and failover"), {
      code: "protocol_probe_options_invalid",
      status: 500,
    });
  }
  if (!model?.slug || typeof runProbe !== "function") {
    throw Object.assign(new Error("protocol probe is unavailable without an injected runner"), {
      code: "protocol_probe_not_implemented",
      status: 501,
    });
  }
  const argv = protocolProbeArgv(model);
  const evidence = await runProbe({ argv, model, options: { retry: false, failover: false } });
  if (!evidence || evidence.model !== model.slug || !Array.isArray(evidence.results)) {
    throw Object.assign(new Error("protocol probe returned no compatibility verdict"), {
      code: "protocol_probe_invalid_evidence",
      status: 422,
    });
  }
  return evidence;
}
