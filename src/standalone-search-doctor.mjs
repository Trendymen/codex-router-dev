export const SEARCH_CONFIG_SNIPPET = `web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
`;

function valuesFromToml(contents) {
  const values = {
    webSearch: false,
    suppressWarning: false,
    standaloneWebSearch: false,
  };
  let table = "root";
  for (const rawLine of String(contents || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, "").trim();
    if (!line) continue;
    const tableMatch = line.match(/^\[([^\]]+)]$/);
    if (tableMatch) {
      table = tableMatch[1].trim();
      continue;
    }
    if (table === "root" && /^web_search\s*=\s*"live"\s*$/.test(line)) {
      values.webSearch = true;
    }
    if (table === "root" && /^suppress_unstable_features_warning\s*=\s*true\s*$/.test(line)) {
      values.suppressWarning = true;
    }
    if (table === "features" && /^standalone_web_search\s*=\s*true\s*$/.test(line)) {
      values.standaloneWebSearch = true;
    }
  }
  return values;
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
  const values = typeof codexConfig === "object" && codexConfig !== null
    ? valuesFromObject(codexConfig)
    : valuesFromToml(codexConfig);
  const missing = [];
  if (!values.webSearch) missing.push("web_search");
  if (!values.suppressWarning) missing.push("suppress_unstable_features_warning");
  if (!values.standaloneWebSearch) missing.push("features.standalone_web_search");
  return { ok: missing.length === 0, missing, snippet: SEARCH_CONFIG_SNIPPET };
}
