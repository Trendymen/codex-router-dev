#!/usr/bin/env node

// Live precedence probe for the Node provider-dispatch path. It compares one
// routed provider turn with one native Codex turn in an isolated router state;
// it never starts a second runtime or rewrites the user's configuration.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { findCodexBinary, spawnableCommand } from "../src/codex-binary.mjs";
import { MODEL_BY_SLUG, PROVIDERS } from "../src/model-registry.mjs";
import { resolveNodeModel } from "../src/model-contract.mjs";
import { STATE_DIR } from "../src/paths.mjs";

const SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(
    "Usage: node scripts/provider-precedence-probe.mjs --live --yes\n\n" +
      "Runs one routed Node-dispatch request and one native Codex request. Both flags are required because the probe consumes quota.\n",
  );
  process.exit(0);
}
if (!args.includes("--live") || !args.includes("--yes")) {
  console.error("The precedence probe consumes provider and ChatGPT quota; pass --live --yes to confirm.");
  process.exit(2);
}

const CODEX_BIN = findCodexBinary();
if (!CODEX_BIN) {
  console.error("The Codex binary was not found. Install Codex or set CODEX_BIN to its CLI binary.");
  process.exit(1);
}

const EXTERNAL_MODEL = process.env.CODEX_ROUTER_EXTERNAL_PROBE_MODEL || "deepseek/deepseek-v4-pro";
const NATIVE_MODEL = process.env.CODEX_ROUTER_NATIVE_PROBE_MODEL || "gpt-5.6-sol";
const external = MODEL_BY_SLUG.get(EXTERNAL_MODEL);
const provider = external && PROVIDERS.get(external.provider);
if (!external || !provider || external.effectiveTransport !== "openai-responses") {
  throw new Error(`The selected probe model is not an OpenAI Responses Node route: ${EXTERNAL_MODEL}`);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function copyStateFile(source, target) {
  if (!existsSync(source)) return false;
  try {
    symlinkSync(source, target);
  } catch {
    writeFileSync(target, readFileSync(source), { mode: 0o600 });
  }
  return true;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Router exited before ${url} was ready.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function runCodex(model, marker, baseUrl, codexHome) {
  return new Promise((resolve) => {
    const codexArgs = [
      "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
      "--sandbox", "read-only", "--color", "never", "--json", "--model", model,
      "--config", 'model_provider="codex-router-probe"',
      "--config", 'model_providers.codex-router-probe.name="Codex Router Node probe"',
      "--config", `model_providers.codex-router-probe.base_url=${JSON.stringify(baseUrl)}`,
      "--config", 'model_providers.codex-router-probe.wire_api="responses"',
      "--config", "model_providers.codex-router-probe.requires_openai_auth=true",
      "--config", "model_providers.codex-router-probe.supports_websockets=false",
      "--config", "disable_response_storage=true", "--cd", SOURCE_ROOT,
      `Reply with exactly ${marker}. Do not call tools.`,
    ];
    const target = spawnableCommand(CODEX_BIN, codexArgs);
    const child = spawn(target.command, target.args, {
      ...target.options,
      cwd: SOURCE_ROOT,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: codexHome, MODEL_ROUTER_TARGET: "codex" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let transcript = "";
    child.stdout.on("data", (chunk) => { transcript += String(chunk); });
    child.stderr.on("data", (chunk) => { transcript += String(chunk); });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 90_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, markerReturned: transcript.includes(marker), transcript });
    });
  });
}

const temporaryState = mkdtempSync(path.join(os.tmpdir(), "codex-router-precedence-node-"));
chmodSync(temporaryState, 0o700);
const codexHome = process.env.CODEX_HOME || os.homedir();
const callerKey = randomBytes(32).toString("base64url");
const internalKey = randomBytes(32).toString("base64url");
const routerPort = await reservePort();
const callerUrl = callerBaseUrl(routerPort, callerKey);
const credentialFile = provider.credential?.file;
if (!credentialFile || !copyStateFile(path.join(STATE_DIR, credentialFile), path.join(temporaryState, credentialFile))) {
  throw new Error(`The protected ${provider.id} credential is unavailable.`);
}
const route = resolveNodeModel(external, { enabled: true });
const fields = [
  "slug", "provider", "upstreamModel", "effectiveTransport", "toolDialect",
  "requestProfile", "reasoningDisplayMode", "declaredFinalReasoningShape",
  "effectiveFinalReasoningShape", "rolloutState", "purpose", "routable", "listed", "visible",
];
writeFileSync(path.join(temporaryState, "node-routes.json"), `${JSON.stringify({ version: 1, routes: [Object.fromEntries(fields.map((field) => [field, route[field]]))] }, null, 2)}\n`, { mode: 0o600 });
writeFileSync(path.join(temporaryState, "enabled-providers.json"), `${JSON.stringify({ version: 1, providers: [provider.id] })}\n`, { mode: 0o600 });

const router = spawn(process.execPath, [path.join(SOURCE_ROOT, "src", "router.mjs")], {
  cwd: SOURCE_ROOT,
  env: {
    ...process.env,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: temporaryState,
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_CALLER_KEY: callerKey,
    CODEX_ROUTER_INTERNAL_KEY: internalKey,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    MODEL_ROUTER_SHOW_ALL_MODELS: "1",
    CODEX_ROUTER_QUIET: "1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let diagnostics = "";
router.stderr.on("data", (chunk) => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-12_000); });

try {
  await waitFor(`${callerUrl}/models`, router);
  const externalResult = await runCodex(EXTERNAL_MODEL, `ROUTER_NODE_${Date.now()}`, callerUrl, codexHome);
  const nativeResult = await runCodex(NATIVE_MODEL, `ROUTER_NATIVE_${Date.now()}`, callerUrl, codexHome);
  process.stdout.write(`${JSON.stringify({ evidence: "Node provider-dispatch precedence", externalModel: EXTERNAL_MODEL, nativeModel: NATIVE_MODEL, external: externalResult, native: nativeResult, diagnostics }, null, 2)}\n`);
} finally {
  if (router.exitCode === null && router.signalCode === null) router.kill("SIGTERM");
  if (router.exitCode === null && router.signalCode === null) await new Promise((resolve) => router.once("exit", resolve));
  rmSync(temporaryState, { recursive: true, force: true });
}
