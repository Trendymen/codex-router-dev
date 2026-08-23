// Appendix H is the single reader boundary shared by catalog publication,
// request-time selection, control state, and local-reader pinning.  This
// module deliberately contains no transport code: it answers only whether a
// reader is allowed to be named by a caller.

const LOOPBACK_PROVIDER_IDS = new Set(["local", "lmstudio", "ollama"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function valuesSet(value) {
  if (typeof value === "function") return valuesSet(value());
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map((entry) => String(entry)));
  return undefined;
}

function providerFor(reader, providers) {
  if (!reader || typeof reader !== "object") return undefined;
  const providerId = String(reader.provider || "");
  if (!providerId) return undefined;
  if (providers instanceof Map) return providers.get(providerId);
  if (providers && typeof providers === "object") return providers[providerId];
  return undefined;
}

function imageReader(reader) {
  return Boolean(
    reader &&
      typeof reader === "object" &&
      Array.isArray(reader.inputModalities) &&
      reader.inputModalities.includes("image"),
  );
}

export function isLoopbackBaseUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isLoopbackVisionReader(reader, { providers } = {}) {
  if (reader?.local === true) return true;
  const providerId = String(reader?.provider || "");
  const provider = providerFor(reader, providers);
  return Boolean(
      LOOPBACK_PROVIDER_IDS.has(providerId) ||
      provider?.keyless === true ||
      isLoopbackBaseUrl(reader?.baseUrl),
  );
}

function callerSessionUsable(session, strict) {
  if (session === undefined) return !strict;
  if (typeof session === "boolean") return session;
  return session?.usable === true;
}

function providerAllowed(reader, context) {
  const providerId = String(reader?.provider || "");
  // Bridge unit fixtures may intentionally omit provider metadata; production
  // callers are strict and always provide a registry-backed provider id.
  if (!providerId) return context.strict !== true;
  if (isLoopbackVisionReader(reader, context)) return false;
  const enabled = valuesSet(context.enabledProviders);
  const credentialed = valuesSet(context.credentialedProviders);
  if (enabled && !enabled.has(providerId)) return false;
  if (credentialed && !credentialed.has(providerId)) return false;
  if (context.strict && !enabled && reader.enabled !== true && reader.routable !== true) return false;
  if (context.strict && !credentialed && reader.credentialed !== true && reader.routable !== true) return false;
  const provider = providerFor(reader, context.providers);
  if (provider?.visionOnly === true || provider?.chatEnabled === false) return false;
  return true;
}

function supportedNodeReader(reader, context) {
  if (!imageReader(reader) || !providerAllowed(reader, context)) return false;
  if (reader.visionReaderSupported === false || reader.legacy === true) return false;
  // A strict caller must hand us a model already accepted by the Node route
  // contract.  The effective transport/tool dialect pair is the compact,
  // immutable marker available in catalog snapshots; routable is the runtime
  // authorization bit when one is present.
  if (context.strict) {
    if (reader.effectiveTransport === undefined || reader.toolDialect === undefined) return false;
    if (reader.routable === false) return false;
  }
  return true;
}

function nativeReaderAllowed(reader, context) {
  return Boolean(
    reader?.native === true &&
      imageReader(reader) &&
      callerSessionUsable(context.callerSession, context.strict),
  );
}

function explicitLocalReader(reader) {
  return Boolean(
    reader &&
      typeof reader === "object" &&
      reader.local === true &&
      reader.invalidBaseUrl !== true &&
      imageReader(reader) &&
      isLoopbackBaseUrl(reader.baseUrl),
  );
}

function readerSlug(reader) {
  return typeof reader?.slug === "string" ? reader.slug : "";
}

function uniqueReaders(readers) {
  const seen = new Set();
  return readers.filter((reader) => {
    const slug = readerSlug(reader);
    if (!slug || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });
}

/**
 * Return the readers allowed by Appendix H.
 *
 * `strict` is used by production catalog/request callers.  Unit callers may
 * omit it when passing already-curated reader-shaped fixtures; this keeps the
 * transport-independent bridge helpers useful without weakening production
 * authorization, which always supplies enabled/credentialed Node state.
 */
export function allowedVisionReaders(context = {}) {
  const nativeReaders = Array.isArray(context.nativeReaders) ? context.nativeReaders : [];
  const selectedNodeModels = Array.isArray(context.selectedNodeModels)
    ? context.selectedNodeModels
    : [];
  const localReaders = context.localPin ? [context.localPin] : [];
  const readers = [
    ...nativeReaders.filter((reader) => nativeReaderAllowed(reader, context)),
    ...selectedNodeModels.filter((reader) => supportedNodeReader(reader, context)),
    ...localReaders.filter(explicitLocalReader),
  ];
  return uniqueReaders(readers);
}

/** Resolve a named reader or the first non-loopback reader for auto mode. */
export function resolveVisionReader(selection, context = {}) {
  const readers = allowedVisionReaders(context);
  const requested = typeof selection === "string" ? selection.trim() : "";
  if (!requested || requested === "auto") {
    return readers.find((reader) => !isLoopbackVisionReader(reader, context)) || null;
  }
  const resolved = readers.find((reader) => readerSlug(reader) === requested);
  if (resolved) return resolved;
  // A legacy bridge fixture may provide a registry-shaped loopback reader.
  // Production strict callers use `localPin` instead, so this compatibility
  // escape hatch is disabled by strict mode and cannot publish a chat route.
  if (context.strict !== true && context.allowLoopbackPin !== false) {
    const loopback = (Array.isArray(context.selectedNodeModels) ? context.selectedNodeModels : [])
      .find((reader) => readerSlug(reader) === requested && imageReader(reader) && isLoopbackVisionReader(reader, context));
    if (loopback) return loopback;
  }
  return null;
}

export function visionEngineNotSupportedError(selection) {
  const error = new Error(`Vision reader ${String(selection || "") || "(missing)"} is not supported.`);
  error.code = "vision_engine_not_supported";
  error.status = 400;
  return error;
}

export function isReservedVisionOnlySlug(value) {
  return /^(?:local|lmstudio)(?:\/|$)/i.test(String(value || "").trim());
}

export { imageReader as supportsVisionImageInput };
