import {
  assertUnambiguousTomlDocument,
  scanTomlDocument,
  tomlBooleanValue,
  tomlStringValue,
} from "./toml-structure.mjs";

export const SEARCH_CONFIG_SNIPPET = `web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
`;

function valuesFromToml(contents) {
  const document = scanTomlDocument(contents);
  assertUnambiguousTomlDocument(document);
  return {
    webSearch: tomlStringValue(document, [], "web_search") === "live",
    suppressWarning: tomlBooleanValue(document, [], "suppress_unstable_features_warning") === true,
    standaloneWebSearch: tomlBooleanValue(document, ["features"], "standalone_web_search") === true,
  };
}

function valuesFromObject(config) {
  return {
    webSearch: config?.web_search === "live",
    suppressWarning: config?.suppress_unstable_features_warning === true,
    standaloneWebSearch: config?.features?.standalone_web_search === true,
  };
}

// This intentionally parses only the three gates we report. It does not need
// a TOML writer because doctor must never alter a user- or CC Switch-owned
// config document.
export function standaloneSearchStatus(codexConfig) {
  let values;
  try {
    values = typeof codexConfig === "object" && codexConfig !== null
      ? valuesFromObject(codexConfig)
      : valuesFromToml(codexConfig);
  } catch (error) {
    return {
      ok: false,
      missing: [],
      invalid: error instanceof Error ? error.message : "Invalid TOML structure.",
      snippet: SEARCH_CONFIG_SNIPPET,
    };
  }
  const missing = [];
  if (!values.webSearch) missing.push("web_search");
  if (!values.suppressWarning) missing.push("suppress_unstable_features_warning");
  if (!values.standaloneWebSearch) missing.push("features.standalone_web_search");
  return { ok: missing.length === 0, missing, snippet: SEARCH_CONFIG_SNIPPET };
}
