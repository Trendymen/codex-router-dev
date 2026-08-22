const definitions = [
  ["provider_not_available_in_node_build", 404, "This provider is not available in the Node-native build."],
  ["model_not_enabled", 404, "This model is not enabled."],
  ["unsupported_platform", 400, "This operation is not supported on this platform."],
  ["reasoning_protocol_error", 502, "Invalid upstream reasoning sequence."],
  ["reasoning_final_mismatch", 502, "Upstream final reasoning did not match."],
  ["upstream_stream_truncated", 502, "Upstream stream ended early."],
  ["unsupported_anthropic_block", 502, "Unsupported Messages response block."],
  ["thinking_signature_missing", 422, "Required thinking signature is missing."],
  ["thinking_signature_invalid", 422, "Invalid thinking continuation metadata."],
  ["thinking_provenance_unknown", 422, "Reasoning provenance cannot be verified."],
  ["invalid_reasoning_config", 400, "Reasoning must be an object or omitted."],
  ["unsupported_reasoning_effort", 400, "Requested reasoning effort is unsupported."],
  ["invalid_output_limit", 400, "Output limit must be a positive integer."],
  ["thinking_budget_exceeds_output_limit", 400, "Output limit cannot contain requested thinking budget."],
  ["output_limit_exceeds_provider_cap", 400, "Output limit exceeds the provider cap."],
  ["tool_mapping_error", 422, "Invalid tool mapping."],
  ["required_tool_not_called", 422, "Required tool was not called."],
  ["required_tool_mismatch", 422, "Wrong required tool was called."],
  ["forced_tool_buffer_limit", 413, "Forced-tool response exceeded buffer limit."],
  ["forced_tool_buffer_timeout", 504, "Forced-tool validation exceeded time limit."],
  ["upstream_timeout", 504, "Upstream timed out."],
  ["panel_auth_required", 401, "A write session is required."],
  ["panel_csrf_invalid", 403, "Invalid panel mutation proof."],
  ["panel_confirmation_required", 409, "An operation-bound confirmation is required."],
  ["vision_engine_not_supported", 400, "The selected vision engine is not supported."],
];

export const ERROR_DEFINITIONS = Object.freeze(
  Object.fromEntries(definitions.map(([code, status, message]) => [code, Object.freeze({ status, message })])),
);
const trustedErrors = new WeakSet();
const trustedTerminalEvents = new WeakSet();
const INCOMPLETE_REASONS = new Set(["max_output_tokens"]);

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function publicBody(code, message) {
  return { error: { type: "router_error", code, message, param: null } };
}

export function routerError(code, privateDetails = {}) {
  const definition = ERROR_DEFINITIONS[code];
  if (!definition) throw new TypeError(`unknown public error code: ${code}`);
  const error = {
    status: definition.status,
    body: publicBody(code, definition.message),
  };
  // This property is deliberately non-enumerable so JSON serialization and
  // ordinary diagnostic snapshots cannot expose request or provider data.
  Object.defineProperty(error, "privateDetails", {
    value: deepFreeze({ ...privateDetails }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  trustedErrors.add(error);
  return deepFreeze(error);
}

function responseContext(context) {
  return {
    id: context.responseId,
    object: "response",
    created_at: context.createdAt,
    model: context.model,
    output: structuredClone(context.output || []),
    usage: context.usage ? structuredClone(context.usage) : null,
  };
}

export function failedResponseEvent(context, error) {
  if (!trustedErrors.has(error)) throw new TypeError("failed response event requires a trusted router public error");
  const code = error.body.error.code;
  const definition = ERROR_DEFINITIONS[code];
  if (!definition) throw new TypeError("failed response event requires a known router public error code");
  const event = deepFreeze({
    type: "response.failed",
    sequence_number: context.sequenceNumber,
    response: {
      ...responseContext(context),
      status: "failed",
      error: { code, message: definition.message },
      incomplete_details: null,
    },
  });
  trustedTerminalEvents.add(event);
  return event;
}

export function incompleteResponseEvent(context, reason) {
  if (!INCOMPLETE_REASONS.has(reason)) throw new TypeError("unsupported incomplete reason");
  const event = deepFreeze({
    type: "response.incomplete",
    sequence_number: context.sequenceNumber,
    response: {
      ...responseContext(context),
      status: "incomplete",
      error: null,
      incomplete_details: { reason },
    },
  });
  trustedTerminalEvents.add(event);
  return event;
}

export function formatTerminalFrames(event) {
  if (!trustedTerminalEvents.has(event)) throw new TypeError("terminal frames require a trusted terminal event");
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}
