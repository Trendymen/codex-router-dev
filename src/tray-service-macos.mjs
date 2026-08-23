import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  currentServiceTarget,
} from "./paths.mjs";
import { refuseUnsupportedPlatform } from "./platform-gate.mjs";

const command = process.argv[2] || "status";
const renderOnly = command === "render";
if (!renderOnly && refuseUnsupportedPlatform(`tray:${command}`)) process.exit(2);
const target = currentServiceTarget();
const launchctl = "/bin/launchctl";
const domain = target.launchDomain;
const service = target.trayService;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// KeepAlive is conditional on purpose. `SuccessfulExit: false` restarts the tray
// when it crashes or is killed, but leaves it down after the Quit menu item
// exits cleanly — an unconditional KeepAlive would make Quit impossible.
//
// `--supervised` marks the launch as launchd's rather than the user's. Opening
// Model Router by hand reveals the menu bar item and starts the router on
// purpose; a login start must not, or follow mode would be overridden every
// time the user logs in. AppDelegate.launchedByUser reads this argument.
function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(target.trayLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(target.appBinary)}</string>
    <string>--supervised</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

function run(args, options = {}) {
  return execFileSync(launchctl, args, {
    encoding: "utf8",
    timeout: 15_000,
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function loaded() {
  try {
    const description = run(["print", service]);
    return /(?:state|path|type) =/.test(description) ? description : undefined;
  } catch {
    return undefined;
  }
}

function bootout() {
  if (!loaded()) return;
  try {
    run(["bootout", service], { quiet: true });
  } catch (error) {
    if (loaded()) throw error;
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!loaded()) return;
    Atomics.wait(retryWait, 0, 0, 100);
  }
  throw new Error(`Timed out waiting for ${target.trayLabel} to stop.`);
}

function writeAgent() {
  mkdirSync(target.launchAgentsDir, { recursive: true });
  const temporary = `${target.trayPlistPath}.tmp.${process.pid}`;
  writeFileSync(temporary, plist(), { encoding: "utf8", mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, target.trayPlistPath);
}

function bootstrap() {
  run(["enable", service], { quiet: true });
  try {
    run(["bootstrap", domain, target.trayPlistPath], { quiet: true });
  } catch (error) {
    // Already bootstrapped is not a failure; anything else is.
    if (!loaded()) throw error;
  }
}

if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render"]).has(command)) {
  console.error("Usage: tray-service-macos.mjs install|uninstall|start|stop|restart|status|render");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(plist());
} else if (command === "status") {
  const description = loaded();
  const installed = existsSync(target.trayPlistPath);
  process.stdout.write(
    `${JSON.stringify({
      installed,
      loaded: Boolean(description) && installed,
      appPresent: existsSync(target.appBinary),
      state: description ? description.match(/state = ([^\n]+)/)?.[1]?.trim() || "loaded" : "stopped",
      path: target.trayPlistPath,
    })}\n`,
  );
} else if (command === "install") {
  if (!existsSync(target.appBinary)) {
    throw new Error(
      `The tray app is not built at ${target.appPath}. Run ./bin/model-router-tray first.`,
    );
  }
  bootout();
  writeAgent();
  bootstrap();
  process.stdout.write(`${JSON.stringify({ installed: true, path: target.trayPlistPath })}\n`);
} else if (command === "uninstall") {
  bootout();
  try {
    run(["disable", service], { quiet: true });
  } catch {
    // Best effort.
  }
  if (existsSync(target.trayPlistPath)) unlinkSync(target.trayPlistPath);
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  bootout();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else if (command === "start") {
  if (!existsSync(target.trayPlistPath)) {
    throw new Error(`The tray agent is not installed at ${target.trayPlistPath}.`);
  }
  if (!loaded()) bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
} else if (command === "restart") {
  if (loaded()) run(["kickstart", "-k", service], { quiet: true });
  else bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
