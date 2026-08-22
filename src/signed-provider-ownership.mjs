import { scanTomlDocument } from "./toml-structure.mjs";

export const signedProviderStartMarker = "# BEGIN codex-router-signed-provider-managed";
export const signedProviderEndMarker = "# END codex-router-signed-provider-managed";
export const signedProviderSlotPrefix = "# codex-router-signed-provider-tree-slot";

function headerId(providerId) {
  return /^[A-Za-z0-9_-]+$/.test(providerId) ? providerId : JSON.stringify(providerId);
}

export function managedSignedProviderBlock(providerId, baseUrl) {
  return [
    signedProviderStartMarker,
    `[model_providers.${headerId(providerId)}]`,
    'name = "Codex Router (with ChatGPT)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_standalone_web_search = true",
    "supports_websockets = false",
    signedProviderEndMarker,
  ].join("\n");
}

export function managedSignedProviderBlockLegacy(providerId, baseUrl) {
  return [
    signedProviderStartMarker,
    `[model_providers.${headerId(providerId)}]`,
    'name = "Codex Router (with ChatGPT)"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false",
    signedProviderEndMarker,
  ].join("\n");
}

export function managedSignedProviderBlockMatches(actual, providerId, baseUrl) {
  return [managedSignedProviderBlock(providerId, baseUrl), managedSignedProviderBlockLegacy(providerId, baseUrl)].includes(actual);
}

export function signedProviderSlot(state, index) {
  return `${signedProviderSlotPrefix} ${state.ownershipId} ${index}`;
}

export function providerTableRanges(contents, providerId) {
  const { lines, headers } = scanTomlDocument(contents);
  const starts = headers.filter(({ path: header }) => header[0] === "model_providers" && header[1] === providerId);
  const direct = starts.filter(({ path: header }) => header.length === 2);
  if (direct.length > 1) throw new Error(`Refusing duplicate model provider tables for ${providerId}.`);
  return starts.map(({ index: start }) => ({
    lines,
    start,
    end: headers.find(({ index }) => index > start)?.index ?? lines.length,
  }));
}

export function signedManagedRange(contents) {
  const lines = contents.split("\n");
  const starts = lines.map((line, index) => line.trim() === signedProviderStartMarker ? index : -1).filter((index) => index !== -1);
  const ends = lines.map((line, index) => line.trim() === signedProviderEndMarker ? index : -1).filter((index) => index !== -1);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) return undefined;
  return { lines, start: starts[0], end: ends[0] + 1 };
}

export function signedProviderBlockIsOwned(contents, state) {
  if (state.version === 2) {
    const range = signedManagedRange(contents);
    return Boolean(range && managedSignedProviderBlockMatches(range.lines.slice(range.start, range.end).join("\n"), state.managedProvider, state.managedBaseUrl));
  }
  if (state.version !== 3) return false;
  const expectedSlots = state.mode === "provider-table" ? Math.max(1, state.previousProviderSections.length) : state.previousProviderSections.length;
  const lines = contents.split("\n");
  const slots = lines.filter((line) => line.startsWith(`${signedProviderSlotPrefix} `));
  if (slots.length !== expectedSlots || !Array.from({ length: expectedSlots }, (_, index) => signedProviderSlot(state, index)).every((slot) => slots.filter((line) => line === slot).length === 1)) return false;
  let ranges;
  try {
    ranges = providerTableRanges(contents, state.managedProvider);
  } catch {
    // Status ownership checks fail closed on a foreign duplicate table.
    return false;
  }
  if (state.mode === "root-openai") return ranges.length === 0;
  const range = signedManagedRange(contents);
  if (!range) return false;
  const actual = range.lines.slice(range.start, range.end).join("\n");
  return managedSignedProviderBlockMatches(actual, state.managedProvider, state.managedBaseUrl) &&
    lines.indexOf(signedProviderSlot(state, 0)) + 1 === range.start &&
    ranges.length === 1 && ranges[0].start === range.start + 1;
}

export function signedProviderStateIsOwned(contents, state, { activeProvider, baseUrl, isManagedRouterBaseUrl, signedProviderId }) {
  if (activeProvider !== state.managedProvider) return false;
  if (state.version === 1) return activeProvider === signedProviderId;
  if (state.mode === "root-openai") {
    return isManagedRouterBaseUrl(baseUrl) && (state.version !== 3 || signedProviderBlockIsOwned(contents, state));
  }
  return signedProviderBlockIsOwned(contents, state);
}
