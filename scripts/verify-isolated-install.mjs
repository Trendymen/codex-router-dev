import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveServiceTarget, validatedIsolationRoot } from "../src/service-target.mjs";
import { redactSensitive } from "../src/sensitive-redactor.mjs";
import { uninstallRouterRuntimeTransaction } from "../src/local-uninstall.mjs";
import { ownedRuntimePaths, restoreOwnedRuntime, snapshotOwnedRuntime } from "../src/owned-runtime-paths.mjs";
import { privateFileIsProtected, writePrivateFile, writePrivateJson } from "../src/file-security.mjs";
import { recordAcceptanceEvidence } from "./verify-acceptance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "codex-router-phase5-isolated-install-v2";
const HARNESS_PATHS = Object.freeze(["scripts/verify-isolated-install.mjs", "scripts/verify-upgrade-preservation.mjs", "test/isolated-install-harness.test.mjs", "test/upgrade-harness.test.mjs"]);
const RUNTIMES = new WeakMap();
export function runtimeCallbacksFor(env) { return RUNTIMES.get(env)?.callbacks; }
const INTERNAL_KEY = "acceptance_router_internal_capability_000000";
const FORBIDDEN_LAUNCH_RUNTIME = new RegExp(["py" + "thon", "lite" + "llm", "ta" + "uri", "car" + "go"].join("|"), "i");
function isolatedPorts(nonce) { const base = 46_000 + ([...nonce].reduce((sum, char) => sum + char.codePointAt(0), 0) % 600) * 20; return { oauth: base + 1, router: base + 2, api: base + 3, grokOauth: base + 8, devinCli: base + 10 }; }
function rootNonce(root) { return `root-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`; }

function cliPath(value, name) { if (!value || value.startsWith("-")) throw new Error(`invalid ${name}`); if (path.isAbsolute(value)) return path.resolve(value); if (value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`invalid relative ${name}`); return path.resolve(process.cwd(), value); }
function option(args, name) { const index = args.indexOf(name); if (index < 0 || !args[index + 1] || args[index + 1].startsWith("-")) throw new Error(`missing ${name}`); return args[index + 1]; }
function under(root, value, name) { const resolved = path.resolve(value), relative = path.relative(root, resolved); if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${name} must remain below the isolated root`); return resolved; }
function json(file, value) { writePrivateJson(file, value, { directoryMode: 0o700 }); }
function writePrivateIfAbsent(file, contents) { if (!existsSync(file)) writePrivateFile(file, contents, { directoryMode: 0o700 }); }
function sameFileIdentity(left, right) { return left?.dev === right?.dev && left?.ino === right?.ino; }
/**
 * POSIX permissions are readable from the already-open descriptor. Windows
 * needs an ACL lookup by path, so bind that lookup to the descriptor identity
 * before and after it runs to reject a replace-between-check-and-read race.
 */
export function privateRegularFile(file, entry, { platform = process.platform, lstat = lstatSync, protectedFile = privateFileIsProtected } = {}) {
  const opened = entry || lstat(file, platform === "win32" ? { bigint: true } : undefined);
  if (!opened?.isFile?.() || opened.isSymbolicLink?.()) return false;
  if (platform !== "win32") return (opened.mode & 0o777) === 0o600;
  const before = lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || !sameFileIdentity(opened, before)) return false;
  if (!protectedFile(file)) return false;
  const after = lstat(file, { bigint: true });
  return after.isFile() && !after.isSymbolicLink() && sameFileIdentity(opened, after);
}

export function acceptanceCatalogFixture() {
  return { models: ["deepseek/deepseek-v4-flash", "qwen-plan/glm-5.2"].map((slug) => ({ slug, base_instructions: "", model_messages: { instructions_template: "" }, supports_parallel_tool_calls: false, provider: slug.split("/", 1)[0] })) };
}

export function writeAcceptanceCatalog(env) {
  assertIsolatedEnvironment(env);
  if (existsSync(env.acceptanceCatalogPath) && lstatSync(env.acceptanceCatalogPath).isSymbolicLink()) throw new Error("acceptance catalog cannot be a symlink or junction");
  json(env.acceptanceCatalogPath, acceptanceCatalogFixture());
  const entry = lstatSync(env.acceptanceCatalogPath, { bigint: process.platform === "win32" });
  if (!privateRegularFile(env.acceptanceCatalogPath, entry)) throw new Error("acceptance catalog must be a private regular file");
  return env.acceptanceCatalogPath;
}

/** Read the installer's capability through one no-follow descriptor. */
export function readInstalledCallerSecret(env, { validSecret = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{32,}$/.test(value) } = {}) {
  assertIsolatedEnvironment(env);
  const file = path.join(env.stateRoot, "caller-secret");
  let descriptor;
  try { descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { throw new Error("isolated installer did not create a caller capability"); }
  let contents;
  try {
    const entry = fstatSync(descriptor, { bigint: process.platform === "win32" });
    if (!entry.isFile()) throw new Error("isolated caller capability must be a regular file");
    if (!privateRegularFile(file, entry)) throw new Error("isolated caller capability must have private mode 0600");
    if (entry.size < 1 || entry.size > 4_096) throw new Error("isolated caller capability has an invalid size");
    contents = readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
  const match = /^([A-Za-z0-9_-]+)\n?$/.exec(contents);
  if (!match || !validSecret(match[1])) throw new Error("isolated installer caller capability is invalid");
  return match[1];
}

/** The post-installer boundary: no harness write runs before this returns. */
export function completeIsolatedInstaller(env, { runInstaller, validSecret } = {}) {
  if (typeof runInstaller !== "function") throw new Error("isolated installer callback is required");
  const result = runInstaller();
  if (result === undefined) throw new Error("materialized prepare-only installer did not run");
  return readInstalledCallerSecret(env, { validSecret });
}

export function guardIsolatedRuntimeCallback(isDisposed, callback) {
  return (...args) => {
    const pending = isDisposed()
      ? Promise.reject(new Error("isolated runtime is disposed"))
      : Promise.resolve().then(() => callback(...args));
    pending.catch(() => {});
    return pending;
  };
}

function gitText(args, { encoding = "utf8" } = {}) { return execFileSync("git", args, { cwd: ROOT, encoding }); }
/** Proves that a post-push CLI is executing the same four checked-in harness bytes. */
export function assertPushedHarness(sourceCommit, { git = gitText, remoteProbe } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sourceCommit || ""))) throw new Error("source commit must be a full Git commit");
  const probe = remoteProbe || ((commit) => git(["ls-remote", "github", "refs/heads/main"]));
  const remote = String(probe(sourceCommit)).trim().split(/\s+/)[0];
  if (remote !== sourceCommit) throw new Error("source commit is not github/main");
  for (const file of HARNESS_PATHS) {
    if (String(git(["status", "--porcelain", "--", file])).trim()) throw new Error(`harness path is dirty or untracked: ${file}`);
    const committed = Buffer.from(git(["show", `${sourceCommit}:${file}`], { encoding: "buffer" }));
    if (!existsSync(path.join(ROOT, file)) || !committed.equals(readFileSync(path.join(ROOT, file)))) throw new Error(`harness bytes differ from source commit: ${file}`);
  }
  return true;
}

/** No CLI root, lock, or launch operation is allowed before this gate succeeds. */
export function assertCliPreflight(root, { platform = process.platform, git = gitText } = {}) {
  if (platform !== "darwin") throw new Error("Task 2 isolated acceptance is macOS-only");
  const generated = path.join(ROOT, "generated"), acceptance = path.join(generated, "acceptance"); const resolved = path.resolve(root); const relative = path.relative(acceptance, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("isolated root must be below generated/acceptance");
  const canonicalRepo = realpathSync(ROOT);
  const assertCanonicalWithinRepo = (value, name) => {
    if (lstatSync(value).isSymbolicLink()) throw new Error(`${name} cannot cross a symlink or junction`);
    const canonical = realpathSync(value), nested = path.relative(canonicalRepo, canonical);
    if (nested === ".." || nested.startsWith(`..${path.sep}`) || path.isAbsolute(nested)) throw new Error(`${name} resolves outside the repository`);
    return canonical;
  };
  // Inspect the repository boundary as well as every extant child.  Checking
  // only descendants lets a symlinked generated/acceptance directory escape
  // before the requested root itself exists.
  assertCanonicalWithinRepo(ROOT, "repository root");
  assertCanonicalWithinRepo(generated, "generated directory");
  const canonicalAcceptance = assertCanonicalWithinRepo(acceptance, "acceptance directory");
  let cursor = acceptance;
  for (const part of relative.split(path.sep)) { cursor = path.join(cursor, part); if (!existsSync(cursor)) continue; const canonical = assertCanonicalWithinRepo(cursor, "isolated root"); const nested = path.relative(canonicalAcceptance, canonical); if (nested === ".." || nested.startsWith(`..${path.sep}`) || path.isAbsolute(nested)) throw new Error("isolated root resolves outside generated/acceptance"); }
  let ancestor = resolved; while (!existsSync(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  if (existsSync(ancestor) && (lstatSync(ancestor).isSymbolicLink() || path.relative(canonicalAcceptance, realpathSync(ancestor)).startsWith(".."))) throw new Error("isolated root ancestor is unsafe");
  try { git(["check-ignore", "-q", "--no-index", path.relative(ROOT, resolved)]); } catch { throw new Error("isolated root must be gitignored"); }
  return resolved;
}

export function planIsolatedTarget(root, nonce) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return resolveServiceTarget({ mode: "acceptance", platform: "darwin", isolationRoot: root, sourceRoot: path.join(root, "checkout"), routerLabel: `io.github.codex-router.acceptance-${nonce}`, trayLabel: `io.github.codex-router.acceptance-${nonce}.tray`, launchDomain: `gui/${uid}`, ports: isolatedPorts(nonce) });
}

export function isolationLeasePath(ports) {
  const normalizedPorts = [...new Set(Object.values(ports || {}).map(Number))].sort((left, right) => left - right);
  if (!normalizedPorts.length || normalizedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) throw new Error("isolated acceptance lease requires valid ports");
  const normalized = normalizedPorts.join(","), bucket = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return { normalized, lock: path.join(ROOT, "generated", "acceptance", `.task2-ports-${bucket}.lock`) };
}

export function acquireIsolationLease(root, ports) {
  const { normalized, lock } = isolationLeasePath(ports); mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("hex"); let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ token, pid: process.pid, root: path.resolve(root), ports: normalized }), { encoding: "utf8" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("isolated acceptance port bucket is already leased");
    throw error;
  }
  const lockStat = fstatSync(fd);
  return () => {
    try {
      const current = JSON.parse(readFileSync(lock, "utf8"));
      const currentStat = lstatSync(lock);
      if (current?.token !== token || current?.pid !== process.pid || current?.ports !== normalized || currentStat.dev !== lockStat.dev || currentStat.ino !== lockStat.ino) {
        throw new Error("refusing to release an isolated acceptance lease owned by another process");
      }
      unlinkSync(lock);
    } finally {
      closeSync(fd);
    }
  };
}

/** Pure planning gate: validates every collision before the root or any child exists. */
export function planIsolatedEnvironment(seed = {}) {
  const root = cliPath(seed.root, "--root");
  const nonce = String(seed.nonce || "phase5").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  if (!nonce || nonce === "production") throw new Error("invalid isolated environment nonce");
  const uid = Number.isInteger(seed.uid) ? seed.uid : (typeof process.getuid === "function" ? process.getuid() : 501);
  const sourceName = typeof seed.sourceName === "string" && /^[a-z0-9-]+$/i.test(seed.sourceName) ? seed.sourceName : "checkout";
  const sourceRoot = under(root, path.join(root, sourceName), "materialized sourceRoot");
  const target = resolveServiceTarget({ mode: "acceptance", platform: seed.platform || process.platform, isolationRoot: root, sourceRoot, routerLabel: `io.github.codex-router.acceptance-${nonce}`, trayLabel: `io.github.codex-router.acceptance-${nonce}.tray`, launchDomain: `gui/${uid}`, ports: { ...isolatedPorts(nonce), ...(seed.ports || {}) } });
  return { root, nonce, sourceName, sourceRoot, target };
}

function copyCurrentSwiftBundle(env, sourceCommit) {
  const manifestPath = path.join(ROOT, "generated", "acceptance", "task1-build", "acceptance-build.json");
  if (!existsSync(manifestPath)) throw new Error("Task 1 built Swift artifact manifest is required before Task 2");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.sourceCommit !== sourceCommit || manifest?.buildOnly !== true || typeof manifest?.bundlePath !== "string" || !path.isAbsolute(manifest.bundlePath) || !existsSync(manifest.bundlePath)) throw new Error("Task 1 Swift artifact is not bound to this source commit");
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify-node-only-build.mjs"), manifest.buildRoot], { cwd: ROOT, encoding: "utf8" });
  cpSync(manifest.bundlePath, env.target.appPath, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true });
}

export function createIsolatedEnvironment(seed = {}, hooks = {}) {
  const planned = planIsolatedEnvironment(seed); mkdirSync(planned.root, { recursive: true, mode: 0o700 }); const root = realpathSync(planned.root);
  // The canonical root can differ through a system alias (for example /var on
  // macOS), so rebuild the target only after all pre-write validation passed.
  const { nonce, sourceName } = planned;
  const sourceRoot = under(root, path.join(root, sourceName), "materialized sourceRoot");
  const target = resolveServiceTarget({ mode: "acceptance", platform: seed.platform || process.platform, isolationRoot: root, sourceRoot, routerLabel: `io.github.codex-router.acceptance-${nonce}`, trayLabel: `io.github.codex-router.acceptance-${nonce}.tray`, launchDomain: planned.target.launchDomain, ports: planned.target.ports });
  const env = Object.freeze({ owner: OWNER, root, sourceRoot, sourceCommit: seed.sourceCommit, target, codexHome: under(root, path.join(root, "codex-home"), "CODEX_HOME"), stateRoot: target.stateRoot, supportRoot: target.supportRoot, launchAgentsDir: target.launchAgentsDir, browserProfile: under(root, path.join(root, "browser-profile"), "browser profile"), credentialsPath: under(root, path.join(target.stateRoot, "acceptance-credentials.json"), "credential placeholder"), acceptanceCatalogPath: under(root, path.join(target.stateRoot, "acceptance-catalog.json"), "acceptance catalog"), logPath: target.logPath, evidenceRoot: under(root, path.join(root, "evidence"), "evidence"), mkdir(value) { const targetPath = under(root, value, "write path"); mkdirSync(targetPath, { recursive: true, mode: 0o700 }); return targetPath; }, write(relative, contents, mode = 0o600) { const targetPath = under(root, path.join(root, relative), "write path"); mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 }); writeFileSync(targetPath, contents, { mode }); return targetPath; } });
  assertIsolatedEnvironment(env); if (typeof hooks.beforeWrite === "function") hooks.beforeWrite(env); return env;
}

export function assertIsolatedEnvironment(env) {
  if (!env || env.owner !== OWNER || !env.target || validatedIsolationRoot(env.target) !== env.root) throw new Error("invalid isolated environment");
  for (const [name, value] of Object.entries({ sourceRoot: env.sourceRoot, codexHome: env.codexHome, stateRoot: env.stateRoot, supportRoot: env.supportRoot, launchAgentsDir: env.launchAgentsDir, browserProfile: env.browserProfile, credentialsPath: env.credentialsPath, acceptanceCatalogPath: env.acceptanceCatalogPath, logPath: env.logPath, evidenceRoot: env.evidenceRoot, routerPlistPath: env.target.routerPlistPath, trayPlistPath: env.target.trayPlistPath, appPath: env.target.appPath })) under(env.root, value, name);
  if ([env.target.routerLabel, env.target.trayLabel].includes("io.github.codex-router") || [env.target.routerLabel, env.target.trayLabel].includes("io.github.codex-router.tray")) throw new Error("isolated environment collides with production labels");
  if (Object.values(env.target.ports).some((port) => [4201, 4202, 4203, 4208, 4210].includes(port))) throw new Error("isolated environment collides with production ports");
  return env;
}

export function runtimeEnv(env) {
  return { ...process.env, MODEL_ROUTER_SERVICE_MODE: "acceptance", MODEL_ROUTER_ISOLATION_ROOT: env.root, MODEL_ROUTER_SOURCE_ROOT: env.sourceRoot, MODEL_ROUTER_STATE_DIR: env.stateRoot, MODEL_ROUTER_LOG_PATH: env.logPath, MODEL_ROUTER_LAUNCH_AGENTS_DIR: env.launchAgentsDir, MODEL_ROUTER_LAUNCH_AGENT_PATH: env.target.routerPlistPath, MODEL_ROUTER_TRAY_LAUNCH_AGENT_PATH: env.target.trayPlistPath, MODEL_ROUTER_TRAY_APP_PATH: env.target.appPath, MODEL_ROUTER_TRAY_APP_BINARY: env.target.appBinary, MODEL_ROUTER_SERVICE_LABEL: env.target.routerLabel, MODEL_ROUTER_TRAY_SERVICE_LABEL: env.target.trayLabel, MODEL_ROUTER_LAUNCH_DOMAIN: env.target.launchDomain, CODEX_HOME: env.codexHome, MODEL_ROUTER_OAUTH_PORT: String(env.target.ports.oauth), MODEL_ROUTER_PORT: String(env.target.ports.router), MODEL_ROUTER_API_PORT: String(env.target.ports.api), MODEL_ROUTER_GROK_OAUTH_PORT: String(env.target.ports.grokOauth), MODEL_ROUTER_DEVIN_CLI_PORT: String(env.target.ports.devinCli), CODEX_ROUTER_CATALOG: env.acceptanceCatalogPath, CODEX_ROUTER_TEST_NODE_ROUTE_FIXTURE: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1" };
}

export async function assertPortsAvailable(ports) { for (const port of Object.values(ports)) { const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); }); await new Promise((resolve) => probe.close(resolve)); } }
async function portsFreeEventually(ports) { const deadline = Date.now() + 5_000; let last; while (Date.now() < deadline) { try { await assertPortsAvailable(ports); return; } catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 50)); } } throw last || new Error("isolated ports did not become available"); }
async function close(server) { if (server?.listening) await new Promise((resolve) => server.close(resolve)); }
export function ownedProcessAlive(state, child) { return Boolean(state && state.child === child && state.alive === true && child?.exitCode === null && child?.signalCode === null); }
async function ready(url, state, logPath) { const reason = () => existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-4_000) : "no router stderr captured"; const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if (!ownedProcessAlive(state, state?.child)) throw new Error(`isolated router exited before readiness: ${reason()}`); try { const response = await fetch(url); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`isolated router did not become ready: ${reason()}`); }
async function materialize(env, commit, { allowReleased = false } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(commit || ""))) throw new Error("source commit must be a full Git commit");
  if (!allowReleased && (execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() !== commit || execFileSync("git", ["rev-parse", "github/main"], { cwd: ROOT, encoding: "utf8" }).trim() !== commit)) throw new Error("isolated runtime must materialize the current pushed source commit");
  execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: ROOT, stdio: "ignore" });
  if (existsSync(env.sourceRoot)) throw new Error("isolated checkout already exists; use a fresh acceptance root");
  mkdirSync(env.sourceRoot, { recursive: true, mode: 0o700 }); const archive = execFileSync("git", ["archive", "--format=tar", commit], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }); const tar = spawn(process.platform === "win32" ? "tar.exe" : "tar", ["-x", "-C", env.sourceRoot], { stdio: ["pipe", "ignore", "pipe"] }); tar.stdin.end(archive);
  await new Promise((resolve, reject) => { let stderr = ""; tar.stderr.on("data", (chunk) => { stderr += chunk; }); tar.once("error", reject); tar.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`cannot materialize source (${code}): ${stderr}`))); });
}
function providerSse() { const item = { id: "msg_acceptance", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture" }] }; const events = [{ type: "response.created", response: { id: "resp_acceptance", model: "fixture" } }, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }, { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "" } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "fixture" }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "resp_acceptance", model: "fixture", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]; return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`; }
export function validDownstreamResponsesLifecycle(stream) {
  const records = [];
  for (const record of String(stream).split(/\r?\n\r?\n/)) {
    if (!record.trim()) continue;
    const eventTypes = [], data = [];
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventTypes.push(line.slice("event:".length).trim());
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
    }
    const joinedData = data.join("\n").trim();
    if (joinedData === "[DONE]") continue;
    let dataType;
    if (joinedData) {
      let parsed;
      try { parsed = JSON.parse(joinedData); } catch { return false; }
      if (typeof parsed?.type === "string") dataType = parsed.type;
    }
    const types = [...new Set([...eventTypes, dataType].filter(Boolean))];
    if (types.length) records.push(types);
  }
  const flattened = records.flat();
  if (flattened.some((type) => type.startsWith("message_"))) return false;
  const created = flattened.reduce((indexes, type, index) => type === "response.created" ? [...indexes, index] : indexes, []);
  const completed = flattened.reduce((indexes, type, index) => type === "response.completed" ? [...indexes, index] : indexes, []);
  return created.length === 1 && completed.length === 1 && created[0] < completed[0];
}
function providerMessagesSse() { const events = [{ type: "message_start", message: { id: "msg_acceptance", type: "message", role: "assistant", model: "glm-5.2", stop_reason: null, content: [], usage: { input_tokens: 1, output_tokens: 0 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fixture" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }]; return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""); }
export async function createLocalProviderFixture({ registerServer } = {}) {
  const attempts = [];
  const safeModel = (value) => typeof value === "string" && /^[A-Za-z0-9._/-]{1,128}$/.test(value) ? value : null;
  const meaningfulUserText = (messages) => messages.some((message) => {
    if (!message || message.role !== "user") return false;
    if (typeof message.content === "string") return message.content.trim().length > 0;
    return Array.isArray(message.content) && message.content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
  });
  const server = http.createServer(async (request, response) => {
    const attempt = { path: request.url || "", method: request.method || "", model: null, accepted: false, reason: "unvalidated" }; attempts.push(attempt);
    const reject = (status, reason) => { attempt.reason = reason; response.writeHead(status).end(); };
    if (!["/v1/responses", "/v1/messages"].includes(attempt.path) || attempt.method !== "POST") { reject(404, "wrong_path_or_method"); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reject(422, "invalid_json"); return; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) { reject(422, "invalid_request"); return; }
    attempt.model = safeModel(payload.model);
    if (request.url === "/v1/messages") {
      if (payload.model !== "glm-5.2" || payload.stream !== true || !Number.isInteger(payload.max_tokens) || payload.max_tokens < 1 || !Array.isArray(payload.messages) || payload.messages.length === 0 || !meaningfulUserText(payload.messages) || Object.hasOwn(payload, "input")) { reject(422, "invalid_messages_dialect"); return; }
      attempt.accepted = true; attempt.reason = "accepted"; attempt.transport = "messages";
      const reply = providerMessagesSse(); response.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(reply) }); response.end(reply); return;
    }
    const validInput = (typeof payload.input === "string" && payload.input.length > 0) || (Array.isArray(payload.input) && payload.input.length > 0);
    if (payload.model !== "deepseek-v4-flash" || payload.stream !== true || !validInput || Object.hasOwn(payload, "messages")) { reject(422, "invalid_responses_dialect"); return; }
    attempt.accepted = true; attempt.reason = "accepted"; attempt.transport = "responses";
    const reply = providerSse(); response.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(reply) }); response.end(reply);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  registerServer?.(server);
  return { server, attempts, get requests() { return attempts.filter((attempt) => attempt.accepted); }, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const FIXTURE_OBSERVATION_FIELDS = new Set(["path", "method", "model", "accepted", "reason", "transport"]);
const FIXTURE_PATHS = new Set(["/v1/responses", "/v1/messages"]);
const FIXTURE_MODELS = new Set([null, "deepseek-v4-flash", "glm-5.2"]);
const FIXTURE_REASONS = new Set(["unvalidated", "wrong_path_or_method", "invalid_json", "invalid_request", "invalid_messages_dialect", "invalid_responses_dialect", "accepted"]);
function fixtureServerAddress(server) {
  if (!(server instanceof net.Server) || server.listening !== true) throw new Error("acceptance provider fixture requires an owned Node listening server");
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port < 1 || address.port > 65_535 || !["127.0.0.1", "::1"].includes(address.address)) throw new Error("acceptance provider fixture server must be loopback-owned");
  return address;
}
function validFixtureObservation(value, { request = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getOwnPropertySymbols(value).length || Object.keys(value).some((key) => !FIXTURE_OBSERVATION_FIELDS.has(key)) || !["path", "method", "model", "accepted", "reason"].every((key) => Object.hasOwn(value, key))) return false;
  if (!FIXTURE_PATHS.has(value.path) || value.method !== "POST" || !FIXTURE_MODELS.has(value.model) || typeof value.accepted !== "boolean" || !FIXTURE_REASONS.has(value.reason)) return false;
  if (value.transport !== undefined && !["responses", "messages"].includes(value.transport)) return false;
  const acceptedRoute = (value.path === "/v1/responses" && value.model === "deepseek-v4-flash" && value.transport === "responses") || (value.path === "/v1/messages" && value.model === "glm-5.2" && value.transport === "messages");
  return (!value.accepted || acceptedRoute) && (!request || value.accepted === true && acceptedRoute);
}
/** Validates the narrow, non-secret observation surface available to Task 3 fixtures. */
export function validateAcceptanceProviderFixture(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) throw new Error("acceptance provider fixture must be an object");
  const allowed = new Set(["server", "baseUrl", "attempts", "requests"]);
  if (Object.getOwnPropertySymbols(fixture).length || Object.keys(fixture).some((key) => !allowed.has(key)) || ![...allowed].every((key) => Object.hasOwn(fixture, key))) throw new Error("acceptance provider fixture has a closed schema");
  const address = fixtureServerAddress(fixture.server);
  let base;
  try { base = new URL(fixture.baseUrl); } catch { throw new Error("acceptance provider fixture requires a loopback baseUrl"); }
  const hostname = address.address === "::1" ? "[::1]" : address.address;
  if (base.protocol !== "http:" || base.hostname !== hostname || Number(base.port) !== address.port || base.pathname !== "/v1" || base.search || base.hash || base.username || base.password) throw new Error("acceptance provider fixture baseUrl must name its owned loopback server");
  if (!Array.isArray(fixture.attempts) || !Array.isArray(fixture.requests) || !fixture.attempts.every((value) => validFixtureObservation(value)) || !fixture.requests.every((value) => validFixtureObservation(value, { request: true })) || !fixture.requests.every((value) => fixture.attempts.includes(value))) throw new Error("acceptance provider fixture observations must use the closed safe schema");
  return fixture;
}

/** Real, local-only production composition for the public non-dry CLI. */
export async function createLocalRuntime(env, { sourceCommit, allowReleased = false, requireSwift = true, installerRunner, providerFixtureFactory = createLocalProviderFixture } = {}) {
  assertIsolatedEnvironment(env); if (env.target.mode !== "acceptance" || typeof providerFixtureFactory !== "function") throw new Error("provider fixture injection is acceptance-only and requires a factory"); await materialize(env, sourceCommit, { allowReleased });
  const update = await import(pathToFileURL(path.join(env.sourceRoot, "src", "update.mjs")).href); const caller = await import(pathToFileURL(path.join(env.sourceRoot, "src", "caller-auth.mjs")).href);
  let fixture; let fixturePromise; let router; let processState; let callerKey; let disposed = false; let disposePromise; let serialTail = Promise.resolve(); const fixtureAbort = new AbortController(), pids = [], fixtureServers = new Set();
  const serialized = (work) => { let release; const previous = serialTail; serialTail = new Promise((resolve) => { release = resolve; }); return previous.catch(() => {}).then(work).finally(release); };
  const registerFixtureServer = (server) => { fixtureServerAddress(server); if (disposed || fixtureAbort.signal.aborted) { Promise.resolve(close(server)).catch(() => {}); throw new Error("isolated provider fixture registration is disposed or aborted"); } fixtureServers.add(server); return server; };
  const closeFixtureServers = async () => { const failures = []; for (const server of fixtureServers) { try { await close(server); } catch (error) { failures.push(error); } } fixtureServers.clear(); if (failures.length) throw new AggregateError(failures, "isolated provider fixture cleanup failed"); };
  const createFixture = async () => {
    if (fixture) return fixture;
    if (fixturePromise) return fixturePromise;
    const pending = (async () => { try {
      const candidate = await providerFixtureFactory({ registerServer: registerFixtureServer, signal: fixtureAbort.signal });
      if (!fixtureServers.has(candidate?.server)) { if (candidate?.server instanceof net.Server) await close(candidate.server); throw new Error("acceptance provider fixture factory must register its owned server"); }
      if (disposed) throw new Error("isolated runtime is disposed");
      fixture = validateAcceptanceProviderFixture(candidate);
      return fixture;
    } catch (error) {
      try { await closeFixtureServers(); } catch (cleanup) { throw new AggregateError([error, cleanup], "isolated provider fixture setup and cleanup failed"); }
      throw error;
    } })();
    fixturePromise = pending;
    try { return await pending; } finally { if (fixturePromise === pending && !fixture) fixturePromise = undefined; }
  };
  const installedCallerKey = () => { if (!callerKey) throw new Error("isolated caller capability is unavailable before installer completion"); return callerKey; };
  const prepare = () => { mkdirSync(env.codexHome, { recursive: true, mode: 0o700 }); mkdirSync(env.stateRoot, { recursive: true, mode: 0o700 }); writePrivateIfAbsent(env.credentialsPath, "acceptance placeholder only\n"); writeAcceptanceCatalog(env); if (requireSwift) copyCurrentSwiftBundle(env, sourceCommit); const plist = execFileSync(process.execPath, [path.join(env.sourceRoot, "src", "service-macos.mjs"), "render"], { cwd: env.sourceRoot, env: runtimeEnv(env), encoding: "utf8" }); if (!plist.includes(env.target.routerLabel) || !plist.includes(path.join(env.sourceRoot, "src", "start.mjs"))) throw new Error("isolated launch agent does not use materialized Node source"); mkdirSync(env.launchAgentsDir, { recursive: true, mode: 0o700 }); writeFileSync(env.target.routerPlistPath, plist, { mode: 0o600 }); chmodSync(env.target.routerPlistPath, 0o600); writePrivateIfAbsent(path.join(env.stateRoot, "unowned-preserved.txt"), "preserve\n"); };
  const stopLocked = async () => { if (ownedProcessAlive(processState, router)) { try { process.kill(-router.pid, "SIGTERM"); } catch { if (ownedProcessAlive(processState, router)) router.kill("SIGTERM"); } const exited = processState.exitPromise; const grace = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]); if (!grace && ownedProcessAlive(processState, router)) { try { process.kill(-router.pid, "SIGKILL"); } catch { if (ownedProcessAlive(processState, router)) router.kill("SIGKILL"); } await exited; } } router = undefined; };
  const startLocked = async () => { if (disposed) throw new Error("isolated runtime is disposed"); if (ownedProcessAlive(processState, router)) return { pid: router.pid, label: env.target.routerLabel, process: processState }; await portsFreeEventually(env.target.ports); if (disposed) throw new Error("isolated runtime is disposed"); await createFixture(); if (disposed) throw new Error("isolated runtime is disposed");
    router = spawn(process.execPath, [path.join(env.sourceRoot, "src", "start.mjs")], { cwd: env.sourceRoot, env: { ...runtimeEnv(env), DEEPSEEK_API_BASE_URL: fixture.baseUrl, DEEPSEEK_API_KEY: INTERNAL_KEY, QWEN_PLAN_BASE_URL: fixture.baseUrl, QWEN_PLAN_API_KEY: INTERNAL_KEY }, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] }); processState = { child: router, pid: router.pid, alive: true, exitCode: null, signalCode: null, exitPromise: new Promise((resolve) => router.once("exit", (exitCode, signalCode) => { processState.alive = false; processState.exitCode = exitCode; processState.signalCode = signalCode; resolve(processState); })) }; router.stderr.on("data", (chunk) => writeFileSync(env.logPath, chunk, { flag: "a", mode: 0o600 })); pids.push(router.pid); await ready(`http://${env.target.host}:${env.target.ports.router}/health`, processState, env.logPath); return { pid: router.pid, label: env.target.routerLabel, process: processState }; };
  const stop = () => serialized(stopLocked);
  const start = () => { const pending = disposed ? Promise.reject(new Error("isolated runtime is disposed")) : serialized(startLocked); pending.catch(() => {}); return pending; };
  const base = () => caller.callerBaseUrl(env.target.ports.router, installedCallerKey());
  const dispose = () => { if (disposePromise) return disposePromise; disposed = true; fixtureAbort.abort(); disposePromise = (async () => { const failures = []; const settled = await Promise.allSettled([stopLocked(), closeFixtureServers()]); for (const result of settled) if (result.status === "rejected") failures.push(result.reason); callerKey = undefined; json(path.join(env.evidenceRoot, `owned-processes-${path.basename(env.sourceRoot)}.json`), { owner: OWNER, runtimeId: path.basename(env.sourceRoot), pids, process: processState && { pid: processState.pid, exitCode: processState.exitCode, signalCode: processState.signalCode } }); if (failures.length) throw new AggregateError(failures, "isolated runtime cleanup failed"); })(); disposePromise.catch(() => {}); return disposePromise; };
  const runInstaller = () => installerRunner
    ? installerRunner(env)
    : execFileSync(path.join(env.sourceRoot, "bin", "install"), ["--prepare-only"], { cwd: env.sourceRoot, env: runtimeEnv(env), encoding: "utf8" });
  const runtime = { prepare, stop, start, dispose, callbacks: {
    prerequisites: async () => { const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19) || !execFileSync("git", ["--version"], { encoding: "utf8" }).trim() || !execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()) throw new Error("installer prerequisite failed"); }, install: async () => { callerKey = completeIsolatedInstaller(env, { runInstaller, validSecret: caller.validCallerSecret }); prepare(); }, inspectLaunchArgs: async () => { const plist = readFileSync(env.target.routerPlistPath, "utf8"), block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1], args = [...String(block || "").matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]); if (JSON.stringify(args) !== JSON.stringify([process.execPath, path.join(env.sourceRoot, "src", "start.mjs")])) throw new Error("isolated ProgramArguments are not the exact Node start command"); for (const [file, mode] of [[env.target.routerPlistPath, 0o600], [env.credentialsPath, 0o600], [env.acceptanceCatalogPath, 0o600], [env.stateRoot, 0o700], [env.target.appBinary, 0o755]]) { const protectedFile = mode === 0o600; if (protectedFile ? !privateRegularFile(file) : (statSync(file).mode & 0o777) !== mode) throw new Error(`isolated mode mismatch: ${file}`); } return args; }, start,
    authenticate: async () => { const denied = await fetch(`http://${env.target.host}:${env.target.ports.router}/_codex-router/not-a-valid-caller-key/v1/models`); if (denied.status !== 401) throw new Error("isolated caller endpoint did not reject invalid capability"); const ok = await fetch(`${base()}/models`, { headers: { authorization: `Bearer ${installedCallerKey()}` } }); if (!ok.ok) throw new Error("isolated caller endpoint rejected owned capability"); }, health: async () => { const response = await fetch(`http://${env.target.host}:${env.target.ports.router}/health`); const value = await response.json(); return { ok: response.ok && value?.service === "codex-router" }; },
    route: async (_env, transport) => { validateAcceptanceProviderFixture(fixture); const model = transport === "messages" ? "qwen-plan/glm-5.2" : "deepseek/deepseek-v4-flash", expectedPath = transport === "messages" ? "/v1/messages" : "/v1/responses", expectedModel = transport === "messages" ? "glm-5.2" : "deepseek-v4-flash", beforeAttempts = fixture?.attempts.length || 0, beforeAccepted = fixture?.requests.length || 0; const response = await fetch(`${base()}/responses`, { method: "POST", headers: { authorization: `Bearer ${installedCallerKey()}`, "content-type": "application/json" }, body: JSON.stringify({ model, input: "isolated fixture", stream: true }) }); const text = await response.text(), afterAttempts = fixture?.attempts.length || 0, afterAccepted = fixture?.requests.length || 0, last = fixture?.attempts.at(-1); validateAcceptanceProviderFixture(fixture); if (!response.ok || !validDownstreamResponsesLifecycle(text) || afterAttempts !== beforeAttempts + 1 || afterAccepted !== beforeAccepted + 1 || last?.path !== expectedPath || last?.model !== expectedModel || last?.transport !== transport || last?.accepted !== true) throw new Error(`isolated ${transport} fixture route failed`); return { transport, catalog: true }; },
    catalog: async () => { const response = await fetch(`${base()}/models`, { headers: { authorization: `Bearer ${installedCallerKey()}` } }); const value = await response.json(); const expected = ["deepseek/deepseek-v4-flash", "qwen-plan/glm-5.2"], ids = Array.isArray(value?.data) ? value.data.map((model) => model?.id).sort() : []; return { published: response.ok && JSON.stringify(ids) === JSON.stringify(expected.sort()) }; }, browser: async () => update.verifyBrowserCapabilityContract(env.target, { callerKey: installedCallerKey() }), swift: async () => update.verifySwiftCommandContract(env.target), lifecycle: async (_env, action) => { if (action === "stop") return stop(); if (action === "start") return start(); if (action === "restart") return serialized(async () => { await stopLocked(); return startLocked(); }); throw new Error(`unsupported lifecycle ${action}`); }, uninstall: async () => { const runtimeRoots = { userHome: env.root, codexHome: env.codexHome, dshHome: path.join(env.root, "dsh"), geminiHome: path.join(env.root, "gemini") }, paths = ownedRuntimePaths(env.target, runtimeRoots), unowned = readFileSync(path.join(env.stateRoot, "unowned-preserved.txt")); let before; await uninstallRouterRuntimeTransaction({ target: env.target, runtimeRoots, snapshot: async () => { before = snapshotOwnedRuntime(paths); return before; }, ownedPaths: ["router-plist", "tray-app"], installReplacement: stop, verifyReplacement: async () => {}, restoreSnapshot: async (saved) => restoreOwnedRuntime(saved), restartOldService: start }); if (!before || !Buffer.from(unowned).equals(readFileSync(path.join(env.stateRoot, "unowned-preserved.txt")))) throw new Error("isolated uninstall modified unowned content"); },
  } };
  for (const [name, callback] of Object.entries(runtime.callbacks)) runtime.callbacks[name] = guardIsolatedRuntimeCallback(() => disposed, callback);
  RUNTIMES.set(env, runtime); return runtime;
}

export async function verifyCleanInstall(env, callbacks = RUNTIMES.get(env)?.callbacks) {
  assertIsolatedEnvironment(env); const activeCallbacks = callbacks || RUNTIMES.get(env)?.callbacks; const steps = [["prerequisites", [env]], ["install", [env]], ["inspectLaunchArgs", [env]], ["start", [env]], ["authenticate", [env]], ["health", [env]], ["route", [env, "responses"]], ["route", [env, "messages"]], ["catalog", [env]], ["browser", [env]], ["swift", [env]], ["lifecycle", [env, "stop"]], ["lifecycle", [env, "start"]], ["lifecycle", [env, "restart"]], ["uninstall", [env]]]; const result = {};
  for (const [name, args] of steps) { if (typeof activeCallbacks?.[name] !== "function") throw new Error(`isolated install requires runtime ${name} callback`); const value = await activeCallbacks[name](...args); if (name === "inspectLaunchArgs" && (!Array.isArray(value) || !value.some((arg) => /src[\\/]start\.mjs$/.test(String(arg))) || value.some((arg) => FORBIDDEN_LAUNCH_RUNTIME.test(String(arg))))) throw new Error("isolated launch arguments are not Node-only"); if (name === "health" && value?.ok !== true) throw new Error("isolated Router health is not OK"); if (name === "route" && value?.catalog !== true) throw new Error(`isolated ${args[1]} route did not use fixture catalog`); if (name === "catalog" && value?.published !== true) throw new Error("isolated catalog was not published"); result[`${name}:${args[1] || ""}`] = value; }
  const report = { schemaVersion: 2, owner: OWNER, status: "passed", sourceCommit: env.sourceCommit, target: { labels: [env.target.routerLabel, env.target.trayLabel], ports: env.target.ports }, catalog: { path: path.relative(env.root, env.acceptanceCatalogPath), count: acceptanceCatalogFixture().models.length }, steps: steps.map(([name]) => name) }; json(path.join(env.evidenceRoot, "clean-install.json"), report); return { status: "passed", report, result };
}

async function cli() { const args = process.argv.slice(2), requestedRoot = cliPath(option(args, "--root"), "--root"), evidence = cliPath(option(args, "--evidence"), "--evidence"), sourceCommit = option(args, "--source-commit"); if (args.includes("--dry-run")) throw new Error("--dry-run is retired: the isolated CLI always runs real local runtime"); const root = assertCliPreflight(requestedRoot); assertPushedHarness(sourceCommit); const nonce = rootNonce(root), target = planIsolatedTarget(root, nonce); await assertPortsAvailable(target.ports); const release = acquireIsolationLease(root, target.ports); let runtime; try { await assertPortsAvailable(target.ports); mkdirSync(root, { recursive: true, mode: 0o700 }); const canonicalRoot = assertCliPreflight(root); const env = createIsolatedEnvironment({ root: canonicalRoot, nonce, sourceCommit }); runtime = await createLocalRuntime(env, { sourceCommit }); await verifyCleanInstall(env, runtime.callbacks); await runtime.dispose(); runtime = undefined; await assertPortsAvailable(env.target.ports); recordAcceptanceEvidence({ themeId: "upgrade-preservation", kind: "isolated-install", requirementId: "r27", profile: "task2-isolated-install", provider: null, state: "passed", reason: "isolated clean install completed", artifact: path.join(env.evidenceRoot, "clean-install.json"), sourceCommit }, evidence); } finally { try { await runtime?.dispose(); } finally { release(); } } }
if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => { process.stderr.write(`${redactSensitive(error.message, { profile: "log" })}\n`); process.exitCode = 2; });
