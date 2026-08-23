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

function argumentMarkup(command) {
  const fields = [];
  const name = command.name;
  const credentialProvider = name === "credential.status" || name === "credential.set" || name === "credential.remove";
  const hasProvider = credentialProvider || name === "provider.enable" || name === "usage.provider";
  const hasSlug = /^(model\.visibility|model\.canary|picker\.set|subagents\.model|subagents\.verify|protocol-proof\.(?:status|verify|revoke)|usage\.model)$/.test(name);
  if (credentialProvider) fields.push('<select data-argument="provider" aria-label="Provider"><option value="deepseek">DeepSeek</option><option value="qwen-plan">Qwen Plan</option></select>');
  else if (hasProvider) fields.push('<input data-argument="provider" type="text" autocomplete="off" spellcheck="false" placeholder="Provider" aria-label="Provider" />');
  if (hasSlug) fields.push('<input data-argument="slug" type="text" autocomplete="off" spellcheck="false" placeholder="Model slug" aria-label="Model slug" />');
  if (name === "vision.pull") fields.push('<input data-argument="tag" type="text" autocomplete="off" spellcheck="false" placeholder="Model tag" aria-label="Model tag" />');
  if (name === "vision.engine") fields.push('<input data-argument="engine" type="text" autocomplete="off" spellcheck="false" placeholder="auto" aria-label="Vision engine" value="auto" />');
  if (name === "vision.effort") fields.push('<input data-argument="effort" type="text" autocomplete="off" spellcheck="false" placeholder="default" aria-label="Vision effort" value="default" />');
  if (name === "presence.mode") fields.push('<select data-argument="mode" aria-label="Presence mode"><option value="always">always</option><option value="follow-codex">follow-codex</option><option value="follow-clients">follow-clients</option></select>');
  if (name === "subagents.mode") fields.push('<select data-argument="mode" aria-label="Subagent mode"><option value="proven">proven</option><option value="selected">selected</option><option value="all">all</option></select>');
  if (name === "subagents.selection") fields.push('<select data-argument="selection" aria-label="Subagent selection"><option value="select-all">select-all</option><option value="unselect-all">unselect-all</option></select>');
  if (name === "tool-result-aging.ttl") fields.push('<input data-argument="days" type="number" min="0" step="1" placeholder="days" aria-label="Age days" />');
  if (name === "tool-result-aging.purge") fields.push('<label><input data-argument="expiredOnly" type="checkbox" /> Expired only</label>');
  if (["provider.enable", "model.canary", "subagents.model"].includes(name)) fields.push('<label><input data-argument="enabled" type="checkbox" checked /> Enabled</label>');
  if (name === "model.visibility" || name === "picker.set") fields.push('<label><input data-argument="visible" type="checkbox" checked /> Visible</label>');
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
  return `<div class="capability-action" data-capability-action="true"><button type="button" ${attributes}>${html(commandLabel(command.name))}</button>${argumentMarkup(command)}${detail ? `<small class="capability-detail">${html(detail)}</small>` : ""}${command.resultKind === "protected-text" ? '<pre class="capability-result" data-protected-output="true" data-result-kind="protected-text" hidden></pre>' : '<output class="capability-result" data-result-kind="json" hidden></output>'}</div>`;
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
