import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { callerBaseUrl, redactCallerUrl, validCallerSecret } from "./caller-auth.mjs";
import { aggregateSnippetStatus } from "./cc-switch-snippet.mjs";
import { codexAuthStatus, findCodexBinary, runCodex } from "./codex-binary.mjs";
import { readCodexConfigStatus } from "./codex-config-status.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";
import { routedCodexAgentStatus } from "./codex-agent-catalog.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { grokCliPreflight } from "./grok-cli.mjs";
import { detectLegacyInstallations } from "./legacy-migration.mjs";
import { routedCatalogConfigured } from "./catalog.mjs";
import { MODEL_BY_SLUG, PROVIDERS } from "./model-registry.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthHealth } from "./oauth-status.mjs";
import {
  applyMultiAgentCapabilities,
  readMultiAgentSettings,
  subagentEligibleModels,
} from "./multi-agent-state.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { serviceFollowsHostApps } from "./presence-state.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import {
  CALLER_SECRET_PATH,
  CODEX_AGENTS_DIR,
  CODEX_HOME,
  CONFIG_PATH,
  INTERNAL_SECRET_PATH,
  MERGED_CATALOG_PATH,
  NODE_ROUTES_PATH,
  PORTS,
  ROUTED_CATALOG_PATH,
  SOURCE_ROOT,
  TARGET,
} from "./paths.mjs";
import { standaloneSearchStatus } from "./standalone-search-doctor.mjs";
import { CODEX_APP_TOOLS } from "./codex-app-tools.mjs";
import {
  skillPackStatus,
  skillRequiredFields,
} from "./skills-install.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { credentialLabel, credentialStatus } from "./provider-credentials.mjs";
import { providerNeedsCuration } from "./provider-onboarding.mjs";
import { stateOwnershipStatus } from "./state-owner.mjs";
import {
  configuredProviderIds,
  providerSelectionStatus,
  readProviderSelection,
  selectedConfiguredListedModels,
} from "./provider-selection.mjs";
import { resolveVisionEngine } from "./vision-bridge.mjs";
import { nodeRoutableModels } from "./model-contract.mjs";
import { nativeSessionAvailable } from "./codex-native-session.mjs";
import {
  readVisionBridgeSettings,
  visionBridgeConfigured,
} from "./vision-bridge-state.mjs";
import {
  failoverTierCounts,
  readFailoverSettings,
  readProviderCooldowns,
} from "./model-failover.mjs";
import { contextWindowDrift, describeContextWindowDrift } from "./context-window-drift.mjs";
import { observedInputCeilings } from "./usage-events.mjs";
import {
  requireMacOSRepair,
} from "./dependency-repair.mjs";
import {
  describeRetentionAge,
  describeRetentionTtl,
  formatRetentionBytes,
  retainedToolResultsUsage,
} from "./tool-result-retention.mjs";
import { retentionTtlMs } from "./tool-result-aging-state.mjs";
import { refuseUnsupportedPlatform } from "./platform-gate.mjs";
import { runRuntimeMigration } from "./update.mjs";
import { currentServiceTarget } from "./paths.mjs";

if (process.argv.includes("--fix") && refuseUnsupportedPlatform("doctor:fix")) process.exit(2);

const checks = [];
const add = (status, name, detail, fix) => checks.push({ status, name, detail, fix });
const jsonOutput = process.argv.includes("--json");

// Asks Codex to load its own configuration and returns its complaint, if any.
// `login status` exits non-zero merely for being signed out, so the exit code
// says nothing here; only the load-error message does.
function configLoadComplaint(binary, spawn) {
  try {
    // A .cmd shim needs the cmd.exe hop, or the probe dies before Codex is
    // reached -- and a probe that never ran reports no complaint, which made
    // this check silently pass on every npm-installed Windows Codex.
    const target = spawnableCommand(binary, ["login", "status"]);
    const result = spawn(target.command, target.args, {
      ...target.options,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.error) return undefined;
    return `${result.stdout || ""}\n${result.stderr || ""}`
      .split(/\r?\n/)
      .find((candidate) => /Error loading configuration/i.test(candidate))
      ?.trim();
  } catch {
    // A binary that cannot be spawned is already reported by its own check.
    return undefined;
  }
}

// The desktop app and the CLI on PATH are often different builds, and they do
// not agree on what config they accept: a key the bundled binary reads happily
// can abort the whole load in an older `codex` on PATH, leaving the app working
// while every terminal command fails. Both are asked, and the failing one is
// named -- checking only one is how that split goes unnoticed.
export function codexConfigLoadError({
  spawn = spawnSync,
  binaries = [findCodexBinary(), commandOnPath("codex")],
} = {}) {
  // The probe is `codex login status` against the user's real CODEX_HOME, and
  // Codex reads its session file to answer it. --no-discovery promises that
  // read never happens, so the config-load check goes unanswered in idle mode.
  if (discoveryDisabled()) return undefined;
  const seen = new Set();
  for (const binary of binaries) {
    if (!binary || seen.has(binary)) continue;
    seen.add(binary);
    const complaint = configLoadComplaint(binary, spawn);
    if (complaint) return `${complaint} (via ${binary})`;
  }
  return undefined;
}


function readableSecret(target, validator) {
  if (!existsSync(target)) return false;
  try {
    return validator(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

function childJson(script, args = []) {
  return JSON.parse(
    execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

export async function repairRuntimeTransaction(steps = {}) {
  return runRuntimeMigration({
    ...steps,
    target: steps.target || currentServiceTarget(),
  });
}

async function repair() {
  requireMacOSRepair();
  const ownership = stateOwnershipStatus();
  if (
    ownership.foreign &&
    !ownership.overridden &&
    ownership.owner &&
    existsSync(path.join(ownership.owner, "src", "doctor.mjs")) &&
    existsSync(path.join(ownership.owner, "bin", "install"))
  ) {
    // A foreign doctor run must not repoint the live installation by accident.
    // The recorded owner still exists, so run the same repair from there; only
    // an explicit override or a fresh install transfers ownership.
    process.stderr.write(
      `codex-router: repairing from the owning checkout ${ownership.owner}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [path.join(ownership.owner, "src", "doctor.mjs"), ...process.argv.slice(2)],
      { cwd: ownership.owner, env: process.env, stdio: "inherit" },
    );
    if (result.error) {
      throw new Error(
        `Could not run doctor from the owning checkout ${ownership.owner}: ${result.error.message}`,
      );
    }
    process.exit(result.status ?? 1);
  }

  // Homebrew owns every file under the formula prefix. A Node-only repair can
  // regenerate configuration and services in place; no foreign runtime tree
  // is inspected or rebuilt here.

  const legacy = detectLegacyInstallations();
  if (legacy.unknownConflict) {
    throw new Error(
      `Another router owns ${legacy.config.modelCatalogJson}; repair will not overwrite it.`,
    );
  }
  if (legacy.installations.length && !process.argv.includes("--migrate-known")) {
    throw new Error(
      `A known older router (${legacy.installations.map((item) => item.id).join(", ")}) was found. Re-run with --fix --migrate-known to snapshot and migrate it.`,
    );
  }
  const repairStdio = jsonOutput ? ["inherit", "ignore", "inherit"] : "inherit";
  // Checkout repair rebuilds dependencies unconditionally: the fingerprints
  // an ordinary install trusts cannot see a corrupted node_modules or virtual
  // environment. Homebrew has already validated its package-owned tree above,
  // so its repair only regenerates configuration and services.
  await repairRuntimeTransaction({
    installReplacement: async () => {
      if (legacy.installations.length) {
        childJson("legacy-migration.mjs", ["apply", "--yes"]);
      }
      const result = spawnSync(path.join(SOURCE_ROOT, "bin", "install"), [], {
        cwd: SOURCE_ROOT,
        env: process.env,
        stdio: repairStdio,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Repair installer exited with ${result.status}.`);
    },
  });
}

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: doctor [--json] [--fix [--migrate-known]]

Checks the complete Codex Router installation without printing credentials.
--fix reinstalls generated files, configuration, and the background service.
Known older routers are migrated only with the explicit --migrate-known flag.
`);
  process.exit(0);
}

if (process.argv.includes("--fix")) {
  try {
    await repair();
    if (!jsonOutput) process.stdout.write("Repair completed; verifying the result.\n\n");
  } catch (error) {
    console.error(`codex-router repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
add(
  major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail",
  "Node.js",
  `${process.version}; 22.19 or newer required`,
  "Install Node.js 24 LTS, then run ./bin/doctor --fix.",
);
add(
  process.platform === "darwin" ? "ok" : "fail",
  "Platform",
  process.platform,
  "Use the macOS build of the model router.",
);

// Everything from here to the routing-config check describes the *client* this
// command was invoked for. The shared router plane below it is checked the
// same way whichever integration asked, because it is the same plane.
const codexTarget = TARGET === "codex";
const codex = codexTarget ? findCodexBinary() : undefined;
if (codexTarget) {
  add(
    codex ? "ok" : "fail",
    "Codex binary",
    codex || "not found",
    "Install Codex or set CODEX_BIN to the Codex CLI binary.",
  );
}
// A Codex binary that cannot be spawned reads as "signed out" everywhere it is
// probed, which silently removes every native model from the picker. Surface it
// as its own failure instead of letting it masquerade as a logged-out session.
const codexAuth = codexTarget ? codexAuthStatus() : undefined;
if (codexTarget) {
  add(
    codexAuth.reason === "probe-failed" ? "fail" : "ok",
    "Codex sign-in probe",
    codexAuth.reason === "probe-failed"
      ? `could not run ${codexAuth.binary} (${codexAuth.code || "spawn failed"})`
      : codexAuth.reason,
    "Set CODEX_BIN to a Codex CLI Node can spawn; on Windows use the codex.cmd shim, not the extensionless one.",
  );
  add(
    existsSync(CONFIG_PATH) ? "ok" : "fail",
    "Codex config",
    CONFIG_PATH,
    "Start Codex once, then run ./bin/doctor --fix.",
  );
}
// Every other check here can pass while Codex refuses to start, because a
// single unparseable key aborts the whole config load -- no models, native or
// routed. Codex's own loader is the only authority on that, and its error
// names the file, line, and column, so it is worth quoting verbatim.
const configLoad = codexTarget ? codexConfigLoadError() : undefined;
if (codexTarget) {
  add(
    configLoad ? "fail" : "ok",
    "Codex config loads",
    configLoad || "Codex parses its configuration",
    configLoad
      ? "Codex cannot start until this line is fixed or removed; the message above names the file and line."
      : undefined,
  );
}
// Codex holds the managed base URL, which is a local caller capability.
const privacyTarget = CONFIG_PATH;
const configMode = existsSync(privacyTarget)
  ? statSync(privacyTarget).mode & 0o777
  : undefined;
const configProtected = privateFileIsProtected(privacyTarget);
add(
  configProtected ? "ok" : "fail",
  "Codex config privacy",
  configMode === undefined
    ? "missing"
    : process.platform === "win32"
      ? "current-user Windows ACL"
      : `mode ${configMode.toString(8)}`,
  "Run ./bin/doctor --fix; the managed router URL contains a local caller capability.",
);

let selection = { providers: [], explicit: false };
let requiredRoutedModels = [];
let catalogRoutedModels = [];
let requiredModels = new Set();
// Routed traffic is active only when the managed Codex config points at the
// router plane.
const routedTransportActive = routedCatalogConfigured(
  existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "",
);
// An install made with --no-provider --no-discovery is idle on purpose: the
// selection is an explicit empty list and the discovery marker is set. That
// state is what the operator asked for, so the empty selection and the empty
// catalog report at warn/ok -- the precedent is serviceStoppedByDesign below.
let idleInstall = false;
try {
  selection = providerSelectionStatus();
  idleInstall =
    selection.explicit && selection.providers.length === 0 && discoveryDisabled();
  requiredRoutedModels = selectedConfiguredListedModels();
  catalogRoutedModels = routedTransportActive ? requiredRoutedModels : [];
  requiredModels = new Set(catalogRoutedModels.map((model) => model.slug));
  add(
    selection.providers.length ? "ok" : idleInstall ? "warn" : "fail",
    "Enabled providers",
    selection.providers.length
      ? `${selection.providers.join(", ")}${selection.explicit ? "" : " (legacy show-all mode)"}`
      : idleInstall
        ? "none (idle install: --no-provider)"
        : "none",
    idleInstall
      ? "Run ./bin/setup without --no-provider to enable a provider."
      : "Run ./bin/setup --guided and choose at least one provider.",
  );
  // The router no longer refuses to serve on a selection file it cannot fully
  // resolve, so the damage has to be reported here instead of as a 502.
  if (selection.degraded) {
    add(
      "warn",
      "Provider selection file",
      selection.degraded,
      "Run ./bin/setup --guided, or ./bin/providers enable PROVIDER, to rewrite the selection with this build's provider ids.",
    );
  }
} catch (error) {
  add(
    "fail",
    "Enabled providers",
    error instanceof Error ? error.message : String(error),
    "Run ./bin/setup --guided to replace the invalid provider selection.",
  );
}

let catalogModels = [];
let catalogReadable = false;
try {
  const catalog = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
  if (Array.isArray(catalog.models)) {
    catalogModels = catalog.models;
    catalogReadable = true;
  }
} catch {
  // Reported as a failed catalog check below.
}
const catalogOk =
  catalogReadable &&
  (routedTransportActive && !idleInstall
    ? requiredModels.size > 0 &&
      [...requiredModels].every((slug) => catalogModels.some((model) => model.slug === slug))
    : !catalogModels.some((model) => MODEL_BY_SLUG.has(String(model.slug))));
// The merged catalog is the file Codex reads. A harness install has no
// equivalent: its offer is the settings route, checked by "Harness routing
// config" below. An idle install deliberately publishes no routed models, so
// its catalog is held to the same standard as inactive transport: nothing
// routable may be offered.
if (codexTarget) add(
  catalogOk ? "ok" : "fail",
  "Merged catalog",
  catalogOk
    ? idleInstall
      ? "idle install; no routed models"
      : routedTransportActive
        ? `${requiredModels.size} routed models`
        : "native-only; routed transport is inactive"
    : MERGED_CATALOG_PATH,
  "Run ./bin/refresh-catalog, or ./bin/doctor --fix if files are missing.",
);
// The catalog tells Codex which models to offer; the protected Node route
// snapshot decides which it can actually route. When a second checkout writes
// one of them the two drift apart, and the request must fail closed rather than
// fall through to a native account-level error.
const ownership = stateOwnershipStatus();
add(
  ownership.foreign ? "fail" : "ok",
  "State directory owner",
  ownership.foreign
    ? `owned by ${ownership.owner}, running from ${ownership.current}`
    : ownership.owner || "unowned (first install)",
  "Run router commands from the owning checkout, or reinstall from this one to take ownership.",
);
let unroutable = [];
try {
  const document = JSON.parse(readFileSync(NODE_ROUTES_PATH, "utf8"));
  const published = new Set(
    (Array.isArray(document?.routes) ? document.routes : [])
      .filter((route) => route?.routable === true)
      .map((route) => String(route.slug)),
  );
  unroutable = catalogRoutedModels
    .filter((model) => !published.has(String(model.slug)))
    .map((model) => model.slug);
} catch {
  // The missing snapshot is reported by the Node route check below.
}
add(
  unroutable.length ? "fail" : "ok",
  "Catalog matches Node routes",
  unroutable.length
    ? `${unroutable.length} offered model(s) have no Node route: ${unroutable.join(", ")}`
    : `${catalogRoutedModels.length} routed models`,
  "Run ./bin/doctor --fix from the owning checkout, then fully quit and reopen Codex.",
);
// Warn, not fail: an understated window still routes, and the operator may be
// running a plan whose real ceiling is genuinely lower than the vendor's. What
// they cannot do is notice it on their own -- the symptom is a session that
// compacts and restarts its own work forever, which reads as a bad model
// rather than a bad number.
const windowDrift = contextWindowDrift(catalogRoutedModels, observedInputCeilings());
add(
  windowDrift.length ? "warn" : "ok",
  "Context windows match observed traffic",
  windowDrift.length
    ? describeContextWindowDrift(windowDrift)
    : `${catalogRoutedModels.length} routed models, no provider has exceeded its declared window`,
  "The provider accepted more than the declared contextWindow, so the entry understates the model. Raise contextWindow (and autoCompact with it) in this model's config entry.",
);
// "Off" is a normal state and reports ok. Enabled with no resolvable engine is
// the broken one: Codex would keep offering the paste while nothing could read
// it, so the catalog drops the advertisement and this says why.
//
// Only for an operator who actually asked, though. The bridge is now on by
// default, so a plain text-only install reaches this branch having configured
// nothing and having lost nothing -- images degrade exactly as they did before
// the bridge existed. Warning there would put a yellow line on every fresh
// DeepSeek-only install for a feature nobody switched on. It still reports what
// is true, just at the severity the situation has.
//
// This check sees routed models only, so a native (ChatGPT-plan) engine is
// invisible to it and a signed-in install may well read images fine while this
// says nothing resolves.
const visionSettings = readVisionBridgeSettings();
let visionEngine;
let visionPolicyError;
try {
  visionEngine = resolveVisionEngine(
    () => {
      const enabledProviders = new Set(readProviderSelection());
      const credentialedProviders = new Set(configuredProviderIds());
      return nodeRoutableModels({
        enabledProviders,
        hiddenModels: readHiddenModels(),
      }).filter((model) => credentialedProviders.has(model.provider));
    },
    visionSettings,
    {
      strict: true,
      callerSession: { usable: nativeSessionAvailable() },
      enabledProviders: new Set(readProviderSelection()),
      credentialedProviders: new Set(configuredProviderIds()),
    },
  );
} catch (error) {
  if (error?.code !== "vision_engine_not_supported") throw error;
  visionPolicyError = error;
}
if (visionSettings.enabled && !visionEngine) {
  const asked = visionBridgeConfigured();
  add(
    asked ? "warn" : "ok",
    "Vision bridge",
    visionPolicyError
      ? `pinned engine ${visionSettings.engine || "local"} is not supported by the Vision reader policy`
      : visionSettings.engine
        ? `pinned engine ${visionSettings.engine} is not an enabled model that reads images`
      : asked
        ? "enabled, but no enabled provider offers a model that reads images"
        : "on by default, but no enabled provider offers a model that reads images yet",
    "Enable a provider with a vision model, sign in to ChatGPT, or run ./bin/model-router codex control vision-bridge setup for a local reader.",
  );
} else if (visionEngine?.local) {
  add(
    "ok",
    "Vision bridge",
    `text-only models read images via a local model (${visionEngine.gatewayModel} at ${visionEngine.baseUrl})`,
    "Make sure the local server is running and the model is pulled, e.g. `ollama pull " +
      `${visionEngine.gatewayModel}\`.`,
  );
} else {
  add(
    "ok",
    "Vision bridge",
    visionEngine ? `text-only models read images via ${visionEngine.slug}` : "off",
    "Run ./bin/model-router codex control vision-bridge on to let text-only models read pasted images.",
  );
}
// A cooldown is the router declining to send to a provider, which looks
// exactly like the provider being broken if nobody says so out loud. Report
// every live one with its expiry, so "why is my model not being used" has an
// answer here rather than in the log.
const failoverSettings = readFailoverSettings();
const activeCooldowns = Object.entries(readProviderCooldowns());
if (!failoverSettings.enabled) {
  add(
    "ok",
    "Model failover",
    "off -- a provider that runs out of usage ends the turn",
    "Run ./bin/model-router codex control failover on to let a turn continue on another enabled model.",
  );
} else if (activeCooldowns.length) {
  add(
    "warn",
    "Model failover",
    `holding off ${activeCooldowns
      .map(([id, entry]) => `${id} until ${entry.until} (${entry.reason || "reported empty"})`)
      .join(", ")}`,
    "Each clears itself at that time, or on the provider's next successful answer. " +
      "Run ./bin/model-router codex control failover reset to clear them now.",
  );
} else if (failoverSettings.chain.length) {
  add(
    "ok",
    "Model failover",
    `on, in the order you set: ${failoverSettings.chain.join(" -> ")}`,
    "Run ./bin/model-router codex control failover auto to hand the order back to the ranking.",
  );
} else {
  // Count what the ranking can actually reach rather than restating the tier
  // order. "Free models first" is only true where a free model exists, and on
  // a machine that has curated none it describes an order that cannot happen.
  const failoverHidden = readHiddenModels();
  const failoverCounts = failoverTierCounts(
    requiredRoutedModels.filter((model) => !failoverHidden.has(model.slug)),
  );
  add(
    "ok",
    "Model failover",
    failoverCounts.free
      ? `on, ${failoverCounts.free} free model(s) first then ${failoverCounts.subscription} of your own`
      : `on, ${failoverCounts.subscription} of your own providers -- no free model is curated, so nothing cheaper is tried first`,
    failoverCounts.free
      ? "Run ./bin/model-router codex control failover chain <model-slug,...> to choose the order yourself."
      : "Free catalogs change without notice so none are checked in. Run ./bin/model-router codex curate-models opencode-free to give failover a free first stop.",
  );
}
// The same list the catalog writes definitions from, so a model switched off
// as a subagent is expected to have no definition rather than a missing one.
// These are files in Codex's own agents directory.
const multiAgentSettings = readMultiAgentSettings();
const hiddenModels = readHiddenModels();
const effectiveSubagentModels = applyMultiAgentCapabilities(
  catalogRoutedModels,
  multiAgentSettings,
  { hidden: hiddenModels },
);
const agentStatus = codexTarget
  ? routedCodexAgentStatus(
      subagentEligibleModels(effectiveSubagentModels, multiAgentSettings),
    )
  : undefined;
if (codexTarget) add(
  agentStatus.ok ? "ok" : "fail",
  "Routed model agents",
  agentStatus.ok
    ? `${agentStatus.current} current definitions in ${CODEX_AGENTS_DIR}`
    : agentStatus.extra.length && agentStatus.current === agentStatus.expected
      ? `${agentStatus.extra.length} definitions in ${CODEX_AGENTS_DIR} for models that are switched off as subagents`
      : `${agentStatus.current} of ${agentStatus.expected} current definitions in ${CODEX_AGENTS_DIR}`,
  "Run ./bin/doctor --fix, then fully quit Codex, reopen it, and create a new task.",
);
add(
  "ok",
  "Dynamic subagent models",
  multiAgentSettings.disabled.length
    ? `verified v2 models except ${multiAgentSettings.disabled.length} disabled model(s)`
    : "only verified v2 models",
  "Complete the native collaboration proof before adding multiAgentVersion v2 to a model.",
);
add(
  "ok",
  "Model picker visibility",
  hiddenModels.size === 0
    ? "all enabled models visible"
    : `${hiddenModels.size} model(s) hidden from the picker`,
  "Change per-model visibility in the desktop Models settings.",
);
add(
  existsSync(NODE_ROUTES_PATH) || !routedTransportActive ? "ok" : "fail",
  "Node route snapshot",
  existsSync(NODE_ROUTES_PATH) ? NODE_ROUTES_PATH : "missing",
  "Run ./bin/doctor --fix from the owning checkout.",
);

const secretMode = existsSync(INTERNAL_SECRET_PATH)
  ? statSync(INTERNAL_SECRET_PATH).mode & 0o777
  : undefined;
const internalSecretValid = readableSecret(
  INTERNAL_SECRET_PATH,
  (value) => /^[A-Za-z0-9_-]{32,}$/.test(value),
);
const secretProtected =
  internalSecretValid && privateFileIsProtected(INTERNAL_SECRET_PATH);
add(
  secretProtected ? "ok" : "fail",
  "Internal service key",
  secretMode === undefined
    ? "missing"
    : !internalSecretValid
      ? "invalid"
      : process.platform === "win32"
        ? "current-user Windows ACL"
        : `mode ${secretMode.toString(8)}`,
  "Run ./bin/doctor --fix; this key is generated locally and is not a provider key.",
);

const callerSecretMode = existsSync(CALLER_SECRET_PATH)
  ? statSync(CALLER_SECRET_PATH).mode & 0o777
  : undefined;
const callerSecretValid = readableSecret(CALLER_SECRET_PATH, validCallerSecret);
const callerSecretProtected =
  callerSecretValid && privateFileIsProtected(CALLER_SECRET_PATH);
add(
  callerSecretProtected ? "ok" : "fail",
  "Router caller key",
  callerSecretMode === undefined
    ? "missing"
    : !callerSecretValid
      ? "invalid"
      : process.platform === "win32"
        ? "current-user Windows ACL"
        : `mode ${callerSecretMode.toString(8)}`,
  "Run ./bin/doctor --fix; this capability is generated locally and is not a provider key.",
);

// This is diagnostic metadata only: the actual aggregate TOML includes a
// local caller capability and is deliberately restricted to `control catalog
// render-snippet`. Doctor, logs, snapshots, and support bundles see this
// redacted status object instead.
const aggregateStatus = aggregateSnippetStatus({
  routedCatalogPath: ROUTED_CATALOG_PATH,
  redactedBaseUrl: callerSecretValid
    ? redactCallerUrl(callerBaseUrl(PORTS.router, readFileSync(CALLER_SECRET_PATH, "utf8").trim()))
    : "unavailable",
});
add(
  callerSecretValid ? "ok" : "fail",
  "CC Switch aggregate profile",
  `${aggregateStatus.modelCatalogJson}; ${aggregateStatus.baseUrl}; standalone web search supported`,
  "Run ./bin/doctor --fix to regenerate the local caller capability before rendering the snippet.",
);

if (codexTarget) {
  const search = standaloneSearchStatus(
    existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "",
  );
  add(
    search.ok ? "ok" : "warn",
    "Standalone web search",
    search.ok
      ? "web_search is live and the standalone search feature gate is enabled"
      : search.invalid || `missing ${search.missing.join(", ")}`,
    search.ok ? undefined : search.snippet,
  );
}

// Tool-result retention is the one place this router keeps model-visible
// *content* on disk rather than counts and bytes, and it has no eviction and no
// TTL. Reporting it here is the difference between an operator learning about
// the store from this line and learning about it while hunting disk usage. The
// row exists whether or not the store does: "nothing retained" is the answer
// most installs should see, and seeing it is how the directory becomes
// discoverable at all.
try {
  const ttlMs = retentionTtlMs();
  const retention = retainedToolResultsUsage({ ttlMs });
  // The TTL expires on the next write to the store, so a count here is what is
  // already dead rather than what has been removed -- the same way a cooldown
  // reads as gone before anything deletes it. Naming it is what tells an
  // operator whose install stopped compacting that `purge --expired` is the
  // sweep, not a wait.
  const expiry =
    !retention.exists || ttlMs === 0
      ? ""
      : retention.expired
        ? `, ${retention.expired} past the ${describeRetentionTtl(ttlMs)} TTL`
        : `, TTL ${describeRetentionTtl(ttlMs)}`;
  const retentionDetail = !retention.exists
    ? `nothing retained; no store at ${retention.path}`
    : `${retention.results} retained result(s), ${formatRetentionBytes(retention.bytes)}` +
      `${retention.oldestAgeMs === undefined ? "" : `, oldest ${describeRetentionAge(retention.oldestAgeMs)} old`}` +
      `${expiry}` +
      ` in ${retention.path}`;
  add(
    retention.capacityReached || retention.foreign.length ? "warn" : "ok",
    "Retained tool results",
    retention.capacityReached
      ? `${retentionDetail} -- at capacity, so new eligible results now pass through uncompacted`
      : retention.foreign.length
        ? `${retentionDetail}; ${retention.foreign.length} entry/entries this store did not write`
        : retentionDetail,
    "Run ./bin/control tool-result-aging purge to see what would be removed, then --yes to empty it.",
  );
} catch (error) {
  add(
    "warn",
    "Retained tool results",
    error instanceof Error ? error.message : String(error),
    "Run ./bin/control tool-result-aging purge to inspect the store.",
  );
}

// Per-provider credential rows are themselves discovery: each one resolves the
// provider's credential. Under --no-discovery the resolvers answer nothing by
// design, so 26 rows of "not configured" would report the guard's output as
// though it were the machine's state. One row says what is actually true.
const credentialDiscoveryOff = discoveryDisabled();
if (credentialDiscoveryOff) {
  add(
    "warn",
    "Credential discovery",
    "disabled (--no-discovery); provider credentials, the Keychain, and other CLIs' sessions are not read",
    "Re-run ./bin/setup without --no-discovery to re-enable it.",
  );
  const listenHost = process.env.CODEX_ROUTER_HOST || process.env.KIMI_ROUTER_HOST;
  if (listenHost && !["127.0.0.1", "localhost", "::1"].includes(listenHost)) {
    add(
      "warn",
      "Router listen host",
      `${listenHost} (an idle install is expected to stay loopback-only)`,
      "Unset CODEX_ROUTER_HOST / KIMI_ROUTER_HOST to bind 127.0.0.1.",
    );
  }
}
if (!credentialDiscoveryOff) {
  const kimiHealth = kimiOAuthHealth();
  const kimiSelected = selection.providers.includes("kimi-oauth");
  // An expired access token is a normal, recoverable state: the request path
  // refreshes it with the still-valid refresh token before forwarding, so it
  // must not read as a failure here. Every unusable state fails when Kimi OAuth
  // is selected; an unselected provider is advisory regardless of credential
  // health.
  const kimiStatus = !kimiSelected
    ? "warn"
    : kimiHealth.status === "ok" || kimiHealth.status === "stale"
      ? "ok"
      : "fail";
  add(
    kimiStatus,
    "Kimi OAuth",
    kimiHealth.detail,
    kimiHealth.fix,
  );
  const grokOauth = grokOAuthStatus();
  const grokCli = grokCliPreflight();
  const grokOauthReady = grokOauth.configured && grokCli.runnable;
  add(
    grokOauthReady ? "ok" : selection.providers.includes("grok-oauth") ? "fail" : "warn",
    "Grok OAuth",
    !grokCli.runnable
      ? grokCli.detail
      : grokOauth.configured
        ? grokOauth.source
        : `not configured; ${grokOauth.setup}`,
    !grokCli.runnable ? grokCli.fix : "Run grok login, then rerun the doctor.",
  );
}

for (const provider of PROVIDERS.values()) {
  if (provider.kind !== "openai-compatible") continue;
  if (credentialDiscoveryOff) continue;
  const status = credentialStatus(provider, { persistent: true });
  const credentialType = credentialLabel(provider);
  const credentialNoun = credentialType === "API key" ? "key" : credentialType.toLowerCase();
  // A keyless provider has no key to name, so calling its row a "key" and
  // telling the operator to run `provider-key` sends them at a command that
  // refuses them. What decides whether it works is its local runtime.
  add(
    status.configured ? "ok" : selection.providers.includes(provider.id) ? "fail" : "warn",
    provider.keyless
      ? `${provider.displayName} endpoint`
      : provider.authMode === "anonymous"
        ? `${provider.displayName} anonymous endpoint`
      : provider.authMode === "per-model"
        ? `${provider.displayName} per-model endpoints`
      : `${provider.displayName} ${credentialNoun}`,
    status.configured ? status.source : "not configured",
    provider.keyless
      ? provider.id === "local"
        ? "Start Ollama, then run ./bin/control local-models list."
        : `Start ${provider.displayName}, then run ./bin/curate-models ${provider.id}.`
      : provider.authMode === "anonymous"
        ? provider.anonymousNote || "No key needed; only the provider's free models are available."
      : provider.authMode === "per-model"
        ? "Each model here names its own endpoint; a model that needs a key reports it on its own row."
      : `Run ./bin/provider-key ${provider.id} set.`,
  );
  // A credential that resolves says nothing about whether the account's plan
  // may use the API. Only warn once the provider is actually selected, so the
  // doctor does not lecture about providers nobody enabled.
  if (provider.planNote && selection.providers.includes(provider.id)) {
    add("warn", `${provider.displayName} plan`, provider.planNote, "Check the plan on the provider's billing page.");
  }
  // A working key on a catalog-only provider still shows an empty picker until
  // its models are curated, and nothing else says so after the key is stored.
  // Anyone who set a key before that hint existed can only find out here.
  if (status.configured && providerNeedsCuration(provider.id)) {
    add(
      "warn",
      `${provider.displayName} models`,
      provider.keyless
        ? "no local models are checked, so the picker stays empty"
        : provider.authMode === "anonymous"
          ? `${provider.displayName} is ready; discover and curate its current free models`
        : `${credentialNoun} stored but no models curated; the picker stays empty`,
      // Ollama models are downloaded and checked locally; other keyless local
      // providers use the generic live catalog curation path.
      provider.keyless
        ? provider.id === "local"
          ? `Install one with ./bin/control local-models install <tag-or-url> --yes; tool-capable models are checked automatically.`
          : `Run ./bin/curate-models ${provider.id} in an interactive terminal.`
        : `Run ./bin/curate-models ${provider.id} in an interactive terminal.`,
    );
  }
}

try {
    const config = readCodexConfigStatus(existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "");
    add(
      config.mode === "router" ? "ok" : "fail",
      "Codex routing config",
      config.mode,
      "Run ./bin/enable or ./bin/doctor --fix.",
    );
    const providerModeOk = config.login_free
      ? config.login_free_managed
      : !config.provider_mode_state_present;
    add(
      providerModeOk ? "ok" : "fail",
      "Codex login mode",
      config.login_free
        ? config.login_free_managed
          ? "external providers; OpenAI login not required"
          : "unmanaged custom provider"
        : config.provider_mode_state_present
          ? "stale provider-mode restore state"
          : "OpenAI login available",
      "Use the tray toggle to switch modes, or run ./bin/doctor --fix.",
    );
    const signedModeOk = config.signed_routing
      ? config.signed_routing_managed
      : !config.signed_provider_state_present;
    add(
      signedModeOk ? "ok" : "fail",
      "Signed router coexistence",
      config.signed_routing
        ? config.signed_routing_managed
          ? "active; native GPT and external models share the authenticated router"
          : "active without managed restore state"
        : config.signed_provider_state_present
          ? `ownership drift; active provider is ${config.model_provider}`
          : `off; active provider is ${config.model_provider}`,
      "Use the tray toggle to restore the previous provider table before changing configuration managers.",
    );
  } catch (error) {
    add(
      "fail",
      "Codex routing config",
      error instanceof Error ? error.message : String(error),
      "Inspect ~/.codex/config.toml, then run ./bin/doctor --fix.",
    );
  }

const legacy = detectLegacyInstallations();
add(
  legacy.unknownConflict ? "fail" : legacy.installations.length ? "fail" : "ok",
  "Router ownership",
  legacy.unknownConflict
    ? `unknown catalog: ${legacy.config.modelCatalogJson}`
    : legacy.installations.length
      ? `older router: ${legacy.installations.map((item) => item.id).join(", ")}`
      : "no conflicting router detected",
  legacy.installations.length
    ? "Run ./bin/doctor --fix --migrate-known."
    : "Disable the other router manually; Codex Router will not overwrite it.",
);

// When the tray follows the desktop apps it stops the service as soon as Codex
// and ChatGPT are both closed. That is the resting state, not a fault, so it
// must not read as a failure: a `fail` here sets the exit code and sends the
// tray's Fix button down the full repair path for a router that is off on
// purpose.
// A ChatGPT session the router can no longer spend is not a router fault, but
// it is why native models stop appearing in the harness -- and it is fixed by
// opening Codex, which nothing else would tell the user.
try {
  const { nativeSessionStatus } = await import("./codex-native-session.mjs");
  const session = nativeSessionStatus();
  if (session.present && session.fallbackEnabled) {
    const hours = session.expiresInHours;
    add(
      session.usable ? "ok" : "warn",
      "Codex session for native models",
      session.usable
        ? `valid${hours === undefined ? "" : ` for ${hours}h`}`
        : "expired; open Codex once to renew it (native models are withheld until then)",
      "Open Codex, or run `codex login`.",
    );
  }
} catch {
  // Never let a diagnostic be the thing that fails the doctor.
}

const followsHostApps = serviceFollowsHostApps();
let serviceLoaded = false;
let serviceStoppedByDesign = false;
try {
  const service = childJson("service.mjs", ["status"]);
  serviceLoaded = Boolean(service.loaded);
  serviceStoppedByDesign = !serviceLoaded && followsHostApps;
  add(
    serviceLoaded ? "ok" : serviceStoppedByDesign ? "warn" : "fail",
    "Background service",
    serviceStoppedByDesign
      ? "stopped; following Codex (open Codex or ChatGPT to start it)"
      : service.state || "stopped",
    "Run ./bin/enable or ./bin/doctor --fix.",
  );
} catch (error) {
  add(
    "fail",
    "Background service",
    error instanceof Error ? error.message : "not available",
    "Run ./bin/doctor --fix.",
  );
}

const health = await waitForRouterHealth({ timeoutMs: serviceLoaded ? 30_000 : 2_000 });
// A router that answers while a dependency is down is not the same outcome as
// a router that never answered, and saying "not ready" for both sent operators
// looking for a dead service when one of the local Node forwarders is the
// thing that died.
const degradedDependencies = Array.isArray(health.degradedPayload?.degraded)
  ? health.degradedPayload.degraded
  : [];
add(
  health.ok ? "ok" : serviceStoppedByDesign ? "warn" : "fail",
  "Router health",
  health.ok
    ? `version ${health.payload.version}`
    : serviceStoppedByDesign
      ? "not serving; the background service is following Codex"
      : degradedDependencies.length
        ? `serving on 127.0.0.1:${PORTS.router} but ${health.error}` +
          ""
        : `not ready on 127.0.0.1:${PORTS.router} after ${serviceLoaded ? 30 : 2} seconds; ${health.error}`,
  "Run ./bin/doctor --fix. If it still fails, create a support bundle.",
);

// The skill pack that teaches custom routed models the native tools. Checks
// are read-only; the fixes re-run ./bin/install, which refreshes exactly the
// marker-owned directories. It lives in Codex's user-skill directory and
// describes Codex's own tools, so it is not part of a harness install.
if (codexTarget) {
  const status = skillPackStatus(CODEX_HOME);
  add(
    status.missing.length === 0 ? "ok" : "fail",
    "Codex skill pack",
    status.missing.length === 0
      ? `${status.managed.length} verified managed skill(s)`
      : `missing: ${status.missing.join(", ")}`,
    "./bin/install",
  );
  add(
    status.stale.length === 0 ? "ok" : "warn",
    "Codex skill pack freshness",
    status.stale.length === 0
      ? "verified skills match the checkout"
      : `verified skills differ from the checkout: ${status.stale.join(", ")}`,
    "./bin/install (replaces managed skills)",
  );
  if (status.collisions.length > 0) {
    add(
      "warn",
      "Codex skill pack collisions",
      `existing skills not verified as codex-router-owned: ${status.collisions.join(", ")}`,
      "rename or remove the conflicting skills, then run ./bin/install",
    );
  }
  if (!status.ownershipStateValid || status.staleOwnership.length > 0) {
    add(
      "warn",
      "Codex skill pack ownership",
      !status.ownershipStateValid
        ? "private ownership state is malformed; no existing skill will be replaced"
        : `stale ownership records: ${status.staleOwnership.join(", ")}`,
      "run ./bin/install; unverified existing content will be preserved",
    );
  }
  // The declaration comes from the skill itself, then is compared with the
  // app snapshot. This makes the check evidence about the shipped skill text
  // rather than a comparison between two JavaScript literals.
  const expectedRequired = skillRequiredFields();
  const codexApp = CODEX_APP_TOOLS.find((entry) => entry.name === "codex_app");
  const toolsByName = new Map((codexApp?.tools || []).map((fn) => [fn.name, fn]));
  const drift = [];
  if (!expectedRequired) {
    drift.push("skill declaration is missing or malformed");
  } else {
    for (const [name, expected] of Object.entries(expectedRequired)) {
      const fn = toolsByName.get(name);
      const have = [...(fn?.inputSchema?.required || [])].sort();
      if (!fn || JSON.stringify(have) !== JSON.stringify([...expected].sort())) {
        drift.push(`${name} (skill declares [${expected.join(", ")}], snapshot requires [${have.join(", ")}])`);
      }
    }
  }
  add(
    drift.length === 0 ? "ok" : "warn",
    "Codex skill pack schema match",
    drift.length === 0
      ? "skill declaration matches the app toolset snapshot"
      : `skill shapes drifted from the snapshot: ${drift.join("; ")}`,
    "co-revise the skill pack together with src/codex-app-tools.mjs",
  );
}

if (codex && catalogOk && routedTransportActive && credentialDiscoveryOff) {
  // `debug models` without --bundled answers with the signed-in account's
  // catalog, which a discovery-disabled install promised never to consult.
  // The on-disk catalog was already verified above; the only thing skipped
  // is the is-Codex-restarted staleness probe.
  add(
    "ok",
    "Codex model catalog",
    "on-disk catalog verified; the account-aware staleness probe is skipped while discovery is off",
    "Re-enable discovery to restore the startup staleness check.",
  );
} else if (codex && catalogOk && routedTransportActive) {
  try {
    const parsed = JSON.parse(
      runCodex(["debug", "models"], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    const slugs = new Set((parsed.models || []).map((model) => model.slug));
    const visible = [...requiredModels].every((slug) => slugs.has(slug));
    add(
      // The catalog on disk is already verified above. Codex reads that file
      // only at startup, so an otherwise healthy update made while Codex is
      // open necessarily sees the previous in-memory catalog here. That is a
      // restart requirement, not an installation failure: treating it as a
      // failure makes the tray report that Update and Fix both failed after
      // they successfully installed the new revision.
      visible ? "ok" : "warn",
      "Codex model catalog",
      visible ? `${requiredModels.size} routed entries visible` : "startup catalog is stale",
      "Fully quit Codex, reopen it, and create a new task.",
    );
  } catch (error) {
    add(
      "warn",
      "Codex model catalog",
      error instanceof Error ? error.message : String(error),
      "Set CODEX_BIN if Codex is installed in a nonstandard location.",
    );
  }
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), checks }, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    if (check.status === "fail" && check.fix) process.stdout.write(`      Fix: ${check.fix}\n`);
  }
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
