import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import { stopManagedOllama } from "./ollama-runtime.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";
import { environmentProxyOptedIn } from "./proxy-environment.mjs";

const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const script = {
  darwin: "service-macos.mjs",
  linux: "service-linux.mjs",
  win32: "service-windows.mjs",
}[platform];

if (!script) {
  throw new Error(`Unsupported background-service platform: ${platform}`);
}

const command = process.argv[2] || "status";
const mutatingCommands = new Set(["install", "uninstall", "start", "stop", "restart"]);
const readinessCommands = new Set(["install", "start", "restart"]);
const shutdownCommands = new Set(["stop", "uninstall"]);
// The Node runtime has no third-party gateway cold start. Keep service
// readiness bounded by the local Router health window.
const READINESS_TIMEOUT_MS = 30_000;

async function runServiceCommand() {
  // The wrapper below is a separate Node process, so a direct
  // `node --use-env-proxy src/service.mjs ...` invocation would otherwise lose
  // its CLI-only opt-in before the platform renderer can persist it.
  const childEnvironment = {
    ...process.env,
    ...(environmentProxyOptedIn() ? { NODE_USE_ENV_PROXY: "1" } : {}),
  };
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...process.argv.slice(2)],
    { stdio: "inherit", env: childEnvironment },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  // A server that was already running is external and stopManagedOllama() is
  // a no-op. Only the exact detached `ollama serve` process this router
  // started is coupled to an explicit router shutdown. Installs and restarts
  // deliberately keep it alive across the brief service handoff.
  if (shutdownCommands.has(command)) await stopManagedOllama();
  if (!readinessCommands.has(command)) return 0;

  const health = await waitForRouterHealth({ timeoutMs: READINESS_TIMEOUT_MS });
  if (health.ok) return 0;
  console.error(
    `Router did not become healthy within ${READINESS_TIMEOUT_MS / 1_000} seconds: ${health.error}`,
  );
  return 1;
}

try {
  const status = mutatingCommands.has(command)
    ? await withServiceOperationLock(runServiceCommand)
    : await runServiceCommand();
  process.exit(status);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
