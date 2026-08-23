import { getLocale, t } from "./i18n.mjs";

const DAY_MS = 24 * 60 * 60 * 1_000;

export function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

export function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens < 1_000) return Math.round(tokens).toLocaleString(getLocale());
  if (tokens < 1_000_000) return `${trimFixed(tokens / 1_000, tokens < 10_000 ? 1 : 0)}k`;
  return `${trimFixed(tokens / 1_000_000, tokens < 10_000_000 ? 1 : 0)}m`;
}

export function exactTokens(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString(getLocale());
}

export function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dailySeries(buckets = [], days = 7, today = new Date()) {
  const indexed = new Map(
    buckets.map((bucket) => [String(bucket.startDate), Number(bucket.tokens) || 0]),
  );
  const anchor = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(anchor.getTime() - (days - index - 1) * DAY_MS);
    const key = localDateKey(date);
    return {
      key,
      label: new Intl.DateTimeFormat(getLocale(), { weekday: "short" }).format(date),
      longLabel: new Intl.DateTimeFormat(getLocale(), {
        month: "short",
        day: "numeric",
      }).format(date),
      tokens: indexed.get(key) ?? 0,
    };
  });
}

export function chartGeometry(series, width = 328, height = 112, padding = 10) {
  const values = series.map((point) => Math.max(0, Number(point.tokens) || 0));
  const ceiling = Math.max(...values, 1);
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const points = values.map((value, index) => ({
    x: padding + (values.length === 1 ? usableWidth / 2 : (index / (values.length - 1)) * usableWidth),
    y: padding + usableHeight - (value / ceiling) * usableHeight,
    value,
  }));
  const line = smoothPath(points);
  const baseline = height - padding;
  const area = points.length
    ? `${line} L ${points.at(-1).x.toFixed(2)} ${baseline} L ${points[0].x.toFixed(2)} ${baseline} Z`
    : "";
  return { points, line, area, ceiling };
}

export function quotaWindow(metric = {}) {
  const label = String(metric.label || "").toLowerCase().replace(/[–—]/g, "-");
  const minutes = Number(metric.windowDurationMins);
  if (
    label.includes("5-hour") ||
    label.includes("5 hour") ||
    label.includes("five-hour") ||
    minutes === 300
  ) {
    return { key: "five-hour", label: t("usage.fiveHourLimit") };
  }
  if (label.includes("week") || minutes === 10_080) {
    return { key: "weekly", label: t("usage.weeklyLimit") };
  }
  if (label.includes("month") || minutes === 43_200) {
    return { key: "monthly", label: t("usage.monthlyLimit") };
  }
  return null;
}

export function metricPercent(metric = {}) {
  const direct = clampPercent(metric.usedPercent);
  if (direct !== null) return direct;
  const used = Number(metric.used);
  const limit = Number(metric.limit);
  return Number.isFinite(used) && Number.isFinite(limit) && limit > 0
    ? clampPercent((used / limit) * 100)
    : null;
}

// Quota data is normalized internally as percentage used, but the tray's
// allowance surfaces should answer the operator's question: how much is left.
// Prefer an explicitly reported remaining value, then derive it from the
// provider's used counters or percentage.
export function metricRemainingPercent(metric = {}) {
  const direct = clampPercent(metric.remainingPercent);
  if (direct !== null) return direct;
  const used = metricPercent(metric);
  return used === null ? null : 100 - used;
}

export function buildQuotaCards({ account, providerUsage, providerSetup } = {}) {
  const cards = [];
  const seen = new Set();
  const add = (providerId, providerName, metric, source = "account") => {
    if (!metric || metric.kind && metric.kind !== "quota") return;
    const window = quotaWindow(metric);
    if (!window) return;
    const key = `${providerId}:${window.key}`;
    if (seen.has(key)) return;
    seen.add(key);
    cards.push({
      key,
      providerId,
      providerName,
      source,
      window: window.key,
      label: window.label,
      usedPercent: metricPercent(metric),
      remainingPercent: metricRemainingPercent(metric),
      resetAt: Number(metric.resetsAt ?? metric.resetAt) || null,
    });
  };

  if (account?.primary) add("openai", "ChatGPT", account.primary);
  if (account?.secondary) add("openai", "ChatGPT", account.secondary);

  const configured = new Set(
    (providerSetup?.providers || [])
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
  );
  for (const provider of providerUsage?.providers || []) {
    if (!configured.has(provider.id)) continue;
    for (const metric of provider.account?.metrics || []) {
      add(provider.id, provider.displayName || provider.id, metric, "provider");
    }
  }
  return cards;
}

export function sourceOptions({ account, providerUsage, providerSetup } = {}) {
  const options = [];
  if (account?.dailyUsageBuckets) {
    options.push({
      id: "openai",
      name: "ChatGPT",
      buckets: account.dailyUsageBuckets,
      kind: "account",
    });
  }
  const configured = new Set(
    (providerSetup?.providers || [])
      .filter((provider) => provider.configured)
      .map((provider) => provider.id),
  );
  for (const provider of providerUsage?.providers || []) {
    if (!configured.has(provider.id)) continue;
    options.push({
      id: provider.id,
      name: provider.displayName || provider.id,
      buckets: provider.dailyUsageBuckets || [],
      kind: "provider",
    });
  }
  return options;
}

export function formatReset(unixSeconds, now = new Date()) {
  if (!Number.isFinite(Number(unixSeconds)) || Number(unixSeconds) <= 0) return t("usage.resetUnavailable");
  const date = new Date(Number(unixSeconds) * 1_000);
  const sameDay = localDateKey(date) === localDateKey(now);
  const tomorrow = localDateKey(date) === localDateKey(new Date(now.getTime() + DAY_MS));
  const time = new Intl.DateTimeFormat(getLocale(), {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return t("usage.resetsToday", { time });
  if (tomorrow) return t("usage.resetsTomorrow", { time });
  return t("usage.resetsAt", { date: new Intl.DateTimeFormat(getLocale(), {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date) });
}

export function todayTokens(source, today = new Date()) {
  const key = localDateKey(today);
  return Number((source?.buckets || []).find((bucket) => bucket.startDate === key)?.tokens) || 0;
}

export function sevenDayTokens(source, today = new Date()) {
  return dailySeries(source?.buckets || [], 7, today).reduce((total, point) => total + point.tokens, 0);
}

export function observedModelSpeed(providerUsage, providerId, modelSlug) {
  if (!modelSlug) return null;
  const displayName = String(modelSlug).split("/").at(-1);
  const providers = providerUsage?.providers || [];
  const preferred = providers.find((provider) => provider.id === providerId);
  const candidates = preferred ? [preferred, ...providers.filter((provider) => provider !== preferred)] : providers;
  const model = candidates
    .flatMap((provider) => provider.models || [])
    .find((entry) => entry.slug === modelSlug || entry.displayName === displayName);
  if (model?.observedTokensPerSecond === null || model?.observedTokensPerSecond === undefined) {
    return null;
  }
  const speed = Number(model?.observedTokensPerSecond);
  return Number.isFinite(speed) && speed >= 0
    ? { speed, samples: Math.max(0, Number(model.speedSampleCount) || 0) }
    : null;
}

// The router's own browser panel serves this same UI but answers only the
// reading half of the command table, and says so in platform_info. A surface
// that advertises nothing -- the Tauri tray, the Electron window -- carries the
// full table, so nothing is refused there and nothing about it changes.
export function readOnlyCapabilities(platform) {
  const capabilities = platform?.capabilities;
  return capabilities?.readOnly === true ? capabilities : null;
}

// Answered from the lists the surface sent, never from a copy of the allowlist
// kept here: a second copy is the drift this exists to prevent. The commands a
// read-only surface answers from its own process (show/hide, island state) are
// permitted too, because it does answer them.
export function commandRefused(capabilities, command) {
  if (!capabilities || !command) return false;
  const allowed = capabilities.allowedCommands || [];
  const local = capabilities.localCommands || [];
  return !allowed.includes(command) && !local.includes(command);
}

// Absent is not "on". src/tool-result-aging-state.mjs defaults the feature off
// when nobody has answered, so a snapshot the panel could not read has to
// render off rather than promise ageing that is not happening.
export function toolResultAgingChecked(aging) {
  return aging?.enabled === true;
}

// The browser is deliberately a manifest consumer.  It must not grow a
// second command list in markup or event handlers: the Node snapshot is the
// only authority for which sections and actions exist on this surface.
const BROWSER_SCHEMA_VERSION = 1;
const COMMAND_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SECRET_FIELD = /(?:api.?key|caller.?key|access.?token|authorization|csrf|password|secret|bearer|credential|cookie|session.?id|confirmation|bootstrap|nonce|token)/i;

function browserManifestSupported(manifest) {
  return Boolean(manifest && typeof manifest === "object" && manifest.capabilitySchemaVersion === BROWSER_SCHEMA_VERSION);
}

export function readOnlyIncompatibility(manifest) {
  const reported = Number.isSafeInteger(manifest?.capabilitySchemaVersion)
    ? manifest.capabilitySchemaVersion
    : "unknown";
  return {
    id: "capability-compatibility",
    title: "Read-only compatibility",
    description: `Capability schema ${reported} is not supported for browser mutations.`,
    readOnly: true,
    browser: true,
    nodeCommands: [],
    commands: [],
  };
}

function commandMetadata(manifest) {
  const result = new Map();
  for (const item of Array.isArray(manifest?.commands) ? manifest.commands : []) {
    if (item && typeof item.name === "string" && COMMAND_ID.test(item.name)) result.set(item.name, item);
  }
  return result;
}

function normalizedCommand(manifest, name) {
  const source = commandMetadata(manifest).get(name) || {};
  return {
    name,
    arguments: source.arguments || { type: "object", additionalProperties: false, properties: {}, required: [] },
    ui: source.ui || {},
    mutating: source.mutating === true,
    confirmation: source.confirmation === true,
    quotaWarning: source.quotaWarning === true,
    protectedInput: source.protectedInput === true,
    resultKind: source.resultKind || "json",
  };
}

/**
 * Return the browser-visible capability sections from a versioned snapshot.
 * Unknown major versions intentionally collapse to one read-only message.
 */
export function visibleSections(manifest) {
  if (!browserManifestSupported(manifest)) return [readOnlyIncompatibility(manifest)];
  return (Array.isArray(manifest.capabilities) ? manifest.capabilities : [])
    .filter((item) => item && item.browser)
    .map((item) => ({
      ...item,
      readOnly: false,
      commands: (Array.isArray(item.nodeCommands) ? item.nodeCommands : [])
        .filter((name) => typeof name === "string" && COMMAND_ID.test(name))
        .map((name) => normalizedCommand(manifest, name)),
    }));
}

/** Return canonical command IDs advertised by all browser-visible sections. */
export function browserCommandIds(manifest) {
  return [...new Set(visibleSections(manifest).flatMap((section) => section.commands.map(({ name }) => name)))];
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function commandLabel(name) {
  return name
    .split(".")
    .map((part) => part.replaceAll("-", " "))
    .join(" · ");
}

function sampleString(schema, key) {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (key === "provider") return "deepseek";
  if (key === "slug") return "model/test";
  if (key === "tag") return "test-model";
  if (key === "engine") return "auto";
  if (key === "effort") return "default";
  if (schema.pattern?.includes("follow")) return "always";
  const enumLike = schema.pattern?.match(/^\^\(([^|)]+)/);
  if (enumLike) return enumLike[1];
  return "value";
}

function schemaTypes(schema) {
  return Array.isArray(schema?.type) ? schema.type : [schema?.type];
}

/** Generate a deterministic valid argument object from a command schema. */
export function browserArgumentsForCommand(definition) {
  const schema = definition?.arguments || { type: "object", properties: {}, required: [] };
  const result = {};
  for (const key of schema.required || []) {
    const property = schema.properties?.[key] || {};
    const types = schemaTypes(property);
    if (types.includes("boolean")) result[key] = false;
    else if (types.includes("integer")) result[key] = 0;
    else if (types.includes("string")) result[key] = sampleString(property, key);
    else if (types.includes("null")) result[key] = null;
    else result[key] = null;
  }
  return result;
}

function argumentMarkup(command) {
  const fields = [];
  const schema = command.arguments || { properties: {}, required: [] };
  const required = new Set(schema.required || []);
  for (const [key, property] of Object.entries(schema.properties || {})) {
    const types = schemaTypes(property);
    const label = html(key.replaceAll("_", " "));
    const typeAttribute = html(types.join("|"));
    const metadata = `data-argument="${html(key)}" data-argument-type="${typeAttribute}" data-argument-required="${required.has(key)}" aria-label="${label}"`;
    if (Array.isArray(property.enum)) {
      fields.push(`<select ${metadata}>${property.enum.map((value) => `<option value="${html(value)}">${html(value)}</option>`).join("")}</select>`);
    } else if (types.includes("boolean")) {
      fields.push(`<label><input ${metadata} type="checkbox"${required.has(key) ? " checked" : ""} /> ${label}</label>`);
    } else if (types.includes("integer") && types.includes("null")) {
      fields.push(`<select ${metadata}><option value="0">0</option><option value="null">null</option></select>`);
    } else if (types.includes("integer")) {
      fields.push(`<input ${metadata} type="number" min="0" step="1" value="0" />`);
    } else {
      const value = sampleString(property, key);
      fields.push(`<input ${metadata} type="text" autocomplete="off" spellcheck="false" value="${html(value)}" />`);
    }
  }
  if (command.protectedInput) {
    // This is the only browser field that may carry a credential. It never
    // becomes part of serialized panel state; the bridge peels it off at the
    // trusted boundary and the action handler clears it after submit.
    fields.push('<input class="capability-secret" type="password" autocomplete="off" spellcheck="false" data-protected-field="apiKey" aria-label="Credential" />');
  }
  return fields.join("");
}

function actionMarkup(command) {
  const attributes = [
    `data-command="${html(command.name)}"`,
    `data-confirmation="${command.confirmation ? "server" : "none"}"`,
    `data-quota-warning="${command.quotaWarning ? "true" : "false"}"`,
    `data-protected-input="${command.protectedInput ? "true" : "false"}"`,
    `data-result-kind="${html(command.resultKind)}"`,
  ].join(" ");
  const detail = [
    command.confirmation ? "Server confirmation required" : "",
    command.quotaWarning ? "May consume provider quota" : "",
    command.protectedInput ? "Protected input" : "",
  ].filter(Boolean).join(" · ");
  const protectedResult = command.resultKind === "protected-text";
  return `<div class="capability-action" data-capability-action="true"><button type="button" ${attributes}>${html(commandLabel(command.name))}</button>${argumentMarkup(command)}${detail ? `<small class="capability-detail">${html(detail)}</small>` : ""}${protectedResult ? '<pre class="capability-result" data-protected-output="true" data-result-kind="protected-text" hidden></pre><button class="copy-result" type="button" data-copy-result="protected" aria-label="Copy protected result" disabled>Copy</button>' : '<output class="capability-result" data-result-kind="json" hidden></output>'}</div>`;
}

/**
 * Produce the browser workspace markup from the received manifest. This is
 * intentionally a pure function so source/unit tests can prove the inverse
 * capability contract without starting a browser or a router.
 */
export function renderCapabilitySurface(manifest) {
  return visibleSections(manifest).map((section) => {
    if (section.readOnly) {
      return `<section class="capability-section capability-incompatible" data-capability-id="${html(section.id)}" data-read-only="true"><h2>${html(section.title)}</h2><p>${html(section.description)}</p></section>`;
    }
    const commands = section.commands.map(actionMarkup).join("");
    return `<section class="capability-section" data-capability-id="${html(section.id)}"><header><p class="eyebrow">Capability</p><h2>${html(section.id)}</h2><p>${html(section.browser === "full" ? "Available on this browser session." : section.browser === "protected" ? "Protected channel actions." : "Write-session actions with server policy.")}</p></header><div class="capability-actions">${commands}</div></section>`;
  }).join("");
}

// UI state serialization is used only for in-memory diagnostics and tests. It
// is intentionally conservative: a secret-looking field is omitted before a
// caller can hand the result to any future snapshot, log, or history helper.
export function serializeBrowserState(value, state = { seen: new WeakSet(), depth: 0 }) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= 64 * 1024 ? value : undefined;
  if (!value || typeof value !== "object" || state.seen.has(value) || state.depth > 16) return undefined;
  state.seen.add(value);
  if (Array.isArray(value)) return value.map((item) => serializeBrowserState(item, { ...state, depth: state.depth + 1 })).filter((item) => item !== undefined);
  const output = {};
  for (const key of Object.keys(value)) {
    if (SECRET_FIELD.test(key)) continue;
    const item = serializeBrowserState(value[key], { ...state, depth: state.depth + 1 });
    if (item !== undefined) output[key] = item;
  }
  return output;
}

// RFC 8785-compatible JSON serialization for the plain argument values the
// browser command schemas admit. Object keys are sorted recursively and no
// secret-bearing protected field is included by the caller before hashing.
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not accept non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("canonical JSON accepts only JSON values");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export async function canonicalArgumentsHash(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw new Error("The browser crypto digest API is unavailable.");
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value))));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === "function" ? btoa(binary) : Buffer.from(digest).toString("base64");
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function createBrowserOperationState({ uuid = () => globalThis.crypto?.randomUUID?.(), maxRecords = 64 } = {}) {
  const records = new Map();
  function begin(command, args) {
    const requestId = uuid?.();
    if (typeof requestId !== "string") throw new Error("A UUID source is required for browser operations.");
    const operation = { operationId: requestId, requestId, command, args: serializeBrowserState(args), status: "in-flight", attempts: 0, applied: false, result: undefined };
    records.set(operation.operationId, operation);
    while (records.size > maxRecords) records.delete(records.keys().next().value);
    return operation;
  }
  function get(operationId) { return records.get(operationId); }
  function retry(operationId) {
    const operation = records.get(operationId);
    if (!operation) return undefined;
    operation.attempts += 1;
    return operation;
  }
  function apply(operationId, result, effect) {
    const operation = records.get(operationId);
    if (!operation || operation.applied) return false;
    operation.applied = true;
    operation.status = "completed";
    operation.result = result;
    effect?.(result);
    return true;
  }
  function fail(operationId, result, effect) {
    const operation = records.get(operationId);
    if (!operation || operation.applied) return false;
    operation.applied = true;
    operation.status = "failed";
    operation.result = result;
    effect?.(result);
    return true;
  }
  function timeout(operationId) {
    const operation = records.get(operationId);
    if (!operation || operation.applied) return false;
    operation.status = "timed-out";
    return true;
  }
  return Object.freeze({ begin, get, retry, apply, fail, timeout });
}

function smoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midpoint = (previous.x + current.x) / 2;
    path += ` C ${midpoint.toFixed(2)} ${previous.y.toFixed(2)}, ${midpoint.toFixed(2)} ${current.y.toFixed(2)}, ${current.x.toFixed(2)} ${current.y.toFixed(2)}`;
  }
  return path;
}

function trimFixed(value, digits) {
  return value.toFixed(digits).replace(/\.0$/, "");
}
