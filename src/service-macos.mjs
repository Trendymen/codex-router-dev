import { execFileSync } from "node:child_process";
import { rotateLog } from "./log-rotation.mjs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  CODEX_HOME,
  SERVICE_LABEL,
  TARGET,
  currentServiceTarget,
} from "./paths.mjs";
import { refuseUnsupportedPlatform } from "./platform-gate.mjs";
import { serviceProxyEnvironment } from "./proxy-environment.mjs";

const command = process.argv[2] || "status";
const renderOnly = command === "render";
if (!renderOnly && refuseUnsupportedPlatform(`service:${command}`)) process.exit(2);
const target = currentServiceTarget();
const userId = typeof process.getuid === "function" ? process.getuid() : 501;
const domain = target.launchDomain || `gui/${userId}`;
const service = target.routerService || `${domain}/${SERVICE_LABEL}`;
const launchctl = "/bin/launchctl";
const launchctlRetryWait = new Int32Array(new SharedArrayBuffer(4));
function absoluteNodeBinary(value) {
  const result = value || process.execPath;
  if (!path.isAbsolute(result)) {
    throw new Error("CODEX_ROUTER_NODE_BIN must be an absolute path.");
  }
  return result;
}
const nodeBinary = absoluteNodeBinary(process.env.CODEX_ROUTER_NODE_BIN);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderEnvironmentEntries({
  serviceTarget = target,
  nodePath = nodeBinary,
  environment = process.env,
} = {}) {
  const values = {
    PATH: environment.PATH || "/usr/local/bin:/usr/bin:/bin",
    MODEL_ROUTER_TARGET: TARGET,
    MODEL_ROUTER_STATE_DIR: serviceTarget.stateRoot,
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_OAUTH_PORT: String(serviceTarget.ports.oauth),
    MODEL_ROUTER_PORT: String(serviceTarget.ports.router),
    MODEL_ROUTER_API_PORT: String(serviceTarget.ports.api),
    MODEL_ROUTER_GROK_OAUTH_PORT: String(serviceTarget.ports.grokOauth),
    MODEL_ROUTER_DEVIN_CLI_PORT: String(serviceTarget.ports.devinCli),
    CODEX_HOME: environment.CODEX_HOME || CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: serviceTarget.stateRoot,
    KIMI_CODEX_STATE_DIR: serviceTarget.stateRoot,
    CODEX_ROUTER_QUIET: "1",
    KIMI_PROXY_QUIET: "1",
    CODEX_ROUTER_OAUTH_PORT: String(serviceTarget.ports.oauth),
    CODEX_ROUTER_PORT: String(serviceTarget.ports.router),
    CODEX_ROUTER_API_PORT: String(serviceTarget.ports.api),
    CODEX_ROUTER_GROK_OAUTH_PORT: String(serviceTarget.ports.grokOauth),
    CODEX_ROUTER_DEVIN_CLI_PORT: String(serviceTarget.ports.devinCli),
    ...serviceProxyEnvironment(environment),
    ...(environment.CODEX_ROUTER_SOURCE_ROOT
      ? { CODEX_ROUTER_SOURCE_ROOT: serviceTarget.sourceRoot }
      : {}),
    ...(environment.CODEX_ROUTER_NODE_BIN
      ? { CODEX_ROUTER_NODE_BIN: nodePath }
      : {}),
    ...(environment.CODEX_ROUTER_PACKAGE_MANAGER
      ? { CODEX_ROUTER_PACKAGE_MANAGER: environment.CODEX_ROUTER_PACKAGE_MANAGER }
      : {}),
  };
  if (environment.KIMI_CODE_HOME) values.KIMI_CODE_HOME = environment.KIMI_CODE_HOME;
  return Object.entries(values)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
}

export function renderLaunchAgent({
  serviceTarget = target,
  nodePath = nodeBinary,
  environment = process.env,
} = {}) {
  const absoluteNode = absoluteNodeBinary(nodePath);
  const start = path.join(serviceTarget.sourceRoot, "src", "start.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(serviceTarget.routerLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(absoluteNode)}</string>
    <string>${xml(start)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(serviceTarget.sourceRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${renderEnvironmentEntries({ serviceTarget, nodePath: absoluteNode, environment })}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Adaptive</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(serviceTarget.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(serviceTarget.logPath)}</string>
</dict>
</plist>
`;
}

function plist() {
  return renderLaunchAgent();
}

function run(args, options = {}) {
  return execFileSync(launchctl, args, {
    encoding: "utf8",
    timeout: 15_000,
    stdio: options.quiet
      ? ["ignore", "ignore", "ignore"]
      : ["ignore", "pipe", "pipe"],
  });
}

function loaded(targetService = service) {
  try {
    const description = run(["print", targetService]);
    return /(?:state|path|type) =/.test(description) ? description : undefined;
  } catch {
    return undefined;
  }
}

function bootout(targetService = service) {
  const description = loaded(targetService);
  if (!description) return;
  try {
    run(["bootout", targetService], { quiet: true });
  } catch (error) {
    if (loaded(targetService)) throw error;
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!loaded(targetService)) return;
    Atomics.wait(launchctlRetryWait, 0, 0, 100);
  }
  if (loaded(targetService)) {
    throw new Error(`Timed out waiting for ${targetService} to stop.`);
  }
}

function writePlist() {
  mkdirSync(path.dirname(target.routerPlistPath), { recursive: true });
  mkdirSync(target.stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(target.stateRoot, 0o700);
  const temporary = `${target.routerPlistPath}.tmp.${process.pid}`;
  // Proxy URLs may carry credentials, so the generated plist is private just
  // like the state it launches with.
  writeFileSync(temporary, plist(), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target.routerPlistPath);
}

function bootstrap() {
  if (!existsSync(target.routerPlistPath)) {
    throw new Error(`LaunchAgent is not installed at ${target.routerPlistPath}.`);
  }
  run(["enable", service], { quiet: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      run(["bootstrap", domain, target.routerPlistPath], { quiet: true });
      return;
    } catch (error) {
      const description = loaded();
      if (description && !/state = SIGTERM/.test(description)) return;
      if (error?.status !== 5 || attempt === 19) throw error;
      Atomics.wait(launchctlRetryWait, 0, 0, 100);
    }
  }
}

if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render"]).has(command)) {
  console.error("Usage: service-macos.mjs install|uninstall|start|stop|restart|status|render");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(plist());
} else if (command === "status") {
  const description = loaded();
  const installed = existsSync(target.routerPlistPath);
  const isLoaded = Boolean(description) && installed;
  const state = isLoaded
    ? description?.match(/state = ([^\n]+)/)?.[1]?.trim() || "loaded"
    : "stopped";
  process.stdout.write(
    `${JSON.stringify({
      installed,
      loaded: isLoaded,
      state,
    })}\n`,
  );
} else if (command === "install") {
  bootout();
  // Only safe here. launchd opens StandardOutPath before it execs the service,
  // so a rotation performed by the started process renames a file the process
  // already holds a descriptor on: it keeps appending to the renamed inode and
  // the log grows exactly as before, just under a different name. Between
  // bootout and bootstrap nothing holds it and the next start creates a fresh
  // file. Failures are ignored -- housekeeping must not block an install.
  rotateLog(target.logPath);
  writePlist();
  bootstrap();
  process.stdout.write(`${JSON.stringify({ installed: true, path: target.routerPlistPath })}\n`);
} else if (command === "uninstall") {
  bootout();
  try {
    run(["disable", service], { quiet: true });
  } catch {
    // Best effort.
  }
  if (existsSync(target.routerPlistPath)) unlinkSync(target.routerPlistPath);
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  bootout();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else if (command === "start") {
  if (!loaded()) bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
} else if (command === "restart") {
  if (loaded()) {
    run(["kickstart", "-k", service], { quiet: true });
  } else {
    bootstrap();
  }
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
