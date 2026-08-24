import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";

const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");

// Keep this helper for lifecycle controls that genuinely need a service reload.
// Local model downloads are Vision-only and never call it to publish a chat
// route. Probe the service first: dev checkouts and test harnesses run the
// router in the foreground, where there is nothing to restart.
export function routerServiceStatus({ spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(process.execPath, [SERVICE_SCRIPT, "status"], {
    cwd: SOURCE_ROOT,
    env,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return { installed: false };
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      installed: parsed.installed === true,
      loaded: parsed.loaded === true,
      state: typeof parsed.state === "string" ? parsed.state : undefined,
    };
  } catch {
    return { installed: false };
  }
}

export function restartRouterServiceIfInstalled({ spawn = spawnSync, env = process.env } = {}) {
  if (!routerServiceStatus({ spawn, env }).installed) return false;
  const result = spawn(process.execPath, [SERVICE_SCRIPT, "restart"], {
    cwd: SOURCE_ROOT,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "The router service could not be restarted; local model routes will not go live until it is.",
    );
  }
  return true;
}
