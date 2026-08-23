import {
  buildQuotaCards,
  chartGeometry,
  commandRefused,
  compactTokens,
  dailySeries,
  exactTokens,
  formatReset,
  observedModelSpeed,
  readOnlyCapabilities,
  sevenDayTokens,
  sourceOptions,
  todayTokens,
  toolResultAgingChecked,
  renderCapabilitySurface,
  serializeBrowserState,
  visibleSections,
} from "./model.mjs";
import { createThinkingOrb } from "./thinking-orb.mjs";
import {
  applyTranslations,
  availableLanguages,
  getLanguage,
  setLanguage,
  t,
} from "./i18n.mjs";

const invoke = window.__TAURI__?.core?.invoke;
const view = new URLSearchParams(window.location.search).get("view") || "panel";
const browserPanel = window.__CODEX_ROUTER_PANEL__ === true;

// What the surface hosting this UI is willing to run, as the surface itself
// reported it. Null until platform_info answers, and null forever in the tray
// and the Electron window, which advertise no limit and carry the full command
// table: every check below is a no-op for them.
let capabilities = null;

applyTranslations(document);

if (view === "island") {
  document.getElementById("island").hidden = false;
  startIsland();
} else if (browserPanel) {
  startBrowserPanel();
} else {
  document.getElementById("panel").hidden = false;
  startPanel();
}

function startBrowserPanel() {
  const panel = document.getElementById("panel");
  if (!panel || !invoke) return;
  const state = {
    manifest: window.__CODEX_ROUTER_MANIFEST__ || null,
    snapshot: null,
    busy: new Set(),
    feedback: "Session ready. Actions use the router's canonical command contract.",
    error: false,
  };

  panel.hidden = false;
  // The browser gets a clean capability workspace. Native shells continue to
  // use the richer local presentation below; no browser control is inferred
  // from that presentation's historical sections.
  panel.replaceChildren();
  panel.className = "panel browser-panel";
  panel.innerHTML = `
    <header class="browser-panel-header">
      <div class="brand"><span class="brand-mark" aria-hidden="true"><i></i></span><span><strong>Model Router</strong><small id="browser-session-status">Browser write session</small></span></div>
      <button class="text-button" type="button" data-browser-action="refresh">Refresh</button>
    </header>
    <section class="browser-orientation" aria-live="polite">
      <div><p class="eyebrow">Operational surface</p><h1>Router controls</h1><p id="browser-feedback"></p></div>
      <span id="browser-schema-status" class="status-marker">Checking contract</span>
    </section>
    <div id="browser-capability-workspace" class="capability-workspace"></div>
  `;
  const workspace = panel.querySelector("#browser-capability-workspace");
  const feedback = panel.querySelector("#browser-feedback");
  const schemaStatus = panel.querySelector("#browser-schema-status");
  const sessionStatus = panel.querySelector("#browser-session-status");

  function render() {
    feedback.textContent = state.feedback;
    feedback.classList.toggle("is-error", state.error);
    const sections = visibleSections(state.manifest);
    schemaStatus.textContent = sections.some((section) => section.readOnly)
      ? "Read-only compatibility"
      : `${sections.length} capability areas`;
    schemaStatus.classList.toggle("is-warning", sections.some((section) => section.readOnly));
    workspace.innerHTML = renderCapabilitySurface(state.manifest);
    applyBrowserActionState();
  }

  function applyBrowserActionState() {
    for (const button of workspace.querySelectorAll("button[data-command]")) {
      button.disabled = state.busy.has(button.dataset.command);
      const action = button.closest(".capability-action");
      const output = action?.querySelector(".capability-result");
      if (output && state.busy.has(button.dataset.command)) output.hidden = false;
    }
  }

  function resultText(value) {
    if (typeof value === "string") return value;
    const safe = serializeBrowserState(value);
    return safe === undefined ? "Command completed." : JSON.stringify(safe, null, 2);
  }

  async function runBrowserCommand(button) {
    const command = button.dataset.command;
    if (!command || state.busy.has(command)) return;
    if (button.dataset.confirmation === "server" && !window.confirm("此操作需要服务器确认，是否继续？")) return;
    const action = button.closest(".capability-action");
    const output = action?.querySelector(".capability-result");
    const args = collectBrowserArguments(action, command);
    state.busy.add(command);
    state.error = false;
    state.feedback = `${command} is being verified by the router…`;
    if (output) {
      output.hidden = false;
      output.textContent = "Working…";
    }
    renderFeedbackOnly();
    try {
      const value = await invoke(command, args);
      state.feedback = `${command} completed. Repeated responses reuse the same result slot.`;
      if (output) output.textContent = resultText(value);
      if (command === "lifecycle.status" && value?.capabilities) {
        state.manifest = value.capabilities;
        render();
      }
    } catch (error) {
      state.error = true;
      state.feedback = errorMessage(error);
      if (output) output.textContent = state.feedback;
    } finally {
      state.busy.delete(command);
      applyBrowserActionState();
      renderFeedbackOnly();
    }
  }

  function renderFeedbackOnly() {
    feedback.textContent = state.feedback;
    feedback.classList.toggle("is-error", state.error);
    applyBrowserActionState();
  }

  panel.addEventListener("click", (event) => {
    const refresh = event.target.closest("[data-browser-action=refresh]");
    if (refresh) {
      refreshBrowserStatus();
      return;
    }
    const button = event.target.closest("button[data-command]");
    if (button) runBrowserCommand(button);
  });

  render();
  refreshBrowserStatus();

  async function refreshBrowserStatus() {
    try {
      const value = await invoke("lifecycle.status", {});
      state.snapshot = value;
      if (value?.capabilities) state.manifest = value.capabilities;
      state.error = false;
      state.feedback = "Session ready. Capability manifest refreshed.";
      sessionStatus.textContent = "Browser write session · live";
      render();
    } catch (error) {
      state.error = true;
      state.feedback = errorMessage(error);
      sessionStatus.textContent = "Browser write session · unavailable";
      renderFeedbackOnly();
    }
  }
}

function collectBrowserArguments(action, command) {
  const args = {};
  for (const field of action?.querySelectorAll("[data-argument]") || []) {
    const key = field.dataset.argument;
    if (!key) continue;
    if (field.type === "checkbox") args[key] = field.checked;
    else if (field.value !== "") args[key] = field.value;
  }
  const secret = action?.querySelector("[data-protected-field=apiKey]");
  if (secret) {
    args.apiKey = secret.value;
    secret.value = "";
  }
  // Zero-argument status commands intentionally remain `{}`; command IDs are
  // canonical and the Node side owns the final schema validation.
  void command;
  return args;
}

function startPanel() {
  const state = {
    snapshot: null,
    account: null,
    providerUsage: null,
    providerSetup: null,
    visionBridge: null,
    visionDownload: null,
    visionPollTimer: null,
    presence: null,
    modelSettings: null,
    health: null,
    platform: null,
    settings: null,
    selectedSource: null,
    usageRange: 7,
    sourceWasChosen: false,
    busyProvider: null,
    modelSettingsBusy: false,
    lastActivityState: null,
    presenceBusy: false,
    visionBusy: false,
    maintenanceBusy: null,
    maintenanceResult: null,
    toolResultAgingBusy: false,
    readOnlyWatched: false,
    keyProvider: null,
    removeProvider: null,
    toastTimer: null,
  };

  const elements = {
    panel: document.getElementById("panel"),
    readOnlyNote: document.getElementById("read-only-note"),
    tabs: [...document.querySelectorAll(".tab")],
    usageView: document.getElementById("usage-view"),
    statusView: document.getElementById("status-view"),
    connectionsView: document.getElementById("connections-view"),
    modelsView: document.getElementById("models-view"),
    close: document.getElementById("close-panel"),
    routerStatus: document.getElementById("router-status"),
    liveState: document.getElementById("live-state"),
    source: document.getElementById("usage-source"),
    usageRange: document.getElementById("usage-range"),
    usageRangeLabel: document.getElementById("usage-range-label"),
    today: document.getElementById("today-tokens"),
    week: document.getElementById("week-tokens"),
    speedModel: document.getElementById("speed-model"),
    speedDetail: document.getElementById("speed-detail"),
    modelSpeed: document.getElementById("model-speed"),
    chartWrap: document.getElementById("chart-wrap"),
    chartLine: document.getElementById("chart-line-path"),
    chartArea: document.getElementById("chart-area-path"),
    chartPoints: document.getElementById("chart-points"),
    chartDays: document.getElementById("chart-days"),
    chartTooltip: document.getElementById("chart-tooltip"),
    quotaCards: document.getElementById("quota-cards"),
    usageOverview: document.getElementById("usage-overview"),
    statusSummary: document.getElementById("status-summary"),
    activeRequests: document.getElementById("active-requests"),
    quotaResets: document.getElementById("quota-resets"),
    providers: document.getElementById("provider-list"),
    subagentSummary: document.getElementById("subagent-summary"),
    pickerSummary: document.getElementById("picker-summary"),
    subagentAllSwitch: document.getElementById("subagent-all-switch"),
    subagentAllSwitchLabel: document.getElementById("subagent-all-switch-label"),
    subagentModelList: document.getElementById("subagent-model-list"),
    pickerModelList: document.getElementById("picker-model-list"),
    presenceMode: document.getElementById("presence-mode"),
    presenceNote: document.getElementById("presence-note"),
    maintenanceStatus: document.getElementById("maintenance-status"),
    maintenanceNote: document.getElementById("maintenance-note"),
    maintenanceUpdate: document.getElementById("maintenance-update"),
    maintenanceFix: document.getElementById("maintenance-fix"),
    toolResultAgingSwitch: document.getElementById("tool-result-aging-switch"),
    toolResultAgingSwitchLabel: document.getElementById("tool-result-aging-switch-label"),
    toolResultAgingNote: document.getElementById("tool-result-aging-note"),
    visionSummary: document.getElementById("vision-summary"),
    visionNote: document.getElementById("vision-note"),
    visionSwitch: document.getElementById("vision-switch"),
    visionSwitchLabel: document.getElementById("vision-switch-label"),
    visionEngine: document.getElementById("vision-engine"),
    visionEffort: document.getElementById("vision-effort"),
    visionLocalModels: document.getElementById("vision-local-models"),
    refresh: document.getElementById("refresh-data"),
    islandSwitch: document.getElementById("island-switch"),
    islandSwitchLabel: document.getElementById("island-switch-label"),
    islandNote: document.getElementById("island-note"),
    toast: document.getElementById("toast"),
    keyDialog: document.getElementById("key-dialog"),
    keyTitle: document.getElementById("key-dialog-title"),
    keyForm: document.getElementById("key-form"),
    keyInput: document.getElementById("api-key"),
    closeDialog: document.getElementById("close-dialog"),
    cancelKey: document.getElementById("cancel-key"),
    removeDialog: document.getElementById("remove-dialog"),
    removeTitle: document.getElementById("remove-dialog-title"),
    removeBody: document.getElementById("remove-dialog-body"),
    removeForm: document.getElementById("remove-form"),
    closeRemoveDialog: document.getElementById("close-remove-dialog"),
    cancelRemove: document.getElementById("cancel-remove"),
    language: document.getElementById("language-select"),
  };

  if (elements.language) {
    elements.language.innerHTML = availableLanguages()
      .map((language) => `<option value="${language.id}">${language.label}</option>`)
      .join("");
    elements.language.value = getLanguage();
    elements.language.addEventListener("change", () => {
      setLanguage(elements.language.value);
      applyTranslations(document);
      renderPanel();
    });
  }

  elements.tabs.forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  });
  elements.close.addEventListener("click", () => shellCall("hide_panel"));
  elements.refresh.addEventListener("click", () => refreshPanel());
  elements.source.addEventListener("change", () => {
    state.selectedSource = elements.source.value;
    state.sourceWasChosen = true;
    renderUsage();
  });
  elements.usageRange.addEventListener("change", () => {
    const selected = Number(elements.usageRange.value);
    state.usageRange = [7, 30, 90].includes(selected) ? selected : 7;
    renderUsage();
  });
  elements.providers.addEventListener("click", handleProviderClick);
  elements.providers.addEventListener("change", handleProviderToggle);
  document.querySelectorAll(".accordion-header").forEach((button) => {
    button.addEventListener("click", () => toggleAccordion(button));
  });
  elements.subagentAllSwitch.addEventListener("change", handleSubagentAllToggle);
  elements.subagentModelList.addEventListener("change", handleModelSettingsToggle);
  elements.subagentModelList.addEventListener("click", handleModelSettingsClick);
  elements.pickerModelList.addEventListener("change", handleModelSettingsToggle);
  elements.pickerModelList.addEventListener("click", handleModelSettingsClick);
  elements.visionLocalModels.addEventListener("click", handleVisionClick);
  elements.presenceMode.addEventListener("change", handlePresenceModeChange);
  elements.toolResultAgingSwitch.addEventListener("change", handleToolResultAgingToggle);
  elements.visionSwitch.addEventListener("change", handleVisionToggle);
  elements.visionEngine.addEventListener("change", handleVisionEngineChange);
  elements.visionEffort.addEventListener("change", handleVisionEffortChange);
  elements.maintenanceUpdate.addEventListener("click", () => runMaintenance("update"));
  elements.maintenanceFix.addEventListener("click", () => runMaintenance("fix"));
  elements.islandSwitch.addEventListener("change", handleIslandToggle);
  elements.keyForm.addEventListener("submit", saveKey);
  elements.closeDialog.addEventListener("click", closeKeyDialog);
  elements.cancelKey.addEventListener("click", closeKeyDialog);
  elements.keyDialog.addEventListener("close", () => {
    elements.keyInput.value = "";
    state.keyProvider = null;
  });
  elements.removeForm.addEventListener("submit", removeKey);
  elements.closeRemoveDialog.addEventListener("click", closeRemoveDialog);
  elements.cancelRemove.addEventListener("click", closeRemoveDialog);
  elements.removeDialog.addEventListener("close", () => {
    state.removeProvider = null;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.keyDialog.open && !elements.removeDialog.open) {
      shellCall("hide_panel");
    }
  });

  if (!invoke) {
    elements.routerStatus.textContent = t("status.desktopBridgeUnavailable");
    showToast(t("general.desktopBridgeHint"), true);
    return;
  }

  refreshPanel();
  window.setInterval(refreshHealth, 1_200);
  window.setInterval(() => refreshPanel({ quiet: true }), 60_000);

  function selectTab(tab) {
    const usage = tab === "usage";
    const status = tab === "status";
    const models = tab === "models";
    elements.usageView.hidden = !usage;
    elements.statusView.hidden = !status;
    elements.connectionsView.hidden = usage || status || models;
    elements.modelsView.hidden = !models;
    elements.tabs.forEach((button) => button.classList.toggle("is-active", button.dataset.tab === tab));
  }

  async function refreshPanel({ quiet = false } = {}) {
    elements.refresh.disabled = true;
    const requests = [
      ["snapshot", "lifecycle.status", {}],
      ["account", "native.account-usage", {}],
      ["providerUsage", "usage.provider", {}],
      ["credential:deepseek", "credential.status", { provider: "deepseek" }],
      ["credential:qwen-plan", "credential.status", { provider: "qwen-plan" }],
      ["health", "router_health", {}],
      ["platform", "platform_info", {}],
      ["settings", "desktop_settings", {}],
    ];
    const results = await Promise.all(
      requests.map(async ([key, command, args]) => {
        try {
          return { key, value: ["router_health", "platform_info", "desktop_settings"].includes(command) ? await shellCall(command, args) : await call(command, args) };
        } catch (error) {
          return { key, error };
        }
      }),
    );
    const errors = [];
    for (const result of results) {
      if ("value" in result) {
        if (result.key.startsWith("credential:")) continue;
        state[result.key] = result.value;
      }
      else errors.push(result.error);
    }
    state.providerSetup = {
      providers: results
        .filter((result) => result.key.startsWith("credential:") && result.value?.status)
        .map((result) => result.value.status),
    };
    // The control snapshot already contains the Vision and presence views.
    // Reusing them avoids starting duplicate Node processes.
    const codexSettings = state.snapshot?.targets?.codex?.modelSettings;
    if (codexSettings?.visionBridge) {
      state.visionBridge = codexSettings.visionBridge;
      state.visionDownload = codexSettings.visionBridge.download || null;
    }
    if (state.snapshot?.presence) state.presence = state.snapshot.presence;
    adoptCapabilities();
    renderPanel();
    elements.refresh.disabled = false;
    if (!quiet && errors.length && !state.snapshot) showToast(errorMessage(errors[0]), true);
  }

  async function refreshHealth() {
    try {
      state.health = await shellCall("router_health");
      renderStatus();
    } catch {
      state.health = { ok: false, activity: { state: "offline" } };
      renderStatus();
    }
    const nextActivityState = state.health?.activity?.state || "offline";
    if (state.lastActivityState === "generating" && nextActivityState !== "generating") {
      call("usage.provider")
        .then((usage) => {
          state.providerUsage = usage;
          renderStatus();
        })
        .catch(() => {});
    }
    state.lastActivityState = nextActivityState;
  }

  // The surface reports what it will run in platform_info; a surface that says
  // nothing keeps the full table. Watching starts once, because the restriction
  // is a property of where this page is served from and cannot change while it
  // is open.
  function adoptCapabilities() {
    capabilities = readOnlyCapabilities(state.platform);
    if (!capabilities || state.readOnlyWatched) return;
    state.readOnlyWatched = true;
    watchReadOnly(elements.panel);
  }

  function renderReadOnlyNote() {
    if (!elements.readOnlyNote) return;
    elements.readOnlyNote.hidden = !capabilities;
    // Re-read on every render rather than once: switching language re-renders,
    // and a note left in the previous language is worse than no note.
    if (capabilities) elements.readOnlyNote.textContent = t("general.readOnlySurface");
  }

  function renderPanel() {
    renderReadOnlyNote();
    renderStatus();
    renderSourcePicker();
    renderUsage();
    renderQuotas();
    renderUsageOverview();
    renderStatusView();
    renderProviders();
    renderPresence();
    renderMaintenance();
    renderIslandSetting();
    renderModelSettings();
    renderToolResultAgingSetting();
    renderVisionBridge();
    // Last, because every render above re-derives `disabled` from its own busy
    // state and would otherwise hand a refused control back to the user. The
    // observer covers later section rebuilds; this covers the static controls,
    // whose tooltips also have to follow a language change.
    if (capabilities) applyReadOnly(elements.panel);
  }

  function renderStatus() {
    const activity = state.health?.activity || {};
    const activityState = state.health?.ok === false ? "offline" : activity.state || "idle";
    const labels = activityLabels();
    elements.liveState.dataset.state = activityState;
    elements.liveState.querySelector("span").textContent = labels[activityState] || t("status.idle");
    if (state.health?.ok) {
      const model = activity.model ? ` · ${activity.model}` : "";
      elements.routerStatus.textContent = t("status.routerOnline", { model });
    } else {
      elements.routerStatus.textContent = t("status.routerOffline");
    }
    renderModelSpeed(activity);
  }

  function renderModelSpeed(activity) {
    const active = activity.active?.at(-1);
    const model = active?.model || activity.model;
    const provider = active?.provider || activity.provider;
    const label = model ? String(model).split("/").at(-1) : t("status.noModelObserved");
    const observed = observedModelSpeed(state.providerUsage, provider, model);
    elements.speedModel.textContent = label;
    elements.modelSpeed.textContent = observed ? `${observed.speed.toFixed(1)} tok/s` : t("status.noSpeed");
    elements.modelSpeed.classList.toggle("is-measured", Boolean(observed));
    elements.speedDetail.textContent = observed
      ? t("status.observedThroughput", {
          count: observed.samples,
          reply: observed.samples === 1 ? t("status.reply") : t("status.replies"),
        })
      : t("status.appearsAfterMeteredReply");
  }

  function renderSourcePicker() {
    const options = sourceOptions(state);
    if (!state.sourceWasChosen) {
      const active = state.health?.activity?.state === "generating" ? state.health.activity.provider : null;
      state.selectedSource = options.some((option) => option.id === active)
        ? active
        : options[0]?.id || null;
    }
    if (!options.some((option) => option.id === state.selectedSource)) {
      state.selectedSource = options[0]?.id || null;
    }
    elements.source.disabled = options.length === 0;
    elements.source.innerHTML = options.length
      ? options
          .map(
            (option) =>
              `<option value="${escapeHtml(option.id)}"${option.id === state.selectedSource ? " selected" : ""}>${escapeHtml(option.name)}</option>`,
          )
          .join("")
      : `<option value="">${escapeHtml(t("usage.noConnectedUsage"))}</option>`;
  }

  function renderUsage() {
    const source = sourceOptions(state).find((option) => option.id === state.selectedSource);
    const series = dailySeries(source?.buckets || [], state.usageRange);
    elements.today.textContent = source ? compactTokens(todayTokens(source)) : "—";
    elements.week.textContent = source
      ? compactTokens(series.reduce((total, point) => total + point.tokens, 0))
      : "\u2014";
    elements.usageRange.value = String(state.usageRange);
    elements.usageRangeLabel.textContent = `${state.usageRange} days`;
    renderChart(series, elements);
  }

  function renderUsageOverview() {
    const providers = (state.providerUsage?.providers || [])
      .filter((provider) => Number(provider.totalTokens) > 0 || Number(provider.requests) > 0)
      .sort((left, right) => Number(right.totalTokens || 0) - Number(left.totalTokens || 0));
    const models = providers
      .flatMap((provider) => (provider.models || []).map((model) => ({ ...model, provider: provider.displayName || provider.id })))
      .filter((model) => Number(model.totalTokens) > 0 || Number(model.requests) > 0)
      .sort((left, right) => Number(right.totalTokens || 0) - Number(left.totalTokens || 0))
      .slice(0, 8);
    if (!providers.length && !models.length) {
      elements.usageOverview.innerHTML = "";
      return;
    }
    const providerRows = providers.slice(0, 6).map((provider) => `<div class="usage-row">
      <span><strong>${escapeHtml(provider.displayName || provider.id)}</strong><small>${Number(provider.requests || 0).toLocaleString()} requests</small></span>
      <strong>${compactTokens(provider.totalTokens)} tok</strong>
    </div>`).join("");
    const modelRows = models.map((model) => `<div class="usage-row">
      <span><strong>${escapeHtml(model.displayName || model.slug)}</strong><small>${escapeHtml(model.provider)} · ${Number(model.requests || 0).toLocaleString()} requests</small></span>
      <strong>${compactTokens(model.totalTokens)} tok</strong>
    </div>`).join("");
    elements.usageOverview.innerHTML = `${providerRows ? `<article class="usage-card"><header><strong>All usage</strong><small>router observed</small></header>${providerRows}</article>` : ""}${modelRows ? `<article class="usage-card"><header><strong>Tokens by model</strong><small>heaviest first</small></header>${modelRows}</article>` : ""}`;
  }

  function renderStatusView() {
    const activity = state.health?.activity || {};
    const active = Array.isArray(activity.active) ? activity.active : [];
    const activeCount = Number(activity.activeCount ?? active.length) || 0;
    elements.statusSummary.textContent = activeCount
      ? `${activeCount} request${activeCount === 1 ? "" : "s"} in flight · ${activity.state || "active"}`
      : `Router ${state.health?.ok === false ? "offline" : "ready"} · nothing in flight`;
    elements.activeRequests.innerHTML = `<header><strong>Live requests</strong><small>${activeCount ? activeCount : "none"}</small></header>${active.length
      ? active.map((request) => {
          const started = Number(request.startedAt) || Date.now();
          const elapsed = Math.max(0, (Date.now() - (started > 1e12 ? started : started * 1000)) / 1000);
          const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${String(Math.floor(elapsed % 60)).padStart(2, "0")}s` : `${elapsed.toFixed(1)}s`;
          const label = request.model ? String(request.model).split("/").at(-1) : request.provider || "request";
          return `<div class="status-row"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(request.provider || "router")}${request.isSubagent ? " · subagent" : ""}</small></span><strong>${elapsedLabel}</strong></div>`;
        }).join("")
      : '<p class="status-empty">Nothing in flight.</p>'}`;
    const resets = buildQuotaCards(state).filter((card) => card.resetAt);
    elements.quotaResets.innerHTML = `<header><strong>Quota resets</strong><small>${resets.length || "none"}</small></header>${resets.length
      ? resets.map((card) => `<div class="status-row"><span><strong>${escapeHtml(card.providerName)}</strong><small>${escapeHtml(card.label)}</small></span><strong>${escapeHtml(formatReset(card.resetAt))}</strong></div>`).join("")
      : '<p class="status-empty">No reset times are available.</p>'}`;
  }

  function renderQuotas() {
    const cards = buildQuotaCards(state);
    elements.quotaCards.innerHTML = cards.length
      ? cards
          .map((card) => {
            const percent = card.remainingPercent === null ? "—" : `${Math.round(card.remainingPercent)}%`;
            const progress = card.remainingPercent === null ? 0 : card.remainingPercent;
            return `<article class="quota-card">
              <header><span class="quota-provider">${escapeHtml(card.providerName)}</span><span class="quota-value">${percent}</span></header>
              <h3>${card.label}</h3>
              <progress max="100" value="${progress}" aria-label="${escapeHtml(t("usage.used", { label: card.label, percent }))}"></progress>
              <p>${escapeHtml(formatReset(card.resetAt))}</p>
            </article>`;
          })
          .join("")
      : `<div class="empty-state">${escapeHtml(t("connections.connectToShowLimits"))}</div>`;
  }

  function renderProviders() {
    const providers = state.providerSetup?.providers || [];
    const enabled = new Set(state.snapshot?.targets?.codex?.enabledProviders || []);
    elements.providers.innerHTML = providers.length
      ? providers.map((provider) => providerRow(provider, enabled.has(provider.id))).join("")
      : `<div class="empty-state">${escapeHtml(t("connections.providerSetupUnavailable"))}</div>`;
  }

  function renderPresence() {
    const mode = state.presence?.mode || "always";
    elements.presenceMode.value = mode;
    elements.presenceMode.disabled = state.presenceBusy;
    elements.presenceNote.textContent = mode === "follow-codex"
      ? "Show while Codex or ChatGPT is running"
      : "Keep the Windows tray visible";
  }

  function renderMaintenance() {
    const busy = Boolean(state.maintenanceBusy);
    elements.maintenanceUpdate.disabled = busy;
    elements.maintenanceFix.disabled = busy;
    if (busy) {
      elements.maintenanceStatus.textContent = state.maintenanceBusy === "fix" ? "Repairing…" : "Updating…";
      elements.maintenanceNote.textContent = "The router is running maintenance; this may take a moment.";
      return;
    }
    const result = state.maintenanceResult;
    elements.maintenanceStatus.textContent = result?.ok ? "Verified" : result?.error ? "Maintenance failed" : "Router ready";
    elements.maintenanceNote.textContent = result?.message || "Update the checkout and verify its installation.";
  }

  function renderVisionBridge() {
    const vision = state.visionBridge || {};
    state.visionBridge = vision;
    const enabled = vision.enabled === true;
    const selected = vision.engine || "auto";
    const selectedName = vision.resolvedEngineName || vision.resolvedEngine || "no engine";
    elements.visionSummary.textContent = enabled ? `on · ${selectedName}` : "off";
    elements.visionNote.textContent = enabled
      ? `Reading via ${selectedName}${vision.effort ? ` · ${vision.effort}` : ""}`
      : "Off · text-only models refuse pasted images";
    elements.visionSwitch.checked = enabled;
    elements.visionSwitch.disabled = state.visionBusy;
    elements.visionSwitchLabel.title = enabled ? "Disable image transcription" : "Enable image transcription";

    const engineNames = new Map();
    for (const entry of [...(vision.paidEngines || []), ...(vision.nativeEngines || [])]) {
      if (entry?.slug) engineNames.set(entry.slug, entry.displayName || entry.slug);
    }
    const engineOptions = [
      `<option value="auto"${selected === "auto" || !vision.engine ? " selected" : ""}>Auto · ${escapeHtml(selectedName)}</option>`,
      ...[...(vision.availableEngines || [])]
        .filter((slug) => slug !== "local")
        .map((slug) => `<option value="${escapeHtml(slug)}"${slug === selected ? " selected" : ""}>${escapeHtml(engineNames.get(slug) || slug)}</option>`),
      ...(vision.localModels || []).some((model) => model.installed)
        ? [`<option value="local"${selected === "local" ? " selected" : ""}>Local · ${escapeHtml(vision.local?.model || "Ollama")}</option>`]
        : [],
    ];
    elements.visionEngine.innerHTML = engineOptions.join("");
    elements.visionEngine.disabled = state.visionBusy || !enabled;
    const efforts = vision.availableEfforts || [];
    elements.visionEffort.innerHTML = efforts.length
      ? [`<option value="default"${!vision.effort ? " selected" : ""}>Model default</option>`, ...efforts.map((effort) => `<option value="${escapeHtml(effort)}"${effort === vision.effort ? " selected" : ""}>${escapeHtml(effort)}</option>`)].join("")
      : '<option value="default">Model default</option>';
    elements.visionEffort.disabled = state.visionBusy || !enabled || !efforts.length;

    const models = vision.localModels || [];
    const operation = state.visionDownload;
    elements.visionLocalModels.innerHTML = models.length
      ? `<div class="local-section-label"><span>Local image readers</span><small>${models.length} available</small></div>${models.map((model) => {
          const installed = model.installed === true;
          const active = operation?.tag === model.tag && operation?.status === "downloading";
          const action = active ? `<button class="mini-button" type="button" disabled>${Number(operation.percent || 0)}%</button>` : installed ? `<button class="mini-button" type="button" disabled>${vision.engine === "local" && vision.local?.model === model.tag ? "Using" : "Installed"}</button>` : `<button class="mini-button" type="button" data-command="vision.pull" data-vision-action="download" data-model="${escapeHtml(model.tag)}"${state.visionBusy ? " disabled" : ""}>Download</button>`;
          const tests = "";
          return `<div class="vision-model-row"><span><strong>${escapeHtml(model.label || model.tag)}</strong><small>${escapeHtml(model.tag)} · ${escapeHtml(model.accuracy || "unmeasured")}</small></span><span>${tests}${action}</span></div>`;
        }).join("")}`
      : "";
  }

  function providerRow(provider, enabled) {
    const isBusy = state.busyProvider === provider.id;
    const isAnonymous = provider.kind === "anonymous";
    const isApiKey = !provider.credentialLabel || provider.credentialLabel === "API key" || provider.credentialLabel === t("connections.apiKey");
    const credentialLabel = isAnonymous
      ? t("connections.noApiKey")
      : isApiKey
      ? t("connections.apiKey")
      : provider.credentialLabel === "GitHub token" ? t("connections.githubToken") : provider.credentialLabel;
    const kind = provider.kind === "oauth" ? t("connections.oauth") : credentialLabel;
    let detail = provider.configured
      ? t("connections.connected", { kind })
      : t("connections.notConnected", { kind });
    let action = "";
    let actionLabel = "";
    if (provider.kind === "oauth") {
      action = "none";
      actionLabel = t("general.unavailableThisSession");
    } else if (isAnonymous) {
      action = "none";
      actionLabel = t("connections.ready");
    } else {
      action = "key";
      actionLabel = isApiKey
        ? provider.configured ? t("connections.replaceKey") : t("connections.addKey")
        : provider.configured
          ? t("connections.replaceCredential", { credential: credentialLabel })
          : t("connections.addCredential", { credential: credentialLabel });
    }
    if (isBusy) detail = t("status.working");
    const canRemove = provider.kind === "api" && provider.configured;
    const actionButton = isAnonymous || action === "none"
      ? `<button class="mini-button" type="button" disabled title="${escapeHtml(provider.anonymousNote || t("connections.noApiKey"))}">${escapeHtml(actionLabel)}</button>`
      : `<button class="mini-button" type="button" data-command="credential.set" data-action="key" data-provider="${escapeHtml(provider.id)}"${isBusy ? " disabled" : ""}>${escapeHtml(actionLabel)}</button>`;
    return `<article class="provider-row">
      <div><strong>${escapeHtml(provider.displayName)}</strong><small>${escapeHtml(detail)}</small>${provider.planNote ? `<small>${escapeHtml(localizeProviderPlan(provider.planNote))}</small>` : ""}${provider.anonymousNote ? `<small>${escapeHtml(provider.anonymousNote)}</small>` : ""}</div>
      <div class="provider-actions">
        ${actionButton}
        ${
          canRemove
            ? `<button class="mini-button danger" type="button" data-command="credential.remove" data-action="remove-key" data-provider="${escapeHtml(provider.id)}" aria-label="${escapeHtml(t("connections.removeCredentialAria", { provider: provider.displayName }))}"${isBusy ? " disabled" : ""}>${escapeHtml(t("actions.remove"))}</button>`
            : ""
        }
        ${
          provider.configured
            ? `<label class="provider-check"><input type="checkbox" data-command="provider.enable" data-provider="${escapeHtml(provider.id)}" aria-label="${escapeHtml(t("connections.enableProviderAria", { provider: provider.displayName }))}"${enabled ? " checked" : ""}${isBusy ? " disabled" : ""}></label>`
            : ""
        }
      </div>
    </article>`;
  }

  function renderIslandSetting() {
    const supported = state.platform?.islandSupported !== false;
    elements.islandSwitch.disabled = !supported;
    elements.islandSwitch.checked = supported && state.settings?.islandEnabled !== false;
    elements.islandSwitchLabel.title = supported ? "" : state.platform?.islandReason || t("footer.unavailable");
    elements.islandNote.textContent = supported
      ? t("footer.topCenterGraph")
      : state.platform?.islandReason || t("general.unavailableThisSession");
  }

  function toggleAccordion(button) {
    const name = button.dataset.accordion;
    const body = document.querySelector(`[data-accordion-body="${name}"]`);
    if (!body) return;
    const open = body.hidden;
    body.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    body.classList.toggle("is-open", open);
  }

  function renderModelSettings() {
    const snapshot = state.snapshot?.targets?.codex;
    const settings = snapshot?.modelSettings;
    const models = snapshot?.models || [];
    const enabledModels = models.filter((model) => model.enabled);
    const pickerModels = models.filter((model) => model.enabled);
    const subagent = settings?.subagents || { mode: "proven", enabled: [], disabled: [] };
    const disabledSubagents = new Set(subagent.disabled || []);
    const selectedSubagents = new Set(subagent.enabled || []);
    const subagentProofs = subagent.proofs || {};
    const hiddenModels = new Set(settings?.picker?.hidden || []);
    const providerNames = new Map(
      (snapshot?.providers || []).map((provider) => [provider.id, provider.displayName]),
    );
    providerNames.set("openai", "OpenAI");

    function providerLabel(provider) {
      return providerNames.get(provider) || provider;
    }

    function groupModels(list) {
      const groups = new Map();
      for (const model of list) {
        if (!groups.has(model.provider)) groups.set(model.provider, []);
        groups.get(model.provider).push(model);
      }
      return [...groups.entries()]
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
        .map(([provider, items]) => ({
          provider,
          items: items.sort((left, right) => String(left.slug).localeCompare(String(right.slug))),
        }));
    }

    // `groupSummary` counts what this section actually controls. The two
    // sections list the same providers, so a click that lands in the wrong one
    // has to be visible here rather than only in Codex's picker after a
    // restart. Button labels name the setting for the same reason: two
    // identical "Unselect all" buttons is how a subagent toggle gets mistaken
    // for a picker toggle.
    function providerGroupsMarkup(groups, rowMarkup, setting, groupSummary) {
      const [onLabel, offLabel] =
        setting === "picker"
          ? [t("actions.showAll"), t("actions.hideAll")]
          : [t("actions.subagentsOn"), t("actions.subagentsOff")];
      return groups
        .map(
          (group) => `<details class="model-provider-group" open>
            <summary><span>${escapeHtml(providerLabel(group.provider))}</span><span class="model-provider-count">${escapeHtml(groupSummary(group))}</span></summary>
            <div class="model-provider-toolbar"><small>${escapeHtml(onLabel)} / ${escapeHtml(offLabel)}</small></div>
            <div class="model-settings-list">${group.items.map(rowMarkup).join("")}</div>
          </details>`,
        )
        .join("");
    }

    elements.subagentAllSwitch.disabled = state.modelSettingsBusy;
    elements.subagentAllSwitch.checked = subagent.mode === "all";
    elements.subagentAllSwitchLabel.title = t("models.onlyProvenV2");

    // Every enabled model belongs here. Native OpenAI models use their
    // effective Codex catalog capability, while an unverified routed model
    // starts the existing capability probe when selected. Hiding v1 candidates
    // made that route impossible to discover; filtering native models made
    // usable GPT models disappear from the panel entirely.
    const subagentModels = enabledModels;
    const subagentGroups = groupModels(subagentModels);
    const isSubagentOn = (model) =>
      model.visible === false
        ? false
        : !disabledSubagents.has(model.slug) &&
          (model.multiAgentVersion === "v2" || selectedSubagents.has(model.slug));
    const subagentRow = (model) => {
        const checked = isSubagentOn(model);
        const proof = subagentProofs[model.slug];
        const badge = model.visible === false
          ? t("models.hidden")
          : proof?.status === "checking"
            ? t("status.working")
            : proof?.status === "failed"
              ? `${t("status.error")}: ${proof.reason || t("models.untested")}`
              : model.multiAgentVersion === "v2"
                ? t("models.provenV2")
                : t("models.untested");
        return `<label class="model-setting-row">
          <span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(badge)}</small></span>
          <span class="provider-check"><input type="checkbox" data-command="subagents.model" data-subagent="${escapeHtml(model.slug)}" aria-label="${escapeHtml(t("models.useModelAria", { model: model.displayName }))}"${checked ? " checked" : ""}${state.modelSettingsBusy || model.visible === false ? " disabled" : ""}></span>
        </label>`;
      };

    elements.subagentModelList.innerHTML = subagentGroups.length
      ? providerGroupsMarkup(
          subagentGroups,
          subagentRow,
          "subagents",
          (group) => t("models.providerCountOn", {
            on: group.items.filter(isSubagentOn).length,
            total: group.items.length,
          }),
        )
      : `<div class="empty-state">${escapeHtml(t("models.enableProviderForSubagents"))}</div>`;
    const subagentCount = subagentModels.filter(isSubagentOn).length;
    elements.subagentSummary.textContent = t("models.subagentSummary", {
      count: subagentCount,
      plural: subagentCount === 1 ? "" : "s",
      mode: localizeSubagentMode(subagent.mode),
    });

    const pickerGroups = groupModels(pickerModels);
    const pickerRow = (model) => {
        const visible = !hiddenModels.has(model.slug);
        return `<label class="model-setting-row">
          <span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(model.slug)}</small></span>
          <span class="provider-check"><input type="checkbox" data-command="picker.set" data-picker="${escapeHtml(model.slug)}" aria-label="${escapeHtml(t("models.showModelAria", { model: model.displayName }))}"${visible ? " checked" : ""}${state.modelSettingsBusy ? " disabled" : ""}></span>
        </label>`;
      };

    elements.pickerModelList.innerHTML = pickerGroups.length
      ? providerGroupsMarkup(
          pickerGroups,
          pickerRow,
          "picker",
          (group) =>
            t("models.providerCountVisible", {
              visible: group.items.filter((model) => !hiddenModels.has(model.slug)).length,
              total: group.items.length,
            }),
        )
      : `<div class="empty-state">${escapeHtml(t("models.noEnabledModels"))}</div>`;
    const pickerCount = pickerModels.filter((model) => !hiddenModels.has(model.slug)).length;
    elements.pickerSummary.textContent = `${pickerCount} ${t("models.visible")} · ${hiddenModels.size} ${t("models.hidden")}`;
  }

  function formatCompactCount(value) {
    const count = Number(value) || 0;
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
    return String(count);
  }

  function toolResultAgingSavingsLine(stats) {
    if (!stats || !(Number(stats.requests) > 0)) return "";
    const tokens = formatCompactCount(stats.estimatedTokensSaved);
    const mb = ((Number(stats.bytesSaved) || 0) / (1024 * 1024)).toFixed(1);
    return `Saved ~${tokens} tokens (${mb} MB) across ${stats.requests} requests · `;
  }

  function renderToolResultAgingSetting() {
    const aging = state.snapshot?.targets?.codex?.modelSettings?.toolResultAging;
    const overridden = aging?.environmentOverride === true;
    elements.toolResultAgingSwitch.checked = toolResultAgingChecked(aging);
    elements.toolResultAgingSwitch.disabled = state.toolResultAgingBusy || overridden;
    elements.toolResultAgingSwitchLabel.title = overridden
      ? t("models.toolAgingForcedOff")
      : t("models.toolAgingNextRequest");
    elements.toolResultAgingNote.textContent = overridden
      ? t("models.toolAgingEnvironment")
      : `${toolResultAgingSavingsLine(aging?.stats)}${t("models.toolAgingNote")}`;
  }

  async function handleVisionClick(event) {
    const button = event.target.closest("button[data-vision-action]");
    if (!button) return;
    const model = button.dataset.model;
    if (!model) return;
    if (button.dataset.visionAction === "download") {
      await startVisionDownload(model);
    }
  }

  async function startVisionDownload(model) {
    if (!model || state.visionBusy || state.visionDownload?.status === "downloading") return;
    state.visionBusy = true;
    state.visionDownload = { tag: model, status: "downloading", percent: 0, detail: "starting" };
    renderVisionBridge();
    try {
      await call("vision.pull", { tag: model });
      pollVisionDownload(model);
    } catch (error) {
      state.visionBusy = false;
      state.visionDownload = { tag: model, status: "error", error: errorMessage(error) };
      renderVisionBridge();
      showToast(errorMessage(error), true);
    }
  }

  async function pollVisionDownload(model) {
    window.clearTimeout(state.visionPollTimer);
    try {
      const snapshot = await call("lifecycle.status");
      state.snapshot = snapshot;
      const status = snapshot?.targets?.codex?.modelSettings?.visionBridge?.download || { status: "idle" };
      state.visionDownload = status;
      renderVisionBridge();
      if (status?.tag === model && status.status === "downloading") {
        state.visionPollTimer = window.setTimeout(() => pollVisionDownload(model), 1_000);
        return;
      }
      state.visionPollTimer = null;
      state.visionBusy = false;
      if (status?.status === "done") {
        showToast(`${model} downloaded for image reading.`);
        await refreshPanel({ quiet: true });
      } else if (status?.status === "error") {
        showToast(status.error || "The vision model download failed.", true);
      }
      renderVisionBridge();
    } catch {
      state.visionPollTimer = window.setTimeout(() => pollVisionDownload(model), 1_500);
    }
  }

  async function handleSubagentAllToggle() {
    const enabled = elements.subagentAllSwitch.checked;
    const settings = state.snapshot?.targets?.codex?.modelSettings?.subagents;
    const enabledSet = new Set(settings?.enabled || []);
    const mode = enabled ? "all" : enabledSet.size ? "selected" : "proven";
    state.modelSettingsBusy = true;
    renderModelSettings();
    try {
      state.snapshot = await call("subagents.mode", { mode });
      showToast(enabled ? t("models.allSubagentsEnabled") : t("models.subagentModeUpdated"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      elements.subagentAllSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.modelSettingsBusy = false;
      renderModelSettings();
    }
  }

  async function handleModelSettingsClick(event) {
    const button = event.target.closest("button[data-model-action]");
    if (!button) return;
    const group = button.dataset.modelAction;
    const action = button.dataset.action;
    state.modelSettingsBusy = true;
    renderModelSettings();
    try {
      if (group === "subagents") {
        const selectAll = action === "select-all";
        state.snapshot = await call("subagents.selection", { selection: selectAll ? "select-all" : "unselect-all" });
        showToast(t(selectAll ? "models.everyPickerModelSubagent" : "models.subagentSelectionCleared"));
      } else {
        const showAll = action === "show-all";
        state.snapshot = await call("picker.show-all", { visible: showAll });
        showToast(t(showAll ? "models.everyModelVisible" : "models.allModelsHidden"));
      }
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.modelSettingsBusy = false;
      renderModelSettings();
    }
  }

  async function handleModelSettingsToggle(event) {
    const subagent = event.target.closest('input[data-subagent]');
    const picker = event.target.closest('input[data-picker]');
    if (!subagent && !picker) return;
    state.modelSettingsBusy = true;
    renderModelSettings();
    try {
      if (subagent) {
        state.snapshot = await call("subagents.model", {
          slug: subagent.dataset.subagent,
          enabled: subagent.checked,
        });
        showToast(t("models.subagentSelectionUpdated"));
      } else {
        state.snapshot = await call("picker.set", {
          slug: picker.dataset.picker,
          visible: picker.checked,
        });
        showToast(t("models.pickerUpdated"));
      }
      await refreshPanel({ quiet: true });
    } catch (error) {
      if (subagent) subagent.checked = !subagent.checked;
      else picker.checked = !picker.checked;
      showToast(errorMessage(error), true);
    } finally {
      state.modelSettingsBusy = false;
      renderModelSettings();
    }
  }

  async function handleProviderClick(event) {
    const button = event.target.closest("button[data-provider]");
    if (!button) return;
    const provider = button.dataset.provider;
    const action = button.dataset.action;
    if (action === "key") {
      const setup = state.providerSetup?.providers?.find((item) => item.id === provider);
      const isApiKey = !setup?.credentialLabel || setup.credentialLabel === "API key" || setup.credentialLabel === t("connections.apiKey");
      const credentialLabel = isApiKey
        ? t("connections.apiKey")
        : setup.credentialLabel === "GitHub token" ? t("connections.githubToken") : setup.credentialLabel;
      const credentialNoun = credentialLabel;
      state.keyProvider = provider;
      elements.keyTitle.textContent = setup?.configured
        ? t("connections.replaceCredentialTitle", { provider: setup.displayName, credential: credentialNoun })
        : t("connections.addCredentialTitle", { provider: setup?.displayName || "API", credential: credentialNoun });
      elements.keyInput.placeholder = t("connections.pasteCredentialType", { credential: credentialNoun });
      elements.keyDialog.showModal();
      requestAnimationFrame(() => elements.keyInput.focus());
      return;
    }

    if (action === "remove-key") {
      const setup = state.providerSetup?.providers?.find((item) => item.id === provider);
      const name = setup?.displayName || t("general.provider");
      const isApiKey = !setup?.credentialLabel || setup.credentialLabel === "API key" || setup.credentialLabel === t("connections.apiKey");
      const credentialLabel = isApiKey
        ? t("connections.apiKey")
        : setup.credentialLabel === "GitHub token" ? t("connections.githubToken") : setup.credentialLabel;
      const credentialNoun = credentialLabel;
      state.removeProvider = provider;
      elements.removeTitle.textContent = t("connections.removeCredentialTitle", { provider: name, credential: credentialNoun });
      elements.removeBody.textContent = t("connections.removeBodyDynamic", { provider: name, credential: credentialNoun });
      elements.removeDialog.showModal();
      requestAnimationFrame(() => elements.cancelRemove.focus());
      return;
    }

    state.busyProvider = provider;
    renderProviders();
    try {
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  async function handleProviderToggle(event) {
    const checkbox = event.target.closest('input[type="checkbox"][data-provider]');
    if (!checkbox) return;
    const provider = checkbox.dataset.provider;
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    state.busyProvider = provider;
    try {
      state.snapshot = await call("provider.enable", { provider, enabled });
      showToast(enabled ? t("connections.providerEnabled") : t("connections.providerHidden"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      checkbox.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  async function handleIslandToggle() {
    const enabled = elements.islandSwitch.checked;
    elements.islandSwitch.disabled = true;
    try {
      await shellCall("set_island_enabled", { enabled });
      state.settings = { ...(state.settings || {}), islandEnabled: enabled };
    } catch (error) {
      elements.islandSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      renderIslandSetting();
    }
  }

  async function handlePresenceModeChange() {
    const mode = elements.presenceMode.value || "always";
    const previous = state.presence?.mode || "always";
    state.presenceBusy = true;
    renderPresence();
    try {
      state.presence = await call("presence.mode", { mode });
      showToast(mode === "follow-codex" ? "Tray will follow Codex presence." : "Tray will stay visible.");
    } catch (error) {
      elements.presenceMode.value = previous;
      showToast(errorMessage(error), true);
    } finally {
      state.presenceBusy = false;
      renderPresence();
    }
  }

  async function handleVisionToggle() {
    const enabled = elements.visionSwitch.checked;
    state.visionBusy = true;
    renderVisionBridge();
    try {
      state.visionBridge = await call(enabled ? "vision.on" : "vision.off", {});
      showToast(enabled ? "Vision bridge enabled for pasted images." : "Vision bridge disabled.");
      await refreshPanel({ quiet: true });
    } catch (error) {
      elements.visionSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.visionBusy = false;
      renderVisionBridge();
    }
  }

  async function handleVisionEngineChange() {
    const engine = elements.visionEngine.value || "auto";
    const effort = elements.visionEffort.value || "default";
    state.visionBusy = true;
    renderVisionBridge();
    try {
      state.visionBridge = await call("vision.engine", { engine, effort });
      showToast(engine === "local" ? "Local vision model selected." : "Vision engine selected.");
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.visionBusy = false;
      renderVisionBridge();
    }
  }

  async function handleVisionEffortChange() {
    const effort = elements.visionEffort.value || "default";
    state.visionBusy = true;
    renderVisionBridge();
    try {
      state.visionBridge = await call("vision.effort", { effort });
      showToast(effort === "default" ? "Vision effort reset to model default." : `Vision effort set to ${effort}.`);
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.visionBusy = false;
      renderVisionBridge();
    }
  }

  async function runMaintenance(kind) {
    if (state.maintenanceBusy) return;
    state.maintenanceBusy = kind;
    state.maintenanceResult = null;
    renderMaintenance();
    try {
      const result = await call(kind === "fix" ? "doctor.fix" : "maintenance.update");
      state.maintenanceResult = {
        ok: result?.ok !== false,
        message: kind === "fix"
          ? "Repair completed and the installation was verified."
          : result?.restartRequired
            ? "Updated and verified. Restart Codex to load the refreshed catalog."
            : "Updated and verified.",
      };
      showToast(state.maintenanceResult.message);
      await refreshPanel({ quiet: true });
    } catch (error) {
      state.maintenanceResult = { ok: false, error: true, message: errorMessage(error) };
      showToast(errorMessage(error), true);
    } finally {
      state.maintenanceBusy = null;
      renderMaintenance();
    }
  }

  async function handleToolResultAgingToggle() {
    const enabled = elements.toolResultAgingSwitch.checked;
    state.toolResultAgingBusy = true;
    renderToolResultAgingSetting();
    try {
      await call(enabled ? "tool-result-aging.on" : "tool-result-aging.off", {});
      await refreshPanel({ quiet: true });
      showToast(
        enabled
          ? t("models.toolAgingOn")
          : t("models.toolAgingExact"),
      );
    } catch (error) {
      elements.toolResultAgingSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.toolResultAgingBusy = false;
      renderToolResultAgingSetting();
    }
  }

  async function saveKey(event) {
    event.preventDefault();
    const provider = state.keyProvider;
    const apiKey = elements.keyInput.value;
    elements.keyInput.value = "";
    if (!provider || !apiKey.trim()) return;
    closeKeyDialog();
    state.busyProvider = provider;
    renderProviders();
    try {
      await call("credential.set", { provider, apiKey });
      showToast(t("connections.credentialSaved"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  async function removeKey(event) {
    event.preventDefault();
    const provider = state.removeProvider;
    closeRemoveDialog();
    if (!provider) return;
    state.busyProvider = provider;
    renderProviders();
    try {
      const result = await call("credential.remove", { provider });
      showToast(removalMessage(result?.removal));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  function closeKeyDialog() {
    elements.keyInput.value = "";
    if (elements.keyDialog.open) elements.keyDialog.close();
  }

  function closeRemoveDialog() {
    if (elements.removeDialog.open) elements.removeDialog.close();
  }

  function showToast(message, isError = false) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("is-error", isError);
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 4_200);
  }
}

function startIsland() {
  const state = {
    health: { ok: false, activity: { state: "starting" } },
    account: null,
    providerUsage: null,
    providerSetup: null,
    expanded: false,
    healthPending: false,
    usagePending: false,
  };
  const elements = {
    root: document.getElementById("island"),
    orbit: document.getElementById("island-orbit"),
    state: document.getElementById("island-state"),
    provider: document.getElementById("island-provider"),
    tokens: document.getElementById("island-tokens"),
    percent: document.getElementById("island-percent"),
    week: document.getElementById("island-week"),
    line: document.getElementById("island-line-path"),
    area: document.getElementById("island-area-path"),
  };
  const thinkingOrb = elements.orbit
    ? createThinkingOrb(elements.orbit, { size: 18, dark: true })
    : null;

  elements.root.addEventListener("pointerenter", () => setExpanded(true));
  elements.root.addEventListener("pointerleave", () => setExpanded(false));
  elements.root.addEventListener("click", () => shellCall("show_panel"));

  if (!invoke) {
    elements.state.textContent = t("status.unavailable");
    elements.root.dataset.state = "offline";
    return;
  }

  refreshIslandUsage();
  refreshIslandHealth();
  window.setInterval(refreshIslandHealth, 750);
  window.setInterval(refreshIslandUsage, 30_000);

  async function refreshIslandHealth() {
    if (state.healthPending) return;
    state.healthPending = true;
    try {
      state.health = await shellCall("router_health");
    } catch {
      state.health = { ok: false, activity: { state: "offline" } };
    } finally {
      state.healthPending = false;
      renderIsland();
    }
  }

  async function refreshIslandUsage() {
    if (state.usagePending) return;
    state.usagePending = true;
    const requests = [
      ["account", "native.account-usage"],
      ["providerUsage", "usage.provider"],
    ];
    const results = await Promise.all(
      requests.map(async ([key, command]) => {
        try {
          return [key, await call(command)];
        } catch {
          return [key, null];
        }
      }),
    );
    for (const [key, value] of results) {
      if (value) state[key] = value;
    }
    state.usagePending = false;
    renderIsland();
  }

  function renderIsland() {
    const activity = state.health?.activity || {};
    const activityState = state.health?.ok === false ? "offline" : activity.state || "idle";
    const labels = activityLabels();
    elements.root.dataset.state = activityState;
    elements.state.textContent = labels[activityState] || t("status.idle");
    if (elements.orbit) {
      const orbMode = {
        generating: "composing",
        idle: "shaping",
        error: "solving",
      }[activityState] || "hidden";
      elements.orbit.classList.toggle("is-thinking", orbMode !== "hidden");
      thinkingOrb?.setMode(orbMode);
    }

    const options = sourceOptions(state);
    const requested = activity.provider || "openai";
    const source = options.find((option) => option.id === requested) || options[0];
    elements.provider.textContent = activityState === "generating" && activity.model
      ? activity.model
      : source?.name || t("island.modelRouter");
    elements.tokens.textContent = source ? compactTokens(todayTokens(source)) : "—";
    elements.week.textContent = source ? `${compactTokens(sevenDayTokens(source))} ${t("usage.tokens")}` : t("island.noUsageYet");

    const weekly = buildQuotaCards(state).find(
      (card) => card.providerId === source?.id && card.window === "weekly",
    );
    elements.percent.textContent = weekly?.remainingPercent === null || weekly?.remainingPercent === undefined
      ? "—"
      : `${Math.round(weekly.remainingPercent)}%`;

    const series = dailySeries(source?.buckets || []);
    const geometry = chartGeometry(series, 368, 42, 3);
    elements.line.setAttribute("d", geometry.line);
    elements.area.setAttribute("d", geometry.area);
    elements.root.setAttribute(
      "aria-label",
      t("island.ariaLabel", {
        state: labels[activityState] || t("status.idle"),
        details: source
          ? t("island.tokensToday", { count: exactTokens(todayTokens(source)) })
          : t("usage.noUsageData"),
      }),
    );
  }

  async function setExpanded(expanded) {
    if (state.expanded === expanded) return;
    state.expanded = expanded;
    elements.root.classList.toggle("is-expanded", expanded);
    try {
      await shellCall("set_island_expanded", { expanded });
    } catch {
      state.expanded = false;
      elements.root.classList.remove("is-expanded");
    }
  }
}

function activityLabels() {
  return {
    generating: t("status.thinking"),
    starting: t("status.starting"),
    offline: t("status.offline"),
    error: t("status.error"),
    idle: t("status.idle"),
  };
}

function localizeProviderPlan(note) {
  const value = String(note || "");
  if (getLanguage() === "zh-CN") {
    if (value.includes("Needs the Command Code Provider plan")) return "需要 Command Code Provider 方案。";
    if (value.includes("Requires Copilot access")) return "需要 Copilot 访问权限。连接后，请运行 ./bin/curate-models github-copilot。";
    if (value.includes("Requires an active ClinePass subscription")) return "需要有效的 ClinePass 订阅。";
    if (value.includes("Runs on this machine")) return "在此设备上运行。使用这些模型前请先启动 Ollama。";
  }
  return value;
}

function localizeSubagentMode(mode) {
  const key = {
    proven: "models.modeProven",
    selected: "models.modeSelected",
    all: "models.modeAll",
  }[mode];
  return key ? t(key) : mode || t("models.modeProven");
}

function localizeDownloadDetail(detail) {
  return detail === "starting" ? t("models.downloadStarting") : detail;
}

function renderChart(series, elements) {
  const geometry = chartGeometry(series);
  elements.chartLine.setAttribute("d", geometry.line);
  elements.chartArea.setAttribute("d", geometry.area);
  elements.chartLine.style.animation = "none";
  requestAnimationFrame(() => {
    elements.chartLine.style.animation = "";
  });
  elements.chartDays.innerHTML = series.map((point) => `<span>${escapeHtml(point.label)}</span>`).join("");
  elements.chartDays.style.gridTemplateColumns = `repeat(${Math.max(1, series.length)}, minmax(0, 1fr))`;
  elements.chartPoints.replaceChildren();
  geometry.points.forEach((point, index) => {
    const dot = svgElement("circle", {
      class: "chart-point",
      cx: point.x,
      cy: point.y,
      r: 3.2,
    });
    const hit = svgElement("rect", {
      class: "chart-hit",
      x: point.x - 18,
      y: 0,
      width: 36,
      height: 112,
    });
    const show = () => {
      elements.chartPoints.querySelectorAll(".chart-point").forEach((item) => item.classList.remove("is-active"));
      dot.classList.add("is-active");
      elements.chartTooltip.querySelector("span").textContent = series[index].longLabel;
      elements.chartTooltip.querySelector("strong").textContent = t("usage.tooltipTokens", {
        count: exactTokens(series[index].tokens),
      });
      elements.chartTooltip.style.left = `${(point.x / 328) * 100}%`;
      elements.chartTooltip.style.top = `${point.y}px`;
      elements.chartTooltip.hidden = false;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointermove", show);
    elements.chartPoints.append(dot, hit);
  });
  elements.chartWrap.onpointerleave = () => {
    elements.chartTooltip.hidden = true;
    elements.chartPoints.querySelectorAll(".chart-point").forEach((item) => item.classList.remove("is-active"));
  };
}

function svgElement(name, attributes) {
  const element = document.createElementNS("http" + "://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function call(command, args) {
  if (!invoke) return Promise.reject(new Error(t("status.desktopBridgeUnavailable")));
  // A refused command comes back as a bare 403 the bridge reports as "the
  // router command failed", which names nothing anyone can act on. Refusing it
  // here says which surface refused and where the setting does live.
  if (commandRefused(capabilities, command)) {
    return Promise.reject(new Error(t("general.readOnlyControl")));
  }
  return invoke(command, args);
}

// Shell-local presentation commands never belong to the shared browser
// capability manifest. Keeping them on a separate bridge makes accidental
// legacy IDs in browser action bindings impossible.
function shellCall(command, args) {
  if (!invoke) return Promise.reject(new Error(t("status.desktopBridgeUnavailable")));
  return invoke(command, args);
}

// Every control that drives a command carries data-command, so the set to
// disable is the surface's own allowlist rather than a second list here that
// would drift the moment a command moves. The panel rebuilds whole sections
// from innerHTML in a dozen places; an observer means a new section cannot
// forget to ask, and it is installed only on a surface that is actually
// restricted, so the other two shells never run it.
function applyReadOnly(root) {
  const message = t("general.readOnlyControl");
  for (const element of root.querySelectorAll("[data-command]")) {
    if (!commandRefused(capabilities, element.dataset.command)) continue;
    element.disabled = true;
    element.title = message;
    // The switches hide their input behind a styled span, which is what a
    // pointer actually rests on, so the tooltip has to live on the label too.
    const label = element.closest("label");
    if (label) label.title = message;
  }
}

function watchReadOnly(root) {
  applyReadOnly(root);
  // childList only: setting `disabled` and `title` writes attributes, and
  // observing those would have this re-enter itself on every pass.
  new MutationObserver(() => applyReadOnly(root)).observe(root, {
    childList: true,
    subtree: true,
  });
}

// A key can also come from the macOS Keychain or the environment, which the
// router cannot delete, so say so rather than reporting a clean disconnect.
function removalMessage(removal) {
  const name = removal?.displayName || t("general.provider");
  if (removal?.stillConfigured) {
    return t("general.keyRemovedStillActive", {
      provider: name,
      source: removal.remainingSource || t("general.anotherSource"),
    });
  }
  if (removal && removal.removedFiles === 0) {
    return t("general.noStoredKey", { provider: name });
  }
  return t("general.keyRemovedRestart", { provider: name });
}

function errorMessage(error) {
  const message = typeof error === "string" ? error : error?.message || t("general.operationFailed");
  return String(message).replace(/\s+/g, " ").trim().slice(0, 500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
