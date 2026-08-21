import { existsSync, readFileSync } from "node:fs";

import { isManagedCallerBaseUrl, redactCallerUrl } from "./caller-auth.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import {
  CODEX_PROVIDER_MODE_PATH,
  CONFIG_PATH,
  LEGACY_PORTS,
  MERGED_CATALOG_PATH,
  PORTS,
  SIGNED_PROVIDER_MODE_PATH,
  loopback,
} from "./paths.mjs";
import { scanTomlDocument } from "./toml-structure.mjs";
import { signedProviderStateIsOwned } from "./signed-provider-ownership.mjs";

const routerProviderId = "codex-router";
const signedProviderId = "codex-router-signed";
const managedRouterBaseUrls = new Set([
  loopback(PORTS.router, "/v1"),
  loopback(LEGACY_PORTS.router, "/v1"),
]);

function rootValue(document, key) {
  const assignment = document.assignments.find(
    (entry) => entry.tablePath.length === 0 && entry.key.length === 1 && entry.key[0] === key,
  );
  if (!assignment) return undefined;
  if (assignment.kind === "string") return assignment.value;
  const raw = document.lines[assignment.index].split("=").slice(1).join("=").trim();
  return raw.replace(/\s+#.*$/, "").replace(/^(?:"|')|(?:"|')$/g, "");
}

function isManagedRouterBaseUrl(value) {
  return (
    managedRouterBaseUrls.has(value) ||
    isManagedCallerBaseUrl(value, PORTS.router) ||
    isManagedCallerBaseUrl(value, LEGACY_PORTS.router)
  );
}

function readProviderModeState() {
  if (!existsSync(CODEX_PROVIDER_MODE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(CODEX_PROVIDER_MODE_PATH, "utf8"));
    if (
      parsed?.version !== 1 ||
      typeof parsed.previousPresent !== "boolean" ||
      (parsed.previousPresent && typeof parsed.previousModelProvider !== "string") ||
      typeof parsed.previousModelPresent !== "boolean" ||
      (parsed.previousModelPresent && typeof parsed.previousModel !== "string")
    ) throw new Error("invalid state");
    return parsed;
  } catch {
    throw new Error(`Invalid Codex provider-mode state at ${CODEX_PROVIDER_MODE_PATH}.`);
  }
}

function readSignedProviderModeState() {
  if (!existsSync(SIGNED_PROVIDER_MODE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(SIGNED_PROVIDER_MODE_PATH, "utf8"));
    const recognizedV1 =
      parsed?.version === 1 &&
      parsed.managedProvider === signedProviderId &&
      typeof parsed.previousPresent === "boolean" &&
      (!parsed.previousPresent || typeof parsed.previousModelProvider === "string");
    const recognizedV2 =
      parsed?.version === 2 &&
      (parsed.mode === "root-openai" || parsed.mode === "provider-table") &&
      typeof parsed.managedProvider === "string" &&
      parsed.managedProvider.length > 0 &&
      typeof parsed.managedBaseUrl === "string" &&
      isManagedRouterBaseUrl(parsed.managedBaseUrl) &&
      typeof parsed.previousProviderTablePresent === "boolean" &&
      (!parsed.previousProviderTablePresent || typeof parsed.previousProviderTable === "string");
    const recognizedV3 =
      parsed?.version === 3 &&
      (parsed.mode === "root-openai" || parsed.mode === "provider-table") &&
      typeof parsed.managedProvider === "string" &&
      parsed.managedProvider.length > 0 &&
      typeof parsed.managedBaseUrl === "string" &&
      isManagedRouterBaseUrl(parsed.managedBaseUrl) &&
      typeof parsed.ownershipId === "string" &&
      /^[0-9a-f]{32}$/.test(parsed.ownershipId) &&
      Array.isArray(parsed.previousProviderSections) &&
      parsed.previousProviderSections.every((section) => typeof section === "string");
    if (!recognizedV1 && !recognizedV2 && !recognizedV3) throw new Error("invalid state");
    return parsed;
  } catch {
    throw new Error(`Invalid signed router provider state at ${SIGNED_PROVIDER_MODE_PATH}.`);
  }
}


// Shared, read-only snapshot used both by config-manager status and doctor.
// It performs no config mutation and never invokes a config-manager subprocess.
export function readCodexConfigStatus(contents) {
  const document = scanTomlDocument(contents);
  const baseUrl = rootValue(document, "openai_base_url");
  const catalog = rootValue(document, "model_catalog_json");
  const activeProvider = rootValue(document, "model_provider") || "openai";
  const providerState = readProviderModeState();
  const signedState = readSignedProviderModeState();
  const signedActive = signedState
    ? signedProviderStateIsOwned(contents, signedState, {
      activeProvider,
      baseUrl,
      isManagedRouterBaseUrl,
      signedProviderId,
    })
    : false;
  return {
    mode: isManagedRouterBaseUrl(baseUrl) && catalog === MERGED_CATALOG_PATH ? "router" : "native",
    model: rootValue(document, "model") || null,
    model_provider: activeProvider,
    login_free: activeProvider === routerProviderId,
    login_free_managed: activeProvider === routerProviderId && Boolean(providerState),
    provider_mode_state_present: Boolean(providerState),
    signed_routing: Boolean(signedActive),
    signed_routing_managed: Boolean(signedActive && privateFileIsProtected(SIGNED_PROVIDER_MODE_PATH)),
    signed_provider_state_present: Boolean(signedState),
    openai_base_url: baseUrl ? redactCallerUrl(baseUrl) : null,
    model_catalog_json: catalog || null,
    config_protected: privateFileIsProtected(CONFIG_PATH),
  };
}
