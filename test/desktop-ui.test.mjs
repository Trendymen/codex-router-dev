import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildQuotaCards,
  chartGeometry,
  commandRefused,
  compactTokens,
  dailySeries,
  metricRemainingPercent,
  observedModelSpeed,
  quotaWindow,
  readOnlyCapabilities,
  toolResultAgingChecked,
} from "../apps/desktop/ui/model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { availableLanguages, getLanguage, setLanguage, t, translationKeys } from "../apps/desktop/ui/i18n.mjs";

function withLanguage(language, callback) {
  const previous = getLanguage();
  setLanguage(language);
  try {
    return callback();
  } finally {
    setLanguage(previous);
  }
}

test("desktop usage series fills missing local calendar days", () => {
  const series = dailySeries(
    [
      { startDate: "2026-07-19", tokens: 2_400 },
      { startDate: "2026-07-21", tokens: 8_100 },
    ],
    3,
    new Date(2026, 6, 21, 18),
  );

  assert.deepEqual(
    series.map(({ key, tokens }) => ({ key, tokens })),
    [
      { key: "2026-07-19", tokens: 2_400 },
      { key: "2026-07-20", tokens: 0 },
      { key: "2026-07-21", tokens: 8_100 },
    ],
  );
});

test("quota windows use one weekly label and a distinct five-hour label", () => {
  withLanguage("en", () => {
    assert.deepEqual(quotaWindow({ label: "Weekly requests" }), {
      key: "weekly",
      label: "Weekly limit",
    });
    assert.deepEqual(quotaWindow({ windowDurationMins: 300 }), {
      key: "five-hour",
      label: "5-hour limit",
    });
  });
});

test("monthly quota windows keep their own label instead of being dropped", () => {
  withLanguage("en", () => {
    assert.deepEqual(quotaWindow({ label: "Monthly limit" }), {
      key: "monthly",
      label: "Monthly limit",
    });
    assert.deepEqual(quotaWindow({ label: "Monthly subscription" }), {
      key: "monthly",
      label: "Monthly limit",
    });
    assert.deepEqual(quotaWindow({ windowDurationMins: 43_200 }), {
      key: "monthly",
      label: "Monthly limit",
    });
  });
});

test("quota cards omit unconfigured providers and de-duplicate synonymous windows", () => {
  withLanguage("en", () => {
    const cards = buildQuotaCards({
      providerSetup: {
        providers: [
          { id: "kimi-oauth", configured: true },
          { id: "grok-api", configured: false },
        ],
      },
      providerUsage: {
        providers: [
          {
            id: "kimi-oauth",
            displayName: "Kimi OAuth",
            account: {
              metrics: [
                { kind: "quota", label: "Weekly requests", usedPercent: 48 },
                { kind: "quota", label: "Week", usedPercent: 48 },
                { kind: "quota", label: "5 hour", usedPercent: 3 },
              ],
            },
          },
          {
            id: "grok-api",
            displayName: "Grok API",
            account: { metrics: [{ kind: "quota", label: "Weekly", usedPercent: 20 }] },
          },
        ],
      },
    });

    assert.deepEqual(
      cards.map(({ providerId, label }) => ({ providerId, label })),
      [
        { providerId: "kimi-oauth", label: "Weekly limit" },
        { providerId: "kimi-oauth", label: "5-hour limit" },
      ],
    );
    assert.deepEqual(
      cards.map(({ usedPercent, remainingPercent }) => ({ usedPercent, remainingPercent })),
      [
        { usedPercent: 48, remainingPercent: 52 },
        { usedPercent: 3, remainingPercent: 97 },
      ],
    );
  });
});

test("quota remaining percentage prefers provider data and derives from usage", () => {
  assert.equal(metricRemainingPercent({ usedPercent: 35 }), 65);
  assert.equal(metricRemainingPercent({ used: 25, limit: 100 }), 75);
  assert.equal(metricRemainingPercent({ usedPercent: 35, remainingPercent: 72 }), 72);
});

test("chart geometry stays finite for an empty week", () => {
  const geometry = chartGeometry(Array.from({ length: 7 }, () => ({ tokens: 0 })));
  assert.match(geometry.line, /^M /);
  assert.equal(geometry.points.length, 7);
  assert.ok(geometry.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

test("token counts remain compact without hiding small values", () => {
  assert.equal(compactTokens(983), "983");
  assert.equal(compactTokens(1_250), "1.3k");
  assert.equal(compactTokens(28_800), "29k");
  assert.equal(compactTokens(2_500_000), "2.5m");
});

test("active model speed prefers its provider and matches qualified slugs", () => {
  const usage = {
    providers: [
      {
        id: "deepseek",
        models: [
          {
            slug: "deepseek/deepseek-v4-flash",
            displayName: "deepseek-v4-flash",
            observedTokensPerSecond: 18.7,
            speedSampleCount: 4,
          },
        ],
      },
    ],
  };
  assert.deepEqual(observedModelSpeed(usage, "deepseek", "deepseek/deepseek-v4-flash"), {
    speed: 18.7,
    samples: 4,
  });
  usage.providers[0].models[0].observedTokensPerSecond = null;
  assert.equal(observedModelSpeed(usage, "deepseek", "deepseek/deepseek-v4-flash"), null);
  assert.equal(observedModelSpeed(usage, "deepseek", "missing/model"), null);
});

// src/tool-result-aging-state.mjs defaults the feature off when no state file
// exists, so an absent snapshot has to render off. Rendering on told every
// fresh install that ageing was happening when nothing was.
test("the tool-result-aging switch renders off when the snapshot is absent", () => {
  assert.equal(toolResultAgingChecked(undefined), false);
  assert.equal(toolResultAgingChecked(null), false);
  assert.equal(toolResultAgingChecked({}), false);
});

test("the tool-result-aging switch follows the snapshot when it is present", () => {
  assert.equal(toolResultAgingChecked({ enabled: true }), true);
  assert.equal(toolResultAgingChecked({ enabled: false }), false);
  assert.equal(toolResultAgingChecked({ enabled: true, environmentOverride: false }), true);
});

// A control the surface will refuse must be dead before it is clicked, and the
// UI decides that from the surface's own lists rather than a copy of them.
test("a read-only surface refuses only what it did not advertise", () => {
  const capabilities = {
    readOnly: true,
    allowedCommands: ["lifecycle.status"],
    localCommands: ["hide_panel"],
  };
  assert.equal(commandRefused(capabilities, "tool-result-aging.on"), true);
  assert.equal(commandRefused(capabilities, "lifecycle.status"), false);
  assert.equal(commandRefused(capabilities, "hide_panel"), false);
  // A shell that advertises no limit carries the full table and refuses
  // nothing, which is how the tray and the Electron window stay unaffected.
  assert.equal(commandRefused(null, "set_tool_result_aging"), false);
  assert.equal(readOnlyCapabilities({ os: "darwin" }), null);
  assert.equal(readOnlyCapabilities({ capabilities: { readOnly: false } }), null);
});

test("the macOS tray renders the shared capability surface instead of a legacy local switch", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /CapabilitySnapshotV1/);
  assert.match(source, /CapabilityCommandRow/);
  assert.doesNotMatch(source, /toolResultAging\?\.enabled/);
});

test("native tray provider toggles use the shared manifest command bridge", () => {
  const swift = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(swift, /CapabilityCommandRow/);
  assert.match(swift, /executeCanonicalCommand\(command\.name/);
  assert.doesNotMatch(swift, /set-apply|--activate/);
});

test("native credential actions use protected input without persistence", () => {
  const swift = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(swift, /credential\.set/);
  assert.match(swift, /protectedInput/);
  assert.match(swift, /SecureField/);
  assert.doesNotMatch(swift, /UserDefaults[^\n]*(?:credential|apiKey|secret|token)/i);
});

// The disabled set is derived from data-command, so a control that drives a
// command without carrying one would stay live on a surface that refuses it.
test("every mutating control in the desktop UI names the command it drives", () => {
  const markup = [
    readFileSync(path.join(root, "apps", "desktop", "ui", "index.html"), "utf8"),
    readFileSync(path.join(root, "apps", "desktop", "ui", "app.js"), "utf8"),
  ].join("\n");
  for (const command of [
    "tool-result-aging.on",
    "presence.mode",
    "vision.on",
    "vision.engine",
    "vision.effort",
    "subagents.mode",
    "subagents.model",
    "subagents.selection",
    "picker.set",
    "picker.show-all",
    "provider.enable",
    "credential.set",
    "credential.remove",
    "maintenance.update",
    "doctor.fix",
  ]) {
    assert.ok(
      markup.includes(`data-command="${command}"`),
      `no control declares data-command="${command}"`,
    );
  }
});

test("desktop UI exposes translations with matching keys for every language", () => {
  assert.deepEqual(
    availableLanguages().map(({ id }) => id),
    ["en", "zh-CN", "ar", "hi", "ja", "ko"],
  );
  const keys = translationKeys();
  const englishKeys = [...keys.en].sort();
  for (const language of Object.keys(keys)) {
    assert.deepEqual([...keys[language]].sort(), englishKeys, `translation keys diverge for ${language}`);
  }
  // Stated separately from the parity check above, which would also pass if a
  // new string were left out of all six.
  for (const language of Object.keys(keys)) {
    for (const key of ["general.readOnlySurface", "general.readOnlyControl"]) {
      assert.ok([...keys[language]].includes(key), `${key} is missing from ${language}`);
    }
  }
  const samples = [
    ["zh-CN", "用量"],
    ["ar", "الاستخدام"],
    ["hi", "उपयोग"],
    ["ja", "使用量"],
    ["ko", "사용량"],
  ];
  try {
    for (const [language, navUsage] of samples) {
      setLanguage(language);
      assert.equal(getLanguage(), language);
      assert.equal(t("nav.usage"), navUsage);
    }
    setLanguage("zh-CN");
    assert.equal(t("usage.resetsToday", { time: "10:30" }), "今天 10:30 重置");
  } finally {
    setLanguage("en");
  }
  assert.equal(t("nav.usage"), "Usage");
});

test("desktop UI marks Arabic as the only right-to-left language", () => {
  for (const { id, dir } of availableLanguages()) {
    if (id === "ar") assert.equal(dir, "rtl");
    else assert.notEqual(dir, "rtl", `unexpected right-to-left direction for ${id}`);
  }
});
