function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function canonicalRedactedCallerBaseUrl(value) {
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/_codex-router\/\[REDACTED\]\/v1$/.exec(value);
  return Boolean(match && Number(match[1]) <= 65_535);
}

// This is deliberately a renderer, not an integration manager. CC Switch owns
// its database and profile selection; the Router only gives an authenticated
// local caller the TOML it may choose to paste into an aggregate profile.
export function renderAggregateSnippet({ routedCatalogPath, callerBaseUrl }) {
  const catalog = requiredString(routedCatalogPath, "routedCatalogPath");
  const baseUrl = requiredString(callerBaseUrl, "callerBaseUrl");
  return `model_provider = "custom"
model = "gpt-5.6-sol"
model_catalog_json = ${JSON.stringify(catalog)}

[model_providers.custom]
name = "Codex Router (aggregate)"
base_url = ${JSON.stringify(baseUrl)}
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
supports_standalone_web_search = true
`;
}

// Status is safe for diagnostic surfaces. Its caller must supply an already
// redacted URL: accepting a real capability here would make accidental log or
// support-bundle disclosure too easy.
export function aggregateSnippetStatus({ routedCatalogPath, redactedBaseUrl }) {
  const baseUrl = requiredString(redactedBaseUrl, "redactedBaseUrl");
  if (baseUrl !== "unavailable" && !canonicalRedactedCallerBaseUrl(baseUrl)) {
    throw new TypeError("redactedBaseUrl must be the canonical redacted caller URL or unavailable.");
  }
  return {
    modelCatalogJson: requiredString(routedCatalogPath, "routedCatalogPath"),
    baseUrl,
    supportsStandaloneWebSearch: true,
  };
}
