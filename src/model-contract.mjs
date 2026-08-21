import { experimentalModelEnabled } from "./experimental-models.mjs";
import { MODELS } from "./model-registry.mjs";
import { readProtocolProof, registryFingerprint } from "./protocol-proof.mjs";
import { PROTOCOL_PROOF_VERIFIER_VERSION } from "./protocol-proof-verifier.mjs";

export const TRANSPORTS = Object.freeze([
  "native-openai",
  "openai-responses",
  "anthropic-messages",
]);

export const TOOL_DIALECTS = Object.freeze([
  "responses-native",
  "responses-functions",
]);

export const REASONING_DISPLAY_MODES = Object.freeze([
  "summary-compat",
  "raw-preserve",
]);

export const FINAL_SHAPES = Object.freeze([
  "provider-summary",
  "raw-content",
  "hybrid-summary",
  "anthropic-thinking",
  "unverified",
]);

export const ROLLOUT_STATES = Object.freeze(["stable", "experimental"]);
export const PURPOSES = Object.freeze(["primary", "compatibility"]);

const NODE_FIELDS = Object.freeze([
  "effectiveTransport",
  "toolDialect",
  "reasoningDisplayMode",
  "declaredFinalReasoningShape",
  "rolloutState",
  "purpose",
]);

const VERIFIED_FINAL_SHAPES = new Set(FINAL_SHAPES.filter((shape) => shape !== "unverified"));

// Appendix B is the closed Node-only routing boundary. Registry metadata is
// validated independently, but it is not provenance: user overlays and future
// fragments may carry the same valid fields without becoming supported routes.
const NORMATIVE_NODE_SLUGS = new Set([
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "qwen-plan/qwen3.8-max",
  "qwen-plan/deepseek-v4-flash-0731",
  "qwen-plan/qwen3.8-max-preview",
  "qwen-plan/qwen3.7-max",
  "qwen-plan/qwen3.7-plus",
  "qwen-plan/qwen3.6-flash",
  "qwen-plan/deepseek-v4-pro",
  "qwen-plan/deepseek-v4-pro-0813",
  "qwen-plan/glm-5.2",
  "qwen-plan-responses/glm-5.2",
]);

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNodeMetadata(model) {
  return objectRecord(model) && NODE_FIELDS.some((field) => model[field] !== undefined);
}

export function isNodeModel(model) {
  return objectRecord(model) && NODE_FIELDS.every((field) => model[field] !== undefined);
}

function invalid(message) {
  throw new Error(`Invalid Node model contract: ${message}`);
}

function enumValue(model, field, allowed) {
  if (!allowed.includes(model[field])) invalid(`${field} must be one of ${allowed.join(", ")}`);
}

export function validateNodeModel(model) {
  if (!objectRecord(model)) invalid("model must be an object");
  if (!hasNodeMetadata(model)) invalid("model is missing Node metadata");
  for (const field of NODE_FIELDS) {
    if (typeof model[field] !== "string" || !model[field]) {
      invalid(`${field} must be a non-empty string`);
    }
  }
  enumValue(model, "effectiveTransport", TRANSPORTS);
  enumValue(model, "toolDialect", TOOL_DIALECTS);
  enumValue(model, "reasoningDisplayMode", REASONING_DISPLAY_MODES);
  enumValue(model, "declaredFinalReasoningShape", FINAL_SHAPES);
  enumValue(model, "rolloutState", ROLLOUT_STATES);
  enumValue(model, "purpose", PURPOSES);

  if (model.declaredFinalReasoningShape === "unverified" && model.rolloutState !== "experimental") {
    invalid("unverified declaredFinalReasoningShape requires experimental rolloutState");
  }
  if (model.purpose === "compatibility" && model.rolloutState !== "experimental") {
    invalid("compatibility purpose requires experimental rolloutState");
  }
  if (typeof model.slug !== "string" || !model.slug) invalid("slug is required");
  if (typeof model.provider !== "string" || !model.provider) invalid("provider is required");
  if (typeof model.upstreamModel !== "string" || !model.upstreamModel) {
    invalid("upstreamModel is required");
  }
  if (model.requestProfile !== undefined && typeof model.requestProfile !== "string") {
    invalid("requestProfile must be a string when present");
  }
  if (typeof model.listed !== "boolean") invalid("listed must be boolean");
  if (
    model.credentialOwner !== undefined &&
    (typeof model.credentialOwner !== "string" || !model.credentialOwner)
  ) {
    invalid("credentialOwner must be a non-empty string when present");
  }
  return model;
}

function valueFromMapOrObject(values, key) {
  if (values instanceof Map) return values.get(key);
  if (values && typeof values === "object") return values[key];
  return undefined;
}

function booleanState(value, model, key = model.provider) {
  if (typeof value === "function") return Boolean(value(model));
  if (typeof value === "boolean") return value;
  const selected = valueFromMapOrObject(value, key);
  if (selected !== undefined) return Boolean(selected);
  if (value instanceof Set) return value.has(key);
  if (Array.isArray(value)) return value.includes(key);
  return undefined;
}

function providerEnabled(model, state) {
  const direct = booleanState(state.providerEnabled, model);
  if (direct !== undefined) return direct;
  const selected = booleanState(state.enabledProviders, model);
  if (selected !== undefined) return selected;
  if (typeof state.enabled === "function") return Boolean(state.enabled(model));
  if (typeof state.enabled === "boolean") return state.enabled;
  return false;
}

function canaryEnabled(model, state) {
  const direct = booleanState(state.canaryEnabled, model);
  if (direct !== undefined) return direct;
  const selected = booleanState(state.enabledCanaries, model, model.slug);
  if (selected !== undefined) return selected;
  // The short `{enabled, proof}` form is useful for resolving one model and is
  // intentionally accepted as both the provider and canary gate.
  if (typeof state.enabled === "boolean") return state.enabled;
  return experimentalModelEnabled(model.slug);
}

function proofFor(model, state) {
  if (Object.prototype.hasOwnProperty.call(state, "proof")) return state.proof;
  const fromMap = valueFromMapOrObject(state.proofs, model.slug);
  if (fromMap !== undefined) return fromMap;
  return readProtocolProof(model.slug);
}

function visibleFor(model, state) {
  if (typeof state.visible === "function") return Boolean(state.visible(model));
  if (typeof state.visible === "boolean") return state.visible;
  const hidden = state.hiddenModels;
  if (hidden instanceof Set) return !hidden.has(model.slug);
  if (Array.isArray(hidden)) return !hidden.includes(model.slug);
  if (hidden && typeof hidden === "object") return !hidden[model.slug];
  return true;
}

function proofField(proof, primary, alternate) {
  if (proof?.[primary] !== undefined) return proof[primary];
  return alternate ? proof?.[alternate] : undefined;
}

export function proofMatchesModel(proof, model) {
  if (!objectRecord(proof) || proof.verdict !== "passing") return false;
  if (proof.slug !== model.slug) return false;
  if (proof.provider !== model.provider) return false;
  if (proof.upstreamModel !== model.upstreamModel) return false;
  if (proofField(proof, "transport", "effectiveTransport") !== model.effectiveTransport) return false;
  if (proof.toolDialect !== model.toolDialect) return false;
  if (proof.requestProfile !== model.requestProfile) return false;
  if (proof.verifierVersion !== PROTOCOL_PROOF_VERIFIER_VERSION) return false;
  const fingerprint = proof.fingerprint ?? proof.registryFingerprint;
  if (typeof fingerprint !== "string" || !fingerprint) return false;
  if (fingerprint !== registryFingerprint(model, proof.verifierVersion)) return false;
  const measured = proof.measuredFinalReasoningShape ?? proof.finalReasoningShape;
  return VERIFIED_FINAL_SHAPES.has(measured);
}

function effectiveProofShape(proof) {
  const measured = proof?.measuredFinalReasoningShape ?? proof?.finalReasoningShape;
  return VERIFIED_FINAL_SHAPES.has(measured) ? measured : null;
}

export function resolveNodeModel(model, state = {}) {
  validateNodeModel(model);
  const providerIsEnabled = providerEnabled(model, state);
  const experimental = model.rolloutState === "experimental";
  const proof = proofFor(model, state);
  const proofMatches = experimental ? proofMatchesModel(proof, model) : true;
  const rolloutEnabled = experimental
    ? providerIsEnabled && canaryEnabled(model, state) && proofMatches
    : providerIsEnabled;
  const routable = Boolean(rolloutEnabled);
  const effectiveFinalReasoningShape = experimental
    ? proofMatches
      ? effectiveProofShape(proof)
      : null
    : model.declaredFinalReasoningShape;
  const listed = model.listed === true;
  const visible = routable && listed && visibleFor(model, state);
  return Object.freeze({
    ...model,
    effectiveFinalReasoningShape,
    routable,
    listed,
    visible,
    ...(routable ? {} : { publicError: "model_not_enabled" }),
  });
}

export function nodeRoutableModels(state = {}) {
  return Object.freeze(
    MODELS
      .filter((model) => NORMATIVE_NODE_SLUGS.has(model.slug) && isNodeModel(model))
      .map((model) => resolveNodeModel(model, state))
      .filter((model) => model.routable),
  );
}

export { NODE_FIELDS };
