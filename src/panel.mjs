// The companion in a browser. The router already serves apps/desktop/ui at
// /panel behind the caller capability, so nothing here builds, downloads, or
// installs anything -- the only thing missing was a way to reach it, because
// the URL carries the capability and no surface ever produced one.
//
// It opens the browser rather than printing the address. AGENTS.md treats the
// capability path as local authentication, and a URL echoed to a terminal
// survives in scrollback, screen shares, and pasted bug reports. `--print` is
// the deliberate exception for someone who has to move it to another browser,
// and it says what it is handing over.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { assertCallerSecret, panelBootstrapUrl, panelSessionUrl, redactCallerUrl } from "./caller-auth.mjs";
import { CALLER_SECRET_PATH, PORTS } from "./paths.mjs";

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const help = args.includes("--help");

if (help) {
  process.stdout.write(
    `Usage: panel.mjs [--print]

Opens the Model Router companion in your default browser.

  --print   Write the address instead of opening it. It contains a one-use
            browser bootstrap nonce that expires after 30 seconds; do not
            reuse or share it.
`,
  );
  process.exit(0);
}

// The same failure the router itself reports, pointed at the same repair, so a
// missing key reads identically wherever someone meets it first.
function callerSecret() {
  if (!existsSync(CALLER_SECRET_PATH)) {
    throw new Error(
      "The local router caller key is missing; run ./bin/doctor --fix (.\\codex-router.ps1 doctor --fix on Windows).",
    );
  }
  return assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
}

// A panel served by a stopped router is a blank page with no explanation, so
// the state is checked before a browser is opened rather than after. /health is
// the one route ahead of the capability check, which is why it can be asked
// without putting the secret on a command line.
async function routerIsRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORTS.router}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    // A degraded dependency still means the Node router is listening and can
    // mint the browser session; the panel itself will show the health state.
    return response.ok || response.status === 503;
  } catch {
    return false;
  }
}

function openInBrowser(url) {
  const [command, commandArgs] =
    process.platform === "win32"
      ? // The empty string is `start`'s title argument. Without it a quoted URL
        // becomes the window title and nothing opens.
        ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    execFile(command, commandArgs, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function mintPanelBootstrapUrl(secret) {
  const response = await fetch(panelSessionUrl(PORTS.router, secret), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: "{}",
    signal: AbortSignal.timeout(2000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.nonce !== "string") {
    const error = new Error("The router could not create a browser panel session.");
    error.status = response.status;
    throw error;
  }
  return panelBootstrapUrl(PORTS.router, payload.nonce);
}

async function main() {
  const secret = callerSecret();

  if (!(await routerIsRunning())) {
    process.stdout.write(
      `The router is not answering on port ${PORTS.router}, so the panel would load empty.\n` +
        "Start it first, then run this again.\n",
    );
    process.exitCode = 1;
    return;
  }

  const url = await mintPanelBootstrapUrl(secret);
  if (printOnly) {
    process.stdout.write(`${url}\n`);
    return;
  }

  await openInBrowser(url);
  process.stdout.write("Opened the companion in a clean browser session.\n");
}

main().catch((error) => {
  process.stderr.write(
    `${redactCallerUrl(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exit(1);
});
