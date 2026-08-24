import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveServiceTarget, validatedIsolationRoot } from "../src/service-target.mjs";
import { redactSensitive } from "../src/sensitive-redactor.mjs";
import { uninstallRouterRuntimeTransaction } from "../src/local-uninstall.mjs";
import { ownedRuntimePaths, restoreOwnedRuntime, snapshotOwnedRuntime } from "../src/owned-runtime-paths.mjs";
import { recordAcceptanceEvidence } from "./verify-acceptance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "codex-router-phase5-isolated-install-v2";
const HARNESS_PATHS = Object.freeze(["scripts/verify-isolated-install.mjs", "scripts/verify-upgrade-preservation.mjs", "test/isolated-install-harness.test.mjs", "test/upgrade-harness.test.mjs"]);
const RUNTIMES = new WeakMap();
export function runtimeCallbacksFor(env) { return RUNTIMES.get(env)?.callbacks; }
const CALLER_KEY = "acceptance_router_caller_capability_000000";
const INTERNAL_KEY = "acceptance_router_internal_capability_000000";
const FORBIDDEN_LAUNCH_RUNTIME = new RegExp(["py" + "thon", "lite" + "llm", "ta" + "uri", "car" + "go"].join("|"), "i");
function isolatedPorts(nonce) { const base = 46_000 + ([...nonce].reduce((sum, char) => sum + char.codePointAt(0), 0) % 600) * 20; return { oauth: base + 1, router: base + 2, api: base + 3, grokOauth: base + 8, devinCli: base + 10 }; }
function rootNonce(root) { return `root-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`; }

function cliPath(value, name) { if (!value || value.startsWith("-")) throw new Error(`invalid ${name}`); if (path.isAbsolute(value)) return path.resolve(value); if (value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`invalid relative ${name}`); return path.resolve(process.cwd(), value); }
function option(args, name) { const index = args.indexOf(name); if (index < 0 || !args[index + 1] || args[index + 1].startsWith("-")) throw new Error(`missing ${name}`); return args[index + 1]; }
function under(root, value, name) { const resolved = path.resolve(value), relative = path.relative(root, resolved); if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${name} must remain below the isolated root`); return resolved; }
function json(file, value) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, file); }
function writePrivateIfAbsent(file, contents) { if (existsSync(file)) return; mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, contents, { mode: 0o600 }); chmodSync(file, 0o600); }

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
  const env = Object.freeze({ owner: OWNER, root, sourceRoot, sourceCommit: seed.sourceCommit, target, codexHome: under(root, path.join(root, "codex-home"), "CODEX_HOME"), stateRoot: target.stateRoot, supportRoot: target.supportRoot, launchAgentsDir: target.launchAgentsDir, browserProfile: under(root, path.join(root, "browser-profile"), "browser profile"), credentialsPath: under(root, path.join(target.stateRoot, "acceptance-credentials.json"), "credential placeholder"), logPath: target.logPath, evidenceRoot: under(root, path.join(root, "evidence"), "evidence"), mkdir(value) { const targetPath = under(root, value, "write path"); mkdirSync(targetPath, { recursive: true, mode: 0o700 }); return targetPath; }, write(relative, contents, mode = 0o600) { const targetPath = under(root, path.join(root, relative), "write path"); mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 }); writeFileSync(targetPath, contents, { mode }); return targetPath; } });
  assertIsolatedEnvironment(env); if (typeof hooks.beforeWrite === "function") hooks.beforeWrite(env); return env;
}

export function assertIsolatedEnvironment(env) {
  if (!env || env.owner !== OWNER || !env.target || validatedIsolationRoot(env.target) !== env.root) throw new Error("invalid isolated environment");
  for (const [name, value] of Object.entries({ sourceRoot: env.sourceRoot, codexHome: env.codexHome, stateRoot: env.stateRoot, supportRoot: env.supportRoot, launchAgentsDir: env.launchAgentsDir, browserProfile: env.browserProfile, credentialsPath: env.credentialsPath, logPath: env.logPath, evidenceRoot: env.evidenceRoot, routerPlistPath: env.target.routerPlistPath, trayPlistPath: env.target.trayPlistPath, appPath: env.target.appPath })) under(env.root, value, name);
  if ([env.target.routerLabel, env.target.trayLabel].includes("io.github.codex-router") || [env.target.routerLabel, env.target.trayLabel].includes("io.github.codex-router.tray")) throw new Error("isolated environment collides with production labels");
  if (Object.values(env.target.ports).some((port) => [4201, 4202, 4203, 4208, 4210].includes(port))) throw new Error("isolated environment collides with production ports");
  return env;
}

function runtimeEnv(env) {
  return { ...process.env, MODEL_ROUTER_SERVICE_MODE: "acceptance", MODEL_ROUTER_ISOLATION_ROOT: env.root, MODEL_ROUTER_SOURCE_ROOT: env.sourceRoot, MODEL_ROUTER_STATE_DIR: env.stateRoot, MODEL_ROUTER_LOG_PATH: env.logPath, MODEL_ROUTER_LAUNCH_AGENTS_DIR: env.launchAgentsDir, MODEL_ROUTER_LAUNCH_AGENT_PATH: env.target.routerPlistPath, MODEL_ROUTER_TRAY_LAUNCH_AGENT_PATH: env.target.trayPlistPath, MODEL_ROUTER_TRAY_APP_PATH: env.target.appPath, MODEL_ROUTER_TRAY_APP_BINARY: env.target.appBinary, MODEL_ROUTER_SERVICE_LABEL: env.target.routerLabel, MODEL_ROUTER_TRAY_SERVICE_LABEL: env.target.trayLabel, MODEL_ROUTER_LAUNCH_DOMAIN: env.target.launchDomain, CODEX_HOME: env.codexHome, MODEL_ROUTER_OAUTH_PORT: String(env.target.ports.oauth), MODEL_ROUTER_PORT: String(env.target.ports.router), MODEL_ROUTER_API_PORT: String(env.target.ports.api), MODEL_ROUTER_GROK_OAUTH_PORT: String(env.target.ports.grokOauth), MODEL_ROUTER_DEVIN_CLI_PORT: String(env.target.ports.devinCli), CODEX_ROUTER_CALLER_KEY: CALLER_KEY, CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY, CODEX_ROUTER_TEST_NODE_ROUTE_FIXTURE: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1" };
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
async function localProviderFixture() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8"); let payload; try { payload = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
    if (!["/v1/responses", "/v1/messages"].includes(request.url || "") || request.method !== "POST") { response.writeHead(404).end(); return; }
    requests.push({ path: request.url, payload });
    if (request.url === "/v1/messages") { if (payload.model !== "glm-5.2" || !Array.isArray(payload.messages)) { response.writeHead(422).end(); return; } const reply = JSON.stringify({ id: "msg_acceptance", type: "message", role: "assistant", model: "glm-5.2", stop_reason: "end_turn", content: [{ type: "text", text: "fixture" }], usage: { input_tokens: 1, output_tokens: 1 } }); response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(reply) }); response.end(reply); return; }
    if (!payload.model || !Array.isArray(payload.input)) { response.writeHead(422).end(); return; } const reply = providerSse(); response.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(reply) }); response.end(reply);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

/** Real, local-only production composition for the public non-dry CLI. */
export async function createLocalRuntime(env, { sourceCommit, allowReleased = false, requireSwift = true } = {}) {
  assertIsolatedEnvironment(env); await materialize(env, sourceCommit, { allowReleased });
  const update = await import(pathToFileURL(path.join(env.sourceRoot, "src", "update.mjs")).href); const caller = await import(pathToFileURL(path.join(env.sourceRoot, "src", "caller-auth.mjs")).href);
  let fixture; let router; let processState; const pids = [];
  const prepare = () => { mkdirSync(env.codexHome, { recursive: true, mode: 0o700 }); mkdirSync(env.stateRoot, { recursive: true, mode: 0o700 }); writePrivateIfAbsent(env.credentialsPath, "acceptance placeholder only\n"); writePrivateIfAbsent(path.join(env.stateRoot, "caller-secret"), `${CALLER_KEY}\n`); writePrivateIfAbsent(path.join(env.stateRoot, "internal-secret"), `${INTERNAL_KEY}\n`); json(path.join(env.stateRoot, "merged-models.json"), { models: ["deepseek/deepseek-v4-flash", "qwen-plan/glm-5.2"].map((slug) => ({ slug, base_instructions: "", model_messages: { instructions_template: "" }, supports_parallel_tool_calls: false, provider: slug.split("/", 1)[0] })) }); if (requireSwift) copyCurrentSwiftBundle(env, sourceCommit); const plist = execFileSync(process.execPath, [path.join(env.sourceRoot, "src", "service-macos.mjs"), "render"], { cwd: env.sourceRoot, env: runtimeEnv(env), encoding: "utf8" }); if (!plist.includes(env.target.routerLabel) || !plist.includes(path.join(env.sourceRoot, "src", "start.mjs"))) throw new Error("isolated launch agent does not use materialized Node source"); mkdirSync(env.launchAgentsDir, { recursive: true, mode: 0o700 }); writeFileSync(env.target.routerPlistPath, plist, { mode: 0o600 }); chmodSync(env.target.routerPlistPath, 0o600); writePrivateIfAbsent(path.join(env.stateRoot, "unowned-preserved.txt"), "preserve\n"); };
  const stop = async () => { if (ownedProcessAlive(processState, router)) { try { process.kill(-router.pid, "SIGTERM"); } catch { if (ownedProcessAlive(processState, router)) router.kill("SIGTERM"); } const exited = processState.exitPromise; const grace = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]); if (!grace && ownedProcessAlive(processState, router)) { try { process.kill(-router.pid, "SIGKILL"); } catch { if (ownedProcessAlive(processState, router)) router.kill("SIGKILL"); } await exited; } } router = undefined; };
  const start = async () => { if (ownedProcessAlive(processState, router)) return { pid: router.pid, label: env.target.routerLabel, process: processState }; await portsFreeEventually(env.target.ports); fixture ||= await localProviderFixture();
    router = spawn(process.execPath, [path.join(env.sourceRoot, "src", "start.mjs")], { cwd: env.sourceRoot, env: { ...runtimeEnv(env), DEEPSEEK_API_BASE_URL: fixture.baseUrl, DEEPSEEK_API_KEY: INTERNAL_KEY, QWEN_PLAN_BASE_URL: fixture.baseUrl, QWEN_PLAN_API_KEY: INTERNAL_KEY }, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] }); processState = { child: router, pid: router.pid, alive: true, exitCode: null, signalCode: null, exitPromise: new Promise((resolve) => router.once("exit", (exitCode, signalCode) => { processState.alive = false; processState.exitCode = exitCode; processState.signalCode = signalCode; resolve(processState); })) }; router.stderr.on("data", (chunk) => writeFileSync(env.logPath, chunk, { flag: "a", mode: 0o600 })); pids.push(router.pid); await ready(`http://${env.target.host}:${env.target.ports.router}/health`, processState, env.logPath); return { pid: router.pid, label: env.target.routerLabel, process: processState }; };
  const base = () => caller.callerBaseUrl(env.target.ports.router, CALLER_KEY);
  const runtime = { prepare, stop, start, dispose: async () => { const failures = []; try { await stop(); } catch (error) { failures.push(error); } try { await close(fixture?.server); } catch (error) { failures.push(error); } json(path.join(env.evidenceRoot, `owned-processes-${path.basename(env.sourceRoot)}.json`), { owner: OWNER, runtimeId: path.basename(env.sourceRoot), pids, process: processState && { pid: processState.pid, exitCode: processState.exitCode, signalCode: processState.signalCode } }); if (failures.length) throw new AggregateError(failures, "isolated runtime cleanup failed"); }, callbacks: {
    prerequisites: async () => { const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19) || !execFileSync("git", ["--version"], { encoding: "utf8" }).trim() || !execFileSync("npm", ["--version"], { encoding: "utf8" }).trim()) throw new Error("installer prerequisite failed"); }, install: async () => { const installed = execFileSync(path.join(env.sourceRoot, "bin", "install"), ["--prepare-only"], { cwd: env.sourceRoot, env: runtimeEnv(env), encoding: "utf8" }); if (installed === undefined) throw new Error("materialized prepare-only installer did not run"); prepare(); }, inspectLaunchArgs: async () => { const plist = readFileSync(env.target.routerPlistPath, "utf8"), block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1], args = [...String(block || "").matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]); if (JSON.stringify(args) !== JSON.stringify([process.execPath, path.join(env.sourceRoot, "src", "start.mjs")])) throw new Error("isolated ProgramArguments are not the exact Node start command"); for (const [file, mode] of [[env.target.routerPlistPath, 0o600], [env.credentialsPath, 0o600], [env.stateRoot, 0o700], [env.target.appBinary, 0o755]]) if ((statSync(file).mode & 0o777) !== mode) throw new Error(`isolated mode mismatch: ${file}`); return args; }, start,
    authenticate: async () => { const denied = await fetch(`http://${env.target.host}:${env.target.ports.router}/_codex-router/not-a-valid-caller-key/v1/models`); if (denied.status !== 401) throw new Error("isolated caller endpoint did not reject invalid capability"); const ok = await fetch(`${base()}/models`, { headers: { authorization: `Bearer ${CALLER_KEY}` } }); if (!ok.ok) throw new Error("isolated caller endpoint rejected owned capability"); }, health: async () => { const response = await fetch(`http://${env.target.host}:${env.target.ports.router}/health`); const value = await response.json(); return { ok: response.ok && value?.service === "codex-router" }; },
    route: async (_env, transport) => { const model = transport === "messages" ? "qwen-plan/glm-5.2" : "deepseek/deepseek-v4-flash", expectedPath = transport === "messages" ? "/v1/messages" : "/v1/responses", before = fixture?.requests.filter((entry) => entry.path === expectedPath).length || 0; const response = await fetch(`${base()}/responses`, { method: "POST", headers: { authorization: `Bearer ${CALLER_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model, input: "isolated fixture", stream: true }) }); const text = await response.text(), matching = fixture?.requests.filter((entry) => entry.path === expectedPath) || []; if (!response.ok || !text.includes("response.") || matching.length !== before + 1) throw new Error(`isolated ${transport} fixture route failed`); return { transport, catalog: true }; },
    catalog: async () => { const response = await fetch(`${base()}/models`, { headers: { authorization: `Bearer ${CALLER_KEY}` } }); const value = await response.json(); return { published: response.ok && Array.isArray(value?.data) && value.data.some((model) => model.id === "deepseek/deepseek-v4-flash") }; }, browser: async () => update.verifyBrowserCapabilityContract(env.target, { callerKey: CALLER_KEY }), swift: async () => update.verifySwiftCommandContract(env.target), lifecycle: async (_env, action) => { if (action === "stop") return stop(); if (action === "start") return start(); if (action === "restart") { await stop(); return start(); } throw new Error(`unsupported lifecycle ${action}`); }, uninstall: async () => { const runtimeRoots = { userHome: env.root, codexHome: env.codexHome, dshHome: path.join(env.root, "dsh"), geminiHome: path.join(env.root, "gemini") }, paths = ownedRuntimePaths(env.target, runtimeRoots), before = snapshotOwnedRuntime(paths), unowned = readFileSync(path.join(env.stateRoot, "unowned-preserved.txt")); await uninstallRouterRuntimeTransaction({ target: env.target, runtimeRoots, snapshot: before, ownedPaths: ["router-plist", "tray-app"], installReplacement: stop, verifyReplacement: async () => {}, restoreSnapshot: async (saved) => restoreOwnedRuntime(saved), restartOldService: start }); if (!Buffer.from(unowned).equals(readFileSync(path.join(env.stateRoot, "unowned-preserved.txt")))) throw new Error("isolated uninstall modified unowned content"); },
  } }; RUNTIMES.set(env, runtime); return runtime;
}

export async function verifyCleanInstall(env, callbacks = RUNTIMES.get(env)?.callbacks) {
  assertIsolatedEnvironment(env); const activeCallbacks = callbacks || RUNTIMES.get(env)?.callbacks; const steps = [["prerequisites", [env]], ["install", [env]], ["inspectLaunchArgs", [env]], ["start", [env]], ["authenticate", [env]], ["health", [env]], ["route", [env, "responses"]], ["route", [env, "messages"]], ["catalog", [env]], ["browser", [env]], ["swift", [env]], ["lifecycle", [env, "stop"]], ["lifecycle", [env, "start"]], ["lifecycle", [env, "restart"]], ["uninstall", [env]]]; const result = {};
  for (const [name, args] of steps) { if (typeof activeCallbacks?.[name] !== "function") throw new Error(`isolated install requires runtime ${name} callback`); const value = await activeCallbacks[name](...args); if (name === "inspectLaunchArgs" && (!Array.isArray(value) || !value.some((arg) => /src[\\/]start\.mjs$/.test(String(arg))) || value.some((arg) => FORBIDDEN_LAUNCH_RUNTIME.test(String(arg))))) throw new Error("isolated launch arguments are not Node-only"); if (name === "health" && value?.ok !== true) throw new Error("isolated Router health is not OK"); if (name === "route" && value?.catalog !== true) throw new Error(`isolated ${args[1]} route did not use fixture catalog`); if (name === "catalog" && value?.published !== true) throw new Error("isolated catalog was not published"); result[`${name}:${args[1] || ""}`] = value; }
  const report = { schemaVersion: 2, owner: OWNER, status: "passed", sourceCommit: env.sourceCommit, target: { labels: [env.target.routerLabel, env.target.trayLabel], ports: env.target.ports }, steps: steps.map(([name]) => name) }; json(path.join(env.evidenceRoot, "clean-install.json"), report); return { status: "passed", report, result };
}

async function cli() { const args = process.argv.slice(2), requestedRoot = cliPath(option(args, "--root"), "--root"), evidence = cliPath(option(args, "--evidence"), "--evidence"), sourceCommit = option(args, "--source-commit"); if (args.includes("--dry-run")) throw new Error("--dry-run is retired: the isolated CLI always runs real local runtime"); const root = assertCliPreflight(requestedRoot); assertPushedHarness(sourceCommit); const nonce = rootNonce(root), target = planIsolatedTarget(root, nonce); await assertPortsAvailable(target.ports); const release = acquireIsolationLease(root, target.ports); let runtime; try { await assertPortsAvailable(target.ports); mkdirSync(root, { recursive: true, mode: 0o700 }); const canonicalRoot = assertCliPreflight(root); const env = createIsolatedEnvironment({ root: canonicalRoot, nonce, sourceCommit }); runtime = await createLocalRuntime(env, { sourceCommit }); await verifyCleanInstall(env, runtime.callbacks); await runtime.dispose(); runtime = undefined; await assertPortsAvailable(env.target.ports); recordAcceptanceEvidence({ themeId: "upgrade-preservation", kind: "isolated-install", requirementId: "r27", profile: "task2-isolated-install", provider: null, state: "passed", reason: "isolated clean install completed", artifact: path.join(env.evidenceRoot, "clean-install.json"), sourceCommit }, evidence); } finally { try { await runtime?.dispose(); } finally { release(); } } }
if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => { process.stderr.write(`${redactSensitive(error.message, { profile: "log" })}\n`); process.exitCode = 2; });
