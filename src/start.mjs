import { existsSync, readFileSync } from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  CODEX_HOME,
  INTERNAL_SECRET_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  loopback,
} from "./paths.mjs";
import { MODELS } from "./model-registry.mjs";
import { environmentProxyOptedIn } from "./proxy-environment.mjs";
import { clearServiceProcessState, writeServiceProcessState } from "./service-process.mjs";
import { nodeRuntimeTopology, startNodeRuntime } from "./node-runtime.mjs";
import { rebuildAfterStartup } from "./node-snapshot-triggers.mjs";

if (!existsSync(INTERNAL_SECRET_PATH)) {
  throw new Error("Internal service key is missing; run ./bin/install.");
}
if (!existsSync(CALLER_SECRET_PATH)) {
  throw new Error("Router caller key is missing; run ./bin/install.");
}
const internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
if (!internalKey) throw new Error("Internal service key is empty.");
const callerKey = assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
const devinCliRouted = MODELS.some((model) => model.provider === "devin-cli");

// The process environment is shared by the Router and its Node forwarders.
// Direct dispatch is explicit so a missing legacy service cannot become a
// hidden startup dependency.
const commonEnv = {
  MODEL_ROUTER_TARGET: TARGET,
  MODEL_ROUTER_STATE_DIR: STATE_DIR,
  MODEL_ROUTER_CALLER_KEY: callerKey,
  MODEL_ROUTER_INTERNAL_KEY: internalKey,
  MODEL_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  MODEL_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  MODEL_ROUTER_API_PORT: String(PORTS.api),
  MODEL_ROUTER_PORT: String(PORTS.router),
  MODEL_ROUTER_GROK_OAUTH_PORT: String(PORTS.grokOauth),
  MODEL_ROUTER_DEVIN_CLI_PORT: String(PORTS.devinCli),
  MODEL_ROUTER_QUIET: "1",
  CODEX_HOME,
  CODEX_ROUTER_CALLER_KEY: callerKey,
  CODEX_ROUTER_INTERNAL_KEY: internalKey,
  KIMI_INTERNAL_KEY: internalKey,
  KIMI_OAUTH_FORWARD_BASE_URL: loopback(PORTS.oauth, "/v1"),
  GROK_OAUTH_FORWARD_BASE_URL: loopback(PORTS.grokOauth, "/v1"),
  DEVIN_CLI_FORWARD_BASE_URL: loopback(PORTS.devinCli, "/v1"),
  CODEX_ROUTER_API_FORWARD_BASE_URL: loopback(PORTS.api, "/v1"),
  CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL: loopback(PORTS.api),
  CODEX_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  CODEX_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: loopback(PORTS.grokOauth, "/health"),
  CODEX_ROUTER_DEVIN_CLI_HEALTH_URL: loopback(PORTS.devinCli, "/health"),
  CODEX_ROUTER_DEVIN_CLI_HEALTH_ENABLED: devinCliRouted ? "1" : "0",
  CODEX_ROUTER_CATALOG: MERGED_CATALOG_PATH,
  CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  CODEX_ROUTER_API_PORT: String(PORTS.api),
  CODEX_ROUTER_PORT: String(PORTS.router),
  CODEX_ROUTER_DIRECT_DISPATCH: "1",
  NO_COLOR: "1",
  ...(environmentProxyOptedIn() ? { NODE_USE_ENV_PROXY: "1" } : {}),
};

let runtime;
let shuttingDown = false;

async function stopRuntime(signal = "SIGTERM") {
  shuttingDown = true;
  if (runtime) await runtime.stop(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stopRuntime(signal);
  });
}

async function main() {
  await rebuildAfterStartup();
  runtime = await startNodeRuntime({
    ...nodeRuntimeTopology({
      sourceRoot: SOURCE_ROOT,
      nodeBinary: process.execPath,
      ports: PORTS,
      environment: commonEnv,
      internalKey,
      devinCliRouted,
    }),
    isShuttingDown: () => shuttingDown,
  });

  console.error("[codex-router] ready (authenticated loopback endpoint)");
  const result = await runtime.exited;
  if (!shuttingDown) {
    if (result.error) {
      console.error(`[codex-router] ${result.label} failed: ${result.error.message || String(result.error)}.`);
    } else {
      console.error(
        `[codex-router] ${result.label} exited (code=${String(result.code)}, signal=${String(result.signal)}).`,
      );
    }
  }
  return result.error ? 1 : result.code || 0;
}

let exitCode = 0;
let serviceProcessRecorded = false;
try {
  if (process.platform === "win32") {
    writeServiceProcessState({
      ports: {
        oauth: PORTS.oauth,
        api: PORTS.api,
        grokOauth: PORTS.grokOauth,
        devinCli: PORTS.devinCli,
        router: PORTS.router,
      },
    });
    serviceProcessRecorded = true;
  }
  exitCode = await main();
} catch (error) {
  if (!shuttingDown) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[model-router] startup failed: ${reason}; inspect the service logs above for details.`);
    exitCode = 1;
  }
} finally {
  await stopRuntime();
  if (serviceProcessRecorded) {
    try {
      clearServiceProcessState();
    } catch {
      // A stale record is harmless after the root and its children are gone.
    }
  }
}
process.exitCode = exitCode;
