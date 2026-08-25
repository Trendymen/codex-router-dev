import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

import {
  acquireIsolationLease,
  assertCliPreflight,
  assertIsolatedEnvironment,
  assertPortsAvailable,
  createIsolatedEnvironment,
  createLocalRuntime,
  isolationLeasePath,
  privateRegularFile,
  readInstalledCallerSecret,
  runtimeCallbacksFor,
} from "./verify-isolated-install.mjs";
import { runMacOSMutation } from "../src/platform-gate.mjs";
import { createCatalogGenerationFileSystem, publishCatalogGeneration } from "../src/catalog-generation.mjs";
import { beginFinalEvidence, loadMatrix, recordAcceptanceEvidence } from "./verify-acceptance.mjs";
import { redactSensitive } from "../src/sensitive-redactor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "codex-router-phase5-runtime-v1";
const HANDLE = "runtime-handle.json";
const RUNTIME_PATHS = Object.freeze(["scripts/acceptance-runtime.mjs", "test/acceptance-runtime.test.mjs"]);
const VISUALS = Object.freeze({
  "browser-desktop": { requirementId: "r49", themeId: "success-browser-panel", appearance: "light" },
  "browser-narrow": { requirementId: "r37", themeId: "browser-security", appearance: "light" },
  "vision-allow": { requirementId: "r31", themeId: "vision-allow", appearance: "light" },
  "swift-light": { requirementId: "r57", themeId: "success-vision", appearance: "light" },
  "swift-dark": { requirementId: "r57", themeId: "success-vision", appearance: "dark" },
  "testing-evidence": { requirementId: "r61", themeId: "success-testing-evidence", appearance: "light" },
});
const RUNTIME_ROWS = Object.freeze({ r06: "reasoning-abort-nonstream", r19: "failover", r22: "catalog-lifecycle-atomicity", r29: "platform-removal", r41: "testing-runtime", r45: "success-node-router", r51: "success-catalog", r55: "success-platform" });
const UI_ROWS = Object.freeze({ r24: "capability-command-ui", r35: "write-sessions", r47: "success-desktop-app", r59: "success-public-errors" });
export function finalTask3RequirementIds() {
  return Object.freeze([...Object.keys(RUNTIME_ROWS), ...Object.keys(UI_ROWS), ...new Set(Object.values(VISUALS).map((value) => value.requirementId))]);
}

function fixtureSse() {
  const item = { id: "msg_acceptance", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture" }] };
  const events = [{ type: "response.created", response: { id: "resp_acceptance", model: "fixture" } }, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }, { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "" } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "fixture" }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "resp_acceptance", model: "fixture", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}
/** Task3-only loopback fixture. It stores only protocol category metadata. */
export async function createRuntimeFixture({ registerServer, quotaModel = null, slowStreams = false, behavior, signal } = {}) {
  const state = behavior || { quotaModel };
  const attempts = [], requests = [];
  const server = http.createServer(async (request, response) => {
    const entry = { path: request.url || "", method: request.method || "", model: null, accepted: false, reason: "unvalidated", transport: "responses" }; attempts.push(entry);
    if (request.method !== "POST" || !["/v1/responses", "/v1/messages"].includes(request.url)) { entry.reason = "wrong_path_or_method"; response.writeHead(404).end(); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk); let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { entry.reason = "invalid_json"; response.writeHead(422).end(); return; }
    entry.model = typeof body?.model === "string" && /^[A-Za-z0-9._/-]{1,128}$/.test(body.model) ? body.model : null;
    if (!entry.model) { entry.reason = "invalid_model"; response.writeHead(422).end(); return; }
    entry.transport = request.url.endsWith("messages") ? "messages" : "responses";
    // Only retain category booleans: request contents, tool arguments, image
    // URLs and reasoning are deliberately never retained in fixture evidence.
    const categories = state.categories ||= Object.create(null);
    if (body.reasoning) categories.reasoning = Number(categories.reasoning || 0) + 1;
    if (Array.isArray(body.tools) && body.tools.length) categories.tools = Number(categories.tools || 0) + 1;
    if (body.tool_choice && body.tool_choice !== "auto" && body.tool_choice !== "none") categories.forcedTool = Number(categories.forcedTool || 0) + 1;
    if (JSON.stringify(body.input || "").includes("input_image")) categories.image = Number(categories.image || 0) + 1;
    if (JSON.stringify(body.input || "").includes("function_call_output")) categories.toolOutput = Number(categories.toolOutput || 0) + 1;
    if (state.quotaModel && entry.model === state.quotaModel) { entry.reason = "quota"; response.writeHead(429, { "content-type": "application/json", "retry-after": "60" }).end(JSON.stringify({ error: { type: "insufficient_quota", code: "429" } })); return; }
    entry.accepted = true; entry.reason = "accepted"; requests.push(entry);
    if (body.stream === true) {
      const stream = fixtureSse();
      response.writeHead(200, { "content-type": "text/event-stream", "content-length": Buffer.byteLength(stream) });
      if (!slowStreams) { response.end(stream); return; }
      const first = stream.indexOf("\n\n") + 2;
      response.write(stream.slice(0, first));
      const timer = setTimeout(() => response.end(stream.slice(first)), 250);
      response.once("close", () => { clearTimeout(timer); state.closedStreams = Number(state.closedStreams || 0) + 1; });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "resp_task3", object: "response", status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture" }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); registerServer?.(server);
  if (signal) { const close = () => { try { server.close(); } catch {} }; if (signal.aborted) close(); else signal.addEventListener("abort", close, { once: true }); }
  return { server, attempts, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function inside(root, value, name) { const resolved = path.resolve(value), relative = path.relative(root, resolved); if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${name} must remain below isolated root`); return resolved; }
function acceptanceSiblingPath(root, value, name) {
  const parent = path.dirname(path.resolve(root)), resolved = inside(parent, value, name);
  if (resolved === path.resolve(root)) throw new Error(`${name} must be a sibling of the runtime root`);
  return resolved;
}
/** The human/browser capture surface is deliberately a sibling of the router
 * runtime.  It survives only for the active worker and is never a general
 * writable parent directory. */
export function runtimeCaptureRoot(root, runtimeId, kind = "browser") {
  if (!/^(?:worker|runtime)-[0-9a-f]{16}$/.test(String(runtimeId || ""))) throw new Error("runtime id is invalid for capture root");
  if (!["browser", "swift"].includes(kind)) throw new Error("runtime capture kind is invalid");
  const runtimeRoot = path.resolve(root), parent = path.dirname(runtimeRoot), name = path.basename(runtimeRoot).replace(/[^a-z0-9-]/gi, "-");
  const capture = name === "runtime" ? path.join(parent, kind) : path.join(parent, `task3-${kind}-${name}-${runtimeId}`);
  if (existsSync(capture)) throw new Error("runtime capture root already exists");
  mkdirSync(capture, { recursive: true, mode: 0o700 }); chmodSync(capture, 0o700);
  const entry = lstatSync(capture);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (statSync(capture).mode & 0o077) !== 0 || realpathSync(capture) !== capture) throw new Error("runtime capture root is not a private canonical directory");
  return capture;
}
/** The five-argument final API plans its browser profile before it spawns the
 * same worker used by the CLI.  Keeping this deterministic binds the caller's
 * explicit path without allowing an arbitrary sibling directory to be erased
 * during worker shutdown. */
export function finalNonLiveBrowserProfile(root) {
  const runtimeRoot = path.resolve(root), name = path.basename(runtimeRoot).replace(/[^a-z0-9-]/gi, "-");
  return acceptanceSiblingPath(runtimeRoot, path.join(path.dirname(runtimeRoot), `task3-browser-${name}-final`, "profile"), "final non-live browser profile");
}
function finalNonLiveBrowserCaptureRoot(root, profile) {
  const expected = finalNonLiveBrowserProfile(root);
  if (path.resolve(profile) !== expected) throw new Error("final non-live browser profile does not match the explicit worker plan");
  const captureRoot = path.dirname(expected);
  if (existsSync(captureRoot)) throw new Error("final non-live browser capture root already exists");
  mkdirSync(captureRoot, { recursive: true, mode: 0o700 }); chmodSync(captureRoot, 0o700);
  if (!lstatSync(captureRoot).isDirectory() || lstatSync(captureRoot).isSymbolicLink() || (statSync(captureRoot).mode & 0o077) !== 0 || realpathSync(captureRoot) !== captureRoot) throw new Error("final non-live browser capture root is not private");
  return captureRoot;
}
/** A nested protocol router gets a newly constructed environment.  In
 * particular it never inherits credentials, proxies, NODE_OPTIONS, or the
 * user's Codex session from this acceptance worker. */
export function protocolLabEnvironment({ root, stateRoot, port, providerPort, nativePort, callerKey, parent = process.env }) {
  const labRoot = path.resolve(root), home = inside(labRoot, path.join(labRoot, "protocol-home"), "protocol home"), codexHome = inside(labRoot, path.join(labRoot, "protocol-codex-home"), "protocol Codex home"), missingAuth = inside(labRoot, path.join(labRoot, "protocol-missing-auth.json"), "protocol missing auth");
  mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const safe = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TMP", "TEMP", "TMPDIR"]) if (typeof parent?.[key] === "string" && parent[key]) safe[key] = parent[key];
  const internalKey = randomBytes(32).toString("hex"), kimiKey = randomBytes(32).toString("hex");
  return {
    ...safe,
    HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, MODEL_ROUTER_CODEX_AUTH: missingAuth,
    CODEX_ROUTER_NATIVE_SESSION_FALLBACK: "0", MODEL_ROUTER_STATE_DIR: stateRoot,
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: callerKey,
    CODEX_ROUTER_INTERNAL_KEY: internalKey, KIMI_INTERNAL_KEY: kimiKey,
    CODEX_ROUTER_TEST_NODE_ROUTE_FIXTURE: "1", CODEX_ROUTER_TEST_NODE_ROUTE_STRICT: "1", CODEX_ROUTER_SHOW_ALL_MODELS: "1", CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_NODE_PROVIDER_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${providerPort}/health`, CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${providerPort}/health`,
    DEEPSEEK_API_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, DEEPSEEK_API_KEY: "task3-loopback", QWEN_PLAN_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, QWEN_PLAN_API_KEY: "task3-loopback",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}/backend-api/codex`,
  };
}
/** Closed, non-secret protocol observations.  The provider loopback may see
 * only its fixture credential; native and search loopbacks must see none. */
export function protocolAuthorizationPredicates({ providerAuthorization, nativeAuthorization, forcedTool, forcedRequest, forcedStatus, forcedBody }) {
  return Object.freeze({
    providerAuthorizationSafe: providerAuthorization === "Bearer task3-loopback",
    nativeAuthorizationSafe: nativeAuthorization === undefined,
    forcedToolBoundary: forcedTool === true && forcedRequest === true && forcedStatus === 422 && /required_tool_not_called/.test(String(forcedBody || "")),
  });
}
function privateJson(file, value) { mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, file); }
function privateJsonReplace(file, value) { if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("refusing to replace a symbolic-link acceptance artifact"); privateJson(file, value); }
function safeText(value) { const raw = String(value); if (/(?:Bearer\s+|Basic\s+|[?&](?:token|key|secret)=|caller[-_ ]?(?:key|secret)|capability|prompt|reasoning|tool[_ -]?(?:args|arguments)|request[_ -]?body)/i.test(raw)) throw new Error("unsafe acceptance text"); const text = redactSensitive(raw, { profile: "log" }); if (/(?:Bearer\s+|Basic\s+|[?&](?:token|key|secret)=|caller[-_ ]?(?:key|secret)|capability|prompt|reasoning|tool[_ -]?(?:args|arguments)|request[_ -]?body)/i.test(text)) throw new Error("unsafe acceptance text"); return text; }
function localPath(root, value, name) { const resolved = inside(root, value, name); let entry; try { entry = lstatSync(resolved); } catch { throw new Error(`${name} must be a regular non-empty file`); } if (!entry.isFile() || entry.isSymbolicLink() || statSync(resolved).size < 1) throw new Error(`${name} must be a regular non-empty file`); return resolved; }
function canonicalArtifact(root, value, name) {
  const resolved = localPath(root, value, name), canonicalRoot = realpathSync(root), canonical = realpathSync(resolved), relative = path.relative(canonicalRoot, canonical);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || canonical !== resolved) throw new Error(`${name} must remain below canonical isolated root`);
  let cursor = canonicalRoot;
  for (const part of relative.split(path.sep)) { cursor = path.join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${name} cannot cross a symbolic link`); }
  return resolved;
}
function archiveCapture(root, captureRoot, artifact, label) {
  const original = canonicalArtifact(captureRoot, artifact, `${label} capture`), digest = createHash("sha256").update(readFileSync(original)).digest("hex"), extension = path.extname(original).replace(/[^.a-z0-9]/gi, "").slice(0, 12) || ".bin";
  const destination = inside(root, path.join(root, "evidence", "captures", `${label}-${digest}${extension}`), `${label} archived capture`);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (!existsSync(destination)) { copyFileSync(original, destination, fsConstants.COPYFILE_EXCL); chmodSync(destination, 0o600); }
  return canonicalArtifact(root, destination, `${label} archived capture`);
}
function fingerprintFile(file, name) { const resolved = localPath(path.dirname(path.resolve(file)), file, name), entry = lstatSync(resolved); return { path: resolved, sha256: createHash("sha256").update(readFileSync(resolved)).digest("hex"), mtimeMs: entry.mtimeMs }; }
function checkedCapture(root, captureRoot, artifact, label, captureStartedAt) {
  const sourcePath = canonicalArtifact(captureRoot, artifact, `${label} source capture`);
  const sourceCapture = fingerprintFile(sourcePath, `${label} source capture`);
  const startedAt = Date.parse(captureStartedAt);
  if (!Number.isFinite(startedAt) || sourceCapture.mtimeMs < startedAt) throw new Error(`${label} source capture predates its pending session`);
  const archivePath = archiveCapture(root, captureRoot, sourcePath, label);
  const archiveFingerprint = fingerprintFile(canonicalArtifact(root, archivePath, `${label} archived capture`), `${label} archived capture`);
  if (archiveFingerprint.sha256 !== sourceCapture.sha256) throw new Error(`${label} archived capture does not match source capture`);
  return { sourceCapture, archiveCapture: archiveFingerprint };
}
function browserSidecarCaptures(root, captureRoot, artifact, sourceCommit, runtimeId, captureStartedAt) {
  const sidecars = {};
  for (const kind of ["console", "network", "storage"]) {
    const source = canonicalArtifact(captureRoot, `${artifact}.${kind}.json`, `browser ${kind} sidecar`);
    let value;
    try { value = JSON.parse(readFileSync(source, "utf8")); } catch { throw new Error(`browser ${kind} sidecar is not valid JSON`); }
    assertBrowserSidecarValue(value, kind);
    sidecars[kind] = { sourceCommit, runtimeId, captureStartedAt, ...checkedCapture(root, captureRoot, source, `browser-${kind}-sidecar`, captureStartedAt) };
  }
  return sidecars;
}
function assertBrowserSidecarValue(value, kind) {
  exactKeys(value, ["kind", "observations", "version"], `browser ${kind} sidecar`);
  if (value.version !== 1 || value.kind !== kind || !Array.isArray(value.observations)) throw new Error(`browser ${kind} sidecar schema is invalid`);
  const unsafe = /(?:authorization|cookie|bearer\s+|capability|credential|(?:access|refresh)[_ -]?token|(?:api[_ -]?)?key|secret|password|session(?:[_ -]?id)?|auth(?:entication|orization)?|(?:request|response)[_ -]?body|prompt|reasoning|tool[_ -]?(?:args|arguments))/i;
  for (const observation of value.observations) {
    exactKeys(observation, ["code", "status"], `browser ${kind} sidecar observation`);
    for (const field of [observation.code, observation.status]) {
      if (typeof field !== "string" || unsafe.test(field)) throw new Error(`browser ${kind} sidecar contains unsafe content`);
      safeText(field);
    }
  }
}
function validateRecordedBrowserSidecars(root, sidecars, { sourceCommit, runtimeId, captureStartedAt }) {
  exactKeys(sidecars, ["console", "network", "storage"], "browser sidecars");
  for (const [kind, sidecar] of Object.entries(sidecars)) {
    exactKeys(sidecar, ["archiveCapture", "captureStartedAt", "runtimeId", "sourceCapture", "sourceCommit"], `browser ${kind} sidecar report`);
    if (sidecar.sourceCommit !== sourceCommit || sidecar.runtimeId !== runtimeId || sidecar.captureStartedAt !== captureStartedAt) throw new Error(`browser ${kind} sidecar is not bound to its capture`);
    for (const capture of [sidecar.sourceCapture, sidecar.archiveCapture]) exactKeys(capture, ["mtimeMs", "path", "sha256"], `browser ${kind} sidecar capture`);
    const archive = canonicalArtifact(root, sidecar.archiveCapture.path, `browser ${kind} archived sidecar`), fingerprint = fingerprintFile(archive, `browser ${kind} archived sidecar`);
    if (fingerprint.path !== sidecar.archiveCapture.path || fingerprint.sha256 !== sidecar.archiveCapture.sha256 || fingerprint.sha256 !== sidecar.sourceCapture.sha256) throw new Error(`browser ${kind} archived sidecar changed after review`);
    let value; try { value = JSON.parse(readFileSync(archive, "utf8")); } catch { throw new Error(`browser ${kind} archived sidecar is not valid JSON`); }
    assertBrowserSidecarValue(value, kind);
  }
  return sidecars;
}
function currentCommit() { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }
function handlePath(root) { return inside(root, path.join(root, HANDLE), "runtime handle"); }
// macOS sockaddr_un silently truncates long paths. The isolated root itself is
// intentionally descriptive, so keep the control-socket leaf to one byte.
function controlPath(root) { return inside(root, path.join(root, "c"), "runtime control socket"); }
export function runtimeRootForArtifact(artifact) {
  let cursor = path.dirname(path.resolve(artifact));
  const boundary = path.resolve(ROOT, "generated", "acceptance");
  while (cursor === boundary || cursor.startsWith(`${boundary}${path.sep}`)) {
    if (existsSync(handlePath(cursor))) return cursor;
    const binding = path.join(cursor, "runtime-capture.json");
    if (existsSync(binding) && !lstatSync(binding).isSymbolicLink()) {
      const value = JSON.parse(readFileSync(binding, "utf8"));
      if (value?.owner === OWNER && /^worker-[0-9a-f]{16}$/.test(value.runtimeId) && typeof value.root === "string" && existsSync(handlePath(value.root))) return value.root;
    }
    const candidates = readdirSync(cursor, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(cursor, entry.name))
      .filter((candidate) => existsSync(path.join(candidate, HANDLE)));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) throw new Error("visual artifact acceptance parent has ambiguous active runtimes");
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  throw new Error("visual artifact is not below an active isolated runtime root");
}
function sourceBytes(sourceCommit, file) { return execFileSync("git", ["show", `${sourceCommit}:${file}`], { cwd: ROOT, encoding: "buffer" }); }

export function assertPushedRuntimeHarness(sourceCommit, { git = (args, options = {}) => execFileSync("git", args, { cwd: ROOT, ...options }), remoteProbe } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sourceCommit || ""))) throw new Error("source commit must be a full Git commit");
  const remote = String((remoteProbe || (() => git(["ls-remote", "github", "refs/heads/main"], { encoding: "utf8" })))(sourceCommit)).trim().split(/\s+/)[0];
  const head = String(git(["rev-parse", "HEAD"], { encoding: "utf8" })).trim();
  if (remote !== sourceCommit || head !== sourceCommit) throw new Error("runtime acceptance must run current github/main");
  for (const file of RUNTIME_PATHS) {
    if (String(git(["status", "--porcelain", "--", file], { encoding: "utf8" })).trim()) throw new Error(`runtime harness path is dirty or untracked: ${file}`);
    const committed = Buffer.from(git(["show", `${sourceCommit}:${file}`], { encoding: "buffer" }));
    if (!committed.equals(readFileSync(path.join(ROOT, file)))) throw new Error(`runtime harness bytes differ from source commit: ${file}`);
  }
  return true;
}
/** Every mutating/recording CLI command calls this gate.  It intentionally is
 * not used by injected unit seams, which exercise the pure helpers before the
 * two files are checked in. */
function assertRuntimeCommandProvenance(sourceCommit) { return assertPushedRuntimeHarness(sourceCommit); }

function exactKeys(value, keys, name) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`runtime handle ${name} schema is invalid`); return value; }
function sameIdentity(left, right) { return Number(left?.dev) === Number(right?.dev) && Number(left?.ino) === Number(right?.ino); }
function identity(value) { return { dev: Number(value.dev), ino: Number(value.ino) }; }
function privateIdentity(file, name) {
  const entry = lstatSync(file);
  if (entry.isSymbolicLink() || !privateRegularFile(file, entry) || entry.size < 1) throw new Error(`${name} must be a private regular file`);
  return identity(entry);
}
/** Read a private file through the same no-follow descriptor whose identity is checked before and after parsing. */
function readPrivateNoFollow(file, expected, name) {
  const before = lstatSync(file);
  if (before.isSymbolicLink() || !privateRegularFile(file, before) || (expected && !sameIdentity(before, expected))) throw new Error(`${name} is not an owned private file`);
  let descriptor;
  try { descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch { throw new Error(`${name} cannot be opened without following links`); }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened) || (expected && !sameIdentity(opened, expected))) throw new Error(`${name} identity changed while opening`);
    const text = readFileSync(descriptor, "utf8");
    const after = lstatSync(file);
    if (!sameIdentity(opened, after) || after.isSymbolicLink()) throw new Error(`${name} identity changed while reading`);
    return text;
  } finally { closeSync(descriptor); }
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
async function boundedCleanup(label, operation, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} cleanup timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
export function removeCaptureRoots(captureRoots, { remove = rmSync } = {}) {
  const failures = [];
  for (const captureRoot of Object.values(captureRoots || {})) {
    try { remove(captureRoot, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "runtime capture cleanup failed");
}
function psIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("invalid owned process pid");
  let text;
  try { text = execFileSync("ps", ["-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "command="], { encoding: "utf8" }).trim(); } catch { throw new Error("owned process is no longer inspectable"); }
  if (!text || !new RegExp(`^\\s*${pid}\\s+`).test(text)) throw new Error("owned process identity is unknown");
  return Object.freeze({ pid, digest: hash(text) });
}
function assertProcessIdentity(snapshot, name, inspect = psIdentity) {
  exactKeys(snapshot, ["pid", "digest"], `${name} identity`);
  if (!Number.isInteger(snapshot.pid) || snapshot.pid < 1 || !/^[0-9a-f]{64}$/.test(snapshot.digest)) throw new Error(`invalid ${name} identity`);
  const current = inspect(snapshot.pid);
  if (current.digest !== snapshot.digest) throw new Error(`${name} process identity changed`);
  return current;
}
export function sanitizeRuntimeHandle(value) {
  // Reconstruct a closed public shape rather than redacting a clone: a future
  // secret-bearing field can never enter the checked-in handle by accident.
  return {
    owner: value?.owner, sourceCommit: value?.sourceCommit, root: value?.root, handlePath: value?.handlePath, runtimeId: value?.runtimeId, socket: value?.socket,
    socketIdentity: { dev: value?.socketIdentity?.dev, ino: value?.socketIdentity?.ino },
    handshake: { path: value?.handshake?.path, identity: { dev: value?.handshake?.identity?.dev, ino: value?.handshake?.identity?.ino } },
    router: { pid: value?.router?.pid, workerPid: value?.router?.workerPid, startedAt: value?.router?.startedAt, port: value?.router?.port, label: value?.router?.label, routerIdentity: { pid: value?.router?.routerIdentity?.pid, digest: value?.router?.routerIdentity?.digest }, workerIdentity: { pid: value?.router?.workerIdentity?.pid, digest: value?.router?.workerIdentity?.digest } },
    lease: { path: value?.lease?.path, normalized: value?.lease?.normalized, identity: { dev: value?.lease?.identity?.dev, ino: value?.lease?.identity?.ino }, ports: value?.lease?.ports },
    captureRoots: { browser: value?.captureRoots?.browser, swift: value?.captureRoots?.swift },
    profile: value?.profile, artifacts: { report: value?.artifacts?.report },
  };
}

export function assertRuntimeHandle(value) {
  exactKeys(value, ["owner", "sourceCommit", "root", "handlePath", "runtimeId", "socket", "socketIdentity", "handshake", "router", "lease", "captureRoots", "profile", "artifacts"], "root");
  if (!value || value.owner !== OWNER || !/^[0-9a-f]{40}$/.test(String(value.sourceCommit || "")) || typeof value.root !== "string" || typeof value.handlePath !== "string") throw new Error("invalid runtime handle");
  const root = path.resolve(value.root); if (root !== value.root || !path.basename(root)) throw new Error("invalid isolated root");
  inside(root, value.handlePath, "runtime handle");
  exactKeys(value.captureRoots, ["browser", "swift"], "capture roots");
  for (const kind of ["browser", "swift"]) if (typeof value.captureRoots[kind] !== "string" || path.resolve(value.captureRoots[kind]) !== value.captureRoots[kind] || !acceptanceSiblingPath(root, value.captureRoots[kind], `${kind} capture root`)) throw new Error("runtime capture root is invalid");
  if (typeof value.profile !== "string" || path.resolve(value.profile) !== value.profile || !inside(value.captureRoots.browser, value.profile, "runtime browser profile")) throw new Error("runtime browser profile is invalid");
  if (value.handlePath !== handlePath(root)) throw new Error("runtime handle path is invalid");
  exactKeys(value.router, ["pid", "workerPid", "startedAt", "port", "label", "routerIdentity", "workerIdentity"], "router");
  if (["io.github.codex-router", "io.github.codex-router.tray"].includes(value.router?.label)) throw new Error("runtime handle uses a production label");
  if (!value.router || !Number.isInteger(value.router.pid) || value.router.pid < 1 || !Number.isInteger(value.router.workerPid) || value.router.workerPid < 1 || !Number.isFinite(value.router.startedAt) || !Number.isInteger(value.router.port) || value.router.port < 1024 || !/^io\.github\.codex-router\.acceptance-[a-z0-9-]+$/i.test(String(value.router.label))) throw new Error("invalid isolated router owner");
  assertProcessIdentity(value.router.routerIdentity, "router", (pid) => ({ pid, digest: value.router.routerIdentity.digest }));
  assertProcessIdentity(value.router.workerIdentity, "worker", (pid) => ({ pid, digest: value.router.workerIdentity.digest }));
  exactKeys(value.lease, ["path", "normalized", "identity", "ports"], "lease"); exactKeys(value.lease.identity, ["dev", "ino"], "lease identity"); exactKeys(value.artifacts, ["report"], "artifacts");
  if (!Array.isArray(value.lease.ports) || !value.lease.ports.includes(value.router.port) || !Number.isInteger(value.lease.identity.dev) || !Number.isInteger(value.lease.identity.ino)) throw new Error("invalid runtime lease identity");
  const expectedLease = isolationLeasePath(value.lease.ports);
  if (path.resolve(value.lease.path) !== expectedLease.lock || value.lease.normalized !== expectedLease.normalized) throw new Error("runtime handle lease is not the exact derived port lease");
  exactKeys(value.socketIdentity, ["dev", "ino"], "socket identity"); exactKeys(value.handshake, ["path", "identity"], "handshake"); exactKeys(value.handshake.identity, ["dev", "ino"], "handshake identity");
  if (!Number.isInteger(value.socketIdentity.dev) || !Number.isInteger(value.socketIdentity.ino) || !Number.isInteger(value.handshake.identity.dev) || !Number.isInteger(value.handshake.identity.ino)) throw new Error("invalid runtime control identity");
  acceptanceSiblingPath(root, value.profile, "browser profile"); inside(root, value.socket, "runtime control socket"); inside(root, value.handshake.path, "runtime handshake");
  for (const field of ["root", "handlePath", "runtimeId", "profile", "socket", "lease.path", "handshake.path"]) safeText(String(field === "lease.path" ? value.lease.path : field === "handshake.path" ? value.handshake.path : value[field]));
  return Object.freeze({ ...value, root });
}

function readHandle(file) {
  const resolved = path.resolve(file), entry = lstatSync(resolved);
  if (entry.isSymbolicLink()) throw new Error("runtime handle cannot be a symlink");
  if (!privateRegularFile(resolved, entry)) throw new Error("runtime handle must be private mode 0600");
  const value = assertRuntimeHandle(JSON.parse(readPrivateNoFollow(resolved, identity(entry), "runtime handle")));
  if (value.handlePath !== resolved) throw new Error("runtime handle location was tampered");
  return value;
}

export function runtimeAcceptanceReport(handle, { verifyIdentity = true, inspect = psIdentity } = {}) {
  const value = typeof handle === "string" ? readHandle(handle) : assertRuntimeHandle(handle);
  let alive = false;
  if (verifyIdentity) {
    try { assertProcessIdentity(value.router.routerIdentity, "router", inspect); assertProcessIdentity(value.router.workerIdentity, "worker", inspect); alive = true; } catch (error) { if (!/no longer inspectable|identity is unknown/.test(error.message)) throw error; }
  } else { try { process.kill(value.router.pid, 0); alive = true; } catch (error) { if (error?.code !== "ESRCH") throw error; } }
  return { owner: OWNER, status: alive ? "running" : "stopped", sourceCommit: value.sourceCommit, runtimeId: value.runtimeId, router: { pid: value.router.pid, workerPid: value.router.workerPid, port: value.router.port, label: value.router.label }, profile: value.profile };
}

function writeHandle(value) { const safe = assertRuntimeHandle(sanitizeRuntimeHandle(value)); privateJson(safe.handlePath, safe); return safe; }
function taskRow(requirementId, expected) { const matrix = loadMatrix(); const match = matrix.flatMap((theme) => theme.requiredEvidence.map((row) => ({ themeId: theme.id, ...row }))).filter((row) => row.requirementId === requirementId); if (match.length !== 1 || match[0].themeId !== expected) throw new Error(`unknown acceptance requirement ${requirementId}`); return match[0]; }
function recordRuntimeEvidence({ evidence, sourceCommit, requirementId, artifact, reason, state = "passed" }) {
  const expected = RUNTIME_ROWS[requirementId]; if (!expected) throw new Error("runtime evidence requirement is not allowed");
  const row = taskRow(requirementId, expected); const target = localPath(path.dirname(path.resolve(evidence)), artifact, "runtime artifact");
  return recordAcceptanceEvidence({ ...row, state, reason: safeText(reason), artifact: target, sourceCommit }, path.resolve(evidence));
}
/** The Task3 recorder is deliberately private: only a completed worker stage
 * may publish its closed eight-row set. Restore the old document on any write
 * failure so a partial scenario never becomes green evidence. */
function readRuntimeStage(artifact, sourceCommit) {
  const entry = privateIdentity(artifact, "runtime stage artifact");
  const stage = JSON.parse(readPrivateNoFollow(artifact, entry, "runtime stage artifact"));
  exactKeys(stage, ["assertions", "owner", "sourceCommit", "status", "version"], "runtime stage");
  if (stage.owner !== OWNER || stage.sourceCommit !== sourceCommit || stage.status !== "completed" || stage.version !== 1 || !Array.isArray(stage.assertions) || stage.assertions.length !== Object.keys(RUNTIME_ROWS).length) throw new Error("runtime stage is incomplete");
  const byId = new Map();
  for (const assertion of stage.assertions) {
    exactKeys(assertion, ["id", "passed", "proof"], "runtime assertion");
    if (!Object.hasOwn(RUNTIME_ROWS, assertion.id) || assertion.passed !== true || !assertion.proof || typeof assertion.proof !== "object" || Array.isArray(assertion.proof) || byId.has(assertion.id)) throw new Error("runtime assertion is invalid");
    byId.set(assertion.id, assertion.proof);
  }
  const predicates = {
    r06: (p) => p.nonstreamCompleted === true && p.streamLifecycle === true && p.abortClosed === true && p.healthAfterAbort === true,
    r19: (p) => p.primaryStatus === 429 && p.fallbackModel === "qwen-plan/deepseek-v4-flash-0731" && p.transport === "responses",
    r22: (p) => p.publishCommitted === true && p.rollbackReadable === true && p.acceptanceCatalogIsolated === true,
    r29: (p) => p.linuxRejected === true,
    r41: (p) => p.nodeOnly === true && p.health === true && p.noLiteLlm === true,
    r45: (p) => p.invalidCapability401 === true && p.validModels === true && p.streamLifecycle === true,
    r51: (p) => p.privateCatalog === true && p.publisherIsolated === true,
    r55: (p) => p.darwinAllowed === true && p.nodeStartArgs === true,
  };
  for (const id of Object.keys(RUNTIME_ROWS)) if (!predicates[id](byId.get(id))) throw new Error(`runtime assertion did not prove ${id}`);
  return stage;
}
function recordRuntimeRowsAtomically({ evidence, sourceCommit, artifact }) {
  const file = path.resolve(evidence), previous = existsSync(file) ? readFileSync(file) : null;
  try {
    readRuntimeStage(artifact, sourceCommit);
    const records = Object.keys(RUNTIME_ROWS).map((requirementId) => recordRuntimeEvidence({ evidence: file, sourceCommit, requirementId, artifact, reason: "isolated local runtime scenario completed" }));
    return records;
  } catch (error) {
    if (previous) writeFileSync(file, previous, { mode: 0o600 }); else rmSync(file, { force: true });
    throw error;
  }
}
function recordUiEvidence({ evidence, sourceCommit, requirementId, artifact, reason }) {
  const expected = UI_ROWS[requirementId]; if (!expected) throw new Error("UI evidence requirement is not allowed");
  const row = taskRow(requirementId, expected); return recordAcceptanceEvidence({ ...row, state: "passed", reason: safeText(reason), artifact: localPath(path.dirname(path.resolve(evidence)), artifact, "UI artifact"), sourceCommit }, path.resolve(evidence));
}
function recordVisualEvidence({ evidence, sourceCommit, requirementId, artifact }) {
  const row = taskRow(requirementId, VISUALS[Object.keys(VISUALS).find((kind) => VISUALS[kind].requirementId === requirementId)]?.themeId);
  return recordAcceptanceEvidence({ ...row, state: "passed", reason: "visual inspection completed; screenshot and inspection metadata are indexed by the visual report", artifact: localPath(path.dirname(path.resolve(evidence)), artifact, "visual report"), sourceCommit }, path.resolve(evidence));
}
/** Publish the complete Task3 local evidence set only after the worker has
 * stopped.  Restoring the previous evidence document makes this an all-or-
 * nothing generation boundary rather than a row-by-row green ledger. */
function recordFinalTask3Evidence({ evidence, sourceCommit, runtimeArtifact, browserArtifact, swiftArtifact, visualArtifact }) {
  const file = path.resolve(evidence), previous = existsSync(file) ? readFileSync(file) : null;
  try {
    readRuntimeStage(runtimeArtifact, sourceCommit);
    const browser = readCompletedSessionArtifact(path.dirname(path.dirname(browserArtifact)), "browser", sourceCommit);
    const swift = readCompletedSessionArtifact(path.dirname(path.dirname(swiftArtifact)), "swift", sourceCommit);
    const visual = readVisualReport(path.dirname(path.dirname(visualArtifact)), sourceCommit);
    if (browser !== browserArtifact || swift !== swiftArtifact || visual !== visualArtifact) throw new Error("final reports are not the owned Task3 reports");
    if (finalTask3RequirementIds().length !== 17) throw new Error("Task3 final evidence row contract is incomplete");
    const generation = beginFinalEvidence({ evidence: file, sourceCommit });
    for (const requirementId of Object.keys(RUNTIME_ROWS)) recordRuntimeEvidence({ evidence: file, sourceCommit, requirementId, artifact: runtimeArtifact, reason: "isolated local runtime scenario completed" });
    for (const requirementId of ["r24", "r35", "r59"]) recordUiEvidence({ evidence: file, sourceCommit, requirementId, artifact: browserArtifact, reason: "isolated browser write session completed and inspected" });
    recordUiEvidence({ evidence: file, sourceCommit, requirementId: "r47", artifact: swiftArtifact, reason: "isolated Swift session completed and inspected" });
    for (const requirementId of new Set(Object.values(VISUALS).map((value) => value.requirementId))) recordVisualEvidence({ evidence: file, sourceCommit, requirementId, artifact: visualArtifact });
    return generation;
  } catch (error) {
    if (previous) writeFileSync(file, previous, { mode: 0o600 }); else rmSync(file, { force: true });
    throw error;
  }
}

function visualReportPath(root) { return inside(root, path.join(root, "evidence", "visual-report.json"), "visual report"); }
function appendVisualReport(root, record) {
  const file = visualReportPath(root); let prior = [];
  if (existsSync(file)) {
    const entry = privateIdentity(file, "visual report");
    const value = JSON.parse(readPrivateNoFollow(file, entry, "visual report"));
    if (!Array.isArray(value?.records)) throw new Error("visual report schema is invalid");
    prior = value.records;
  }
  if (prior.some((value) => value?.kind === record.kind && value?.sourceCommit === record.sourceCommit)) throw new Error("visual record for this kind and source commit already exists");
  privateJsonReplace(file, { owner: OWNER, sourceCommit: record.sourceCommit, records: [...prior, record] });
  return file;
}
function pendingSessionStartedAt(root, kind, sourceCommit, runtimeId) {
  const file = inside(root, path.join(root, `${kind}-session.json`), `${kind} pending session`), entry = privateIdentity(file, `${kind} pending session`);
  const value = JSON.parse(readPrivateNoFollow(file, identity(entry), `${kind} pending session`));
  if (value?.owner !== OWNER || value?.sourceCommit !== sourceCommit || value?.status !== "pending_manual_session" || value?.runtimeId !== runtimeId || !Number.isFinite(Date.parse(value.captureStartedAt))) throw new Error(`${kind} session was not started by the active runtime`);
  return value.captureStartedAt;
}
function pendingBrowserVisualSession(root, handle, sourceCommit, artifact) {
  const file = inside(root, path.join(root, "browser-session.json"), "browser pending session");
  if (existsSync(file)) return pendingSessionStartedAt(root, "browser", sourceCommit, handle.runtimeId);
  const source = fingerprintFile(canonicalArtifact(handle.captureRoots.browser, artifact, "browser visual source capture"), "browser visual source capture");
  if (source.mtimeMs < handle.router.startedAt) throw new Error("browser visual source artifact predates the active runtime");
  const captureStartedAt = new Date(source.mtimeMs).toISOString();
  privateJsonReplace(file, { owner: OWNER, sourceCommit, runtimeId: handle.runtimeId, captureStartedAt, status: "pending_manual_session", profile: path.relative(handle.captureRoots.browser, handle.profile), url: `http://127.0.0.1:${handle.router.port}` });
  return captureStartedAt;
}
export function completedSessionArtifact(root, captureRoot, kind, sourceCommit, runtimeId, runtimeStartedAt, artifact, reviewer, inspected, captureStartedAt = pendingSessionStartedAt(root, kind, sourceCommit, runtimeId)) {
  if (typeof reviewer !== "string" || !reviewer.trim() || !Array.isArray(inspected) || !inspected.length) throw new Error(`${kind} completed session requires reviewer and non-empty inspection metadata`);
  for (const item of [reviewer, ...inspected]) safeText(item);
  const report = inside(root, path.join(root, "evidence", `${kind}-session-report.json`), `${kind} session report`);
  if (!/^worker-[0-9a-f]{16}$/.test(String(runtimeId || "")) || !Number.isFinite(runtimeStartedAt)) throw new Error("completed session must bind the active worker runtime");
  const captures = checkedCapture(root, captureRoot, artifact, `${kind}-session`, captureStartedAt);
  const sidecars = kind === "browser" ? browserSidecarCaptures(root, captureRoot, artifact, sourceCommit, runtimeId, captureStartedAt) : undefined;
  privateJsonReplace(report, { owner: OWNER, sourceCommit, runtimeId, runtimeStartedAt, captureStartedAt, status: "completed", kind, sourceCapture: captures.sourceCapture, archiveCapture: captures.archiveCapture, ...(sidecars ? { sidecars } : {}), reviewer, inspected });
  return report;
}
export function readCompletedSessionArtifact(root, kind, sourceCommit, expectedRuntime) {
  const file = inside(root, path.join(root, "evidence", `${kind}-session-report.json`), `${kind} session report`);
  const entry = privateIdentity(file, `${kind} session report`);
  const value = JSON.parse(readPrivateNoFollow(file, identity(entry), `${kind} session report`));
  exactKeys(value, ["archiveCapture", "captureStartedAt", "inspected", "kind", "owner", "reviewer", "runtimeId", "runtimeStartedAt", "sourceCapture", "sourceCommit", "status", ...(kind === "browser" ? ["sidecars"] : [])], `${kind} session report`);
  if (value.owner !== OWNER || value.kind !== kind || value.sourceCommit !== sourceCommit || value.status !== "completed" || !/^worker-[0-9a-f]{16}$/.test(value.runtimeId) || !Number.isFinite(value.runtimeStartedAt) || !Number.isFinite(Date.parse(value.captureStartedAt)) || typeof value.reviewer !== "string" || !value.reviewer.trim() || !Array.isArray(value.inspected) || !value.inspected.length) throw new Error(`${kind} session report is incomplete`);
  if (expectedRuntime && (value.runtimeId !== expectedRuntime.runtimeId || value.runtimeStartedAt !== expectedRuntime.router.startedAt)) throw new Error(`${kind} session report is not bound to the active runtime`);
  for (const [name, capture] of Object.entries({ sourceCapture: value.sourceCapture, archiveCapture: value.archiveCapture })) exactKeys(capture, ["mtimeMs", "path", "sha256"], `${kind} ${name}`);
  const expectedCaptureRoot = expectedRuntime?.captureRoots?.[kind];
  if (expectedCaptureRoot) {
    const relative = path.relative(expectedCaptureRoot, value.sourceCapture.path);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${kind} source capture is not in its runtime capture root`);
  }
  if (value.sourceCapture.mtimeMs < Date.parse(value.captureStartedAt)) throw new Error(`${kind} source capture predates its pending session`);
  const archive = value.archiveCapture;
  const actual = fingerprintFile(canonicalArtifact(root, archive.path, `${kind} archived capture`), `${kind} archived capture`);
  if (actual.path !== archive.path || actual.sha256 !== archive.sha256 || archive.sha256 !== value.sourceCapture.sha256) throw new Error(`${kind} archived capture changed after review`);
  if (kind === "browser") {
    validateRecordedBrowserSidecars(root, value.sidecars, value);
    for (const [sidecarKind, sidecar] of Object.entries(value.sidecars)) {
      const sourceRelative = path.relative(expectedCaptureRoot || path.dirname(sidecar.sourceCapture.path), sidecar.sourceCapture.path);
      if (expectedCaptureRoot && (!sourceRelative || sourceRelative === ".." || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative))) throw new Error(`browser ${sidecarKind} sidecar source is outside the runtime capture root`);
    }
  }
  return file;
}
function readVisualReport(root, sourceCommit) {
  const file = visualReportPath(root), entry = privateIdentity(file, "visual report");
  const value = JSON.parse(readPrivateNoFollow(file, identity(entry), "visual report"));
  exactKeys(value, ["owner", "records", "sourceCommit"], "visual report");
  if (value.owner !== OWNER || value.sourceCommit !== sourceCommit || !Array.isArray(value.records) || value.records.length !== Object.keys(VISUALS).length) throw new Error("visual report is incomplete");
  const seen = new Set();
  for (const record of value.records) {
    const browserRecord = String(record?.kind || "").startsWith("browser-") || record?.kind === "testing-evidence";
    exactKeys(record, ["appearance", "captureStartedAt", "inspected", "issues", "kind", "requirementId", "reviewer", "runtimeId", "screenshot", "sourceCommit", "themeId", "verdict", "viewport", ...(browserRecord ? ["sidecars"] : [])], "visual report record");
    const validated = validateVisualRecord({ ...record, artifact: record?.screenshot?.path });
    if (validated.sourceCommit !== sourceCommit || validated.screenshot.sha256 !== record?.screenshot?.sha256 || validated.screenshot.mtimeMs !== record?.screenshot?.mtimeMs || seen.has(validated.kind)) throw new Error("visual report record changed after review");
    if (browserRecord) validateRecordedBrowserSidecars(root, record.sidecars, record);
    seen.add(validated.kind);
  }
  if (seen.size !== Object.keys(VISUALS).length) throw new Error("visual report is incomplete");
  return file;
}
export function verifiedSwiftBundle(bundle, sourceCommit, { manifestPath = path.join(ROOT, "generated", "acceptance", "task1-build", "acceptance-build.json") } = {}) {
  const manifestEntry = privateIdentity(manifestPath, "Task1 build manifest"), manifest = JSON.parse(readPrivateNoFollow(manifestPath, manifestEntry, "Task1 build manifest"));
  if (manifest?.sourceCommit !== sourceCommit || manifest?.buildOnly !== true || typeof manifest.buildRoot !== "string" || typeof manifest.bundlePath !== "string") throw new Error("Swift bundle manifest is not bound to this source commit");
  const expected = realpathSync(manifest.bundlePath), actual = realpathSync(bundle), buildRoot = realpathSync(manifest.buildRoot);
  if (actual !== expected || path.relative(buildRoot, actual).startsWith("..") || actual === "/Applications/Model Router.app") throw new Error("Swift bundle is not the Task1 isolated build artifact");
  return actual;
}

export function validateVisualRecord({ kind, artifact, sourceCommit, runtimeId, captureStartedAt, verdict, viewport, appearance, reviewer, inspected, issues, sidecars }) {
  const expected = VISUALS[kind]; if (!expected || verdict !== "passed" || !/^[0-9a-f]{40}$/.test(String(sourceCommit || ""))) throw new Error("invalid visual record");
  if (typeof viewport !== "string" || !/^\d{2,5}x\d{2,5}$/.test(viewport) || typeof reviewer !== "string" || !reviewer.trim() || !Array.isArray(inspected) || !inspected.length || !Array.isArray(issues) || (appearance && appearance !== expected.appearance)) throw new Error("visual record requires non-empty inspection metadata");
  const resolved = fingerprintFile(artifact, "visual artifact");
  for (const value of [...inspected, ...issues, reviewer, viewport]) safeText(value);
  if (!/^worker-[0-9a-f]{16}$/.test(String(runtimeId || ""))) throw new Error("visual record runtime binding is invalid");
  if (!Number.isFinite(Date.parse(captureStartedAt))) throw new Error("visual capture timestamp is invalid");
  return { ...expected, kind, screenshot: resolved, sourceCommit, ...(runtimeId ? { runtimeId } : {}), ...(captureStartedAt ? { captureStartedAt } : {}), ...(sidecars ? { sidecars } : {}), verdict, viewport, appearance: appearance || expected.appearance, reviewer, inspected: [...inspected], issues: [...issues] };
}

export async function startAcceptanceRuntime(env, { sourceCommit = env?.sourceCommit, runtimeFactory = createLocalRuntime, operations = {} } = {}) {
  assertIsolatedEnvironment(env); if (sourceCommit !== env.sourceCommit) throw new Error("runtime source commit mismatch");
  if (existsSync(env.sourceRoot)) throw new Error("runtime acceptance requires a fresh explicit root");
  const operation = {
    acquireLease: acquireIsolationLease,
    captureRoot: runtimeCaptureRoot,
    createControlServer,
    removeCaptureRoots,
    unlink: unlinkSync,
    ...operations,
  };
  let runtime, callbacks, release, control, handshakePath, captureRoots, cleaned = false;
  const closeControl = async () => {
    if (!control) return;
    await new Promise((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
  };
  const settle = async () => {
    if (cleaned) return; cleaned = true;
    const failures = [];
    try { await runtime?.dispose?.(); } catch (error) { failures.push(error); }
    try { await closeControl(); } catch (error) { failures.push(error); }
    for (const file of [controlPath(env.root), handshakePath, handlePath(env.root)].filter(Boolean)) try { operation.unlink(file); } catch (error) { if (error?.code !== "ENOENT") failures.push(error); }
    try { if (captureRoots) operation.removeCaptureRoots(captureRoots); } catch (error) { failures.push(error); }
    try { release?.(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "direct runtime cleanup failed");
  };
  try {
    runtime = await runtimeFactory(env, { sourceCommit });
    callbacks = runtimeCallbacksFor(env) || runtime.callbacks;
    await callbacks.prerequisites(env); await callbacks.install(env); const started = await callbacks.start(env); const health = await callbacks.health(env);
    if (!health?.ok) throw new Error("isolated Router health is not OK");
    release = operation.acquireLease(env.root, env.target.ports);
    const runtimeId = `runtime-${randomBytes(8).toString("hex")}`, token = randomBytes(32).toString("hex"); handshakePath = path.join(env.root, "runtime-handshake"); captureRoots = { browser: operation.captureRoot(env.root, runtimeId, "browser"), swift: operation.captureRoot(env.root, runtimeId, "swift") }; const profile = inside(captureRoots.browser, path.join(captureRoots.browser, "profile"), "runtime browser profile");
    privateJson(handshakePath, { version: 1, runtimeId, token });
    control = await operation.createControlServer(env, runtimeId, token, { protocol: async () => { throw new Error("direct API runtime has no Task3 fixture stage"); } }, settle);
    const leaseInfo = isolationLeasePath(env.target.ports), lease = lstatSync(leaseInfo.lock), socket = lstatSync(controlPath(env.root));
    const handle = writeHandle({ owner: OWNER, sourceCommit, root: env.root, handlePath: handlePath(env.root), runtimeId, socket: controlPath(env.root), socketIdentity: identity(socket), handshake: { path: handshakePath, identity: privateIdentity(handshakePath, "runtime handshake") }, router: { pid: started.pid, workerPid: process.pid, startedAt: Date.now(), port: env.target.ports.router, label: env.target.routerLabel, routerIdentity: psIdentity(started.pid), workerIdentity: psIdentity(process.pid) }, lease: { path: leaseInfo.lock, normalized: leaseInfo.normalized, identity: identity(lease), ports: Object.values(env.target.ports) }, captureRoots, profile, artifacts: { report: path.join(env.evidenceRoot, "runtime.json") } });
    // Keep the persisted handle schema closed.  API-only convenience hooks are
    // deliberately non-enumerable, so serialisation and validation cannot
    // accidentally carry a capability or a process object into evidence.
    return Object.defineProperties({ ...handle }, {
      runtime: { value: { ...runtime, dispose: settle }, enumerable: false },
      callbacks: { value: callbacks, enumerable: false },
      env: { value: env, enumerable: false },
    });
  } catch (error) {
    try { await settle(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "runtime startup and cleanup failed"); }
    throw error;
  }
}

function task3CatalogFixture() {
  // Task3's isolated catalog uses two different local providers so the
  // production failover eligibility rule (never retry the exhausted provider)
  // is exercised while both hops retain the Responses transport.  These are
  // TEST_NODE_ROUTE_FIXTURE routes and cannot contact either real service.
  return { models: ["deepseek/deepseek-v4-flash", "qwen-plan/deepseek-v4-flash-0731"].map((slug) => ({ slug, base_instructions: "", model_messages: { instructions_template: "" }, supports_parallel_tool_calls: false, provider: slug.split("/", 1)[0] })) };
}
function task3GenerationArtifacts(label) {
  const slug = `router/${label}`, catalog = { models: [{ slug, base_instructions: "Task3 local fixture", model_messages: { instructions_template: "Task3 local fixture" }, supports_parallel_tool_calls: false }] };
  const route = { slug, provider: "router", upstreamModel: "router-model", effectiveTransport: "openai-responses", toolDialect: "responses-functions", requestProfile: "router", reasoningDisplayMode: "raw-preserve", effectiveFinalReasoningShape: "raw-content", purpose: "primary" };
  const models = { version: 1, models: [{ slug, provider: route.provider, upstreamModel: route.upstreamModel, effectiveTransport: route.effectiveTransport, toolDialect: route.toolDialect, reasoningDisplayMode: route.reasoningDisplayMode, effectiveFinalReasoningShape: route.effectiveFinalReasoningShape, declaredFinalReasoningShape: "raw-content", rolloutState: "stable", purpose: route.purpose, routable: true, listed: true, visible: true }] };
  return { "merged-models.json": catalog, "routed-models.json": catalog, "node-routes.json": { version: 1, routes: [route] }, "control-models.json": models, "swift-models.json": models, "browser-models.json": models };
}
function exerciseCatalogGeneration(env) {
  const generationsDir = inside(env.root, path.join(env.stateRoot, "task3-catalog-generations"), "Task3 catalog generations");
  const published = publishCatalogGeneration({ files: task3GenerationArtifacts("published"), generationsDir, legacyPaths: {} });
  const current = path.join(generationsDir, "current");
  if (!lstatSync(current).isSymbolicLink() || !lstatSync(path.join(current, "merged-models.json")).isFile()) throw new Error("catalog generation publish is not atomically readable");
  const before = readFileSync(path.join(current, "merged-models.json"));
  const base = createCatalogGenerationFileSystem();
  const failing = { ...base, rename(source, target) { if (path.basename(target) === "current") throw new Error("injected pointer failure"); return base.rename(source, target); } };
  let rolledBack = false; try { publishCatalogGeneration({ files: task3GenerationArtifacts("rollback"), generationsDir, legacyPaths: {}, operations: failing }); } catch { rolledBack = true; }
  if (!rolledBack || !before.equals(readFileSync(path.join(current, "merged-models.json")))) throw new Error("catalog generation rollback changed readable current pointer");
  return { publishCommitted: published?.path === path.join(generationsDir, published.generation), rollbackReadable: true, acceptanceCatalogIsolated: path.relative(env.root, generationsDir) && !path.relative(env.root, env.acceptanceCatalogPath).startsWith("..") };
}
function writeTask3Catalog(env) {
  if (existsSync(env.acceptanceCatalogPath) && lstatSync(env.acceptanceCatalogPath).isSymbolicLink()) throw new Error("Task3 catalog cannot be a symlink");
  privateJson(env.acceptanceCatalogPath, task3CatalogFixture());
  const entry = lstatSync(env.acceptanceCatalogPath);
  if (!privateRegularFile(env.acceptanceCatalogPath, entry)) throw new Error("Task3 catalog is not private");
  return entry;
}
function writeFixtureCredential(env, provider) {
  // `selectedConfiguredListedModels()` deliberately considers only persistent
  // credentials when it ranks a failover.  Give the isolated Qwen fixture a
  // fresh throwaway capability so that production selection logic can see the
  // candidate; the spawned Router still receives only its loopback base URL.
  if (provider !== "qwen-plan") throw new Error("unsupported Task3 fixture credential");
  const file = inside(env.root, path.join(env.stateRoot, "qwen-plan-api-key.secret"), "fixture credential");
  writeFileSync(file, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
function assertTask3Catalog(env) {
  const entry = lstatSync(env.acceptanceCatalogPath);
  if (entry.isSymbolicLink() || !privateRegularFile(env.acceptanceCatalogPath, entry)) throw new Error("Task3 acceptance catalog is not a private regular file");
  if (JSON.stringify(JSON.parse(readPrivateNoFollow(env.acceptanceCatalogPath, identity(entry), "Task3 acceptance catalog"))) !== JSON.stringify(task3CatalogFixture())) throw new Error("Task3 acceptance catalog changed");
  return entry;
}
function nodeOnlyIdentity(snapshot, sourceRoot) {
  const command = execFileSync("ps", ["-p", String(snapshot.pid), "-o", "command="], { encoding: "utf8" });
  if (!command.includes(path.join(sourceRoot, "src", "start.mjs")) || /(?:lite|llm|python|tauri)/i.test(command)) throw new Error("isolated runtime is not the expected Node router");
}

function readJsonRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve({}); }
    });
  });
}
async function loopbackServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}
async function closeLoopback(server) { if (server?.listening) await new Promise((resolve) => server.close(resolve)); }
async function freeLoopbackPort() {
  const server = await loopbackServer((_request, response) => response.end());
  const port = server.address().port;
  await closeLoopback(server);
  return port;
}
async function assertLoopbackPortFree(port, name) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  await closeLoopback(server);
  if (server.listening) throw new Error(`Task3 protocol lab ${name} port remains bound`);
}
/** 4200 can be occupied by an unrelated local developer service.  The Task3
 * claim is narrower and checkable: no acceptance-owned process/socket may be
 * that listener, and every acceptance command stays Node-only. */
export function noOwnedLiteLlmOr4200({ ownerPids = [], ownedPids = [], commands = [] } = {}) {
  const owners = new Set(ownerPids.filter((value) => Number.isInteger(value) && value > 0));
  if (ownedPids.some((value) => owners.has(value))) return false;
  return !commands.some((value) => /(?:litellm|python|\b4200\b)/i.test(String(value || "")));
}
function listenerPids(port) {
  try { return String(execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" })).split(/\s+/).map(Number).filter((value) => Number.isInteger(value) && value > 0); } catch { return []; }
}
function labSse({ tool = false, reasoning = false, truncated = false } = {}) {
  const call = { type: "function_call", id: "fc_lab", call_id: "call_lab", name: "acceptance_tool", arguments: "{}" };
  const reasoningItem = { type: "reasoning", id: "rs_lab", status: "completed", summary: [{ type: "summary_text", text: "local" }], content: [] };
  const message = { type: "message", id: "msg_lab", role: "assistant", status: "completed", content: [{ type: "output_text", text: "local" }] };
  const output = tool ? [call] : reasoning ? [reasoningItem, message] : [message];
  const events = tool
    ? [{ type: "response.created", response: { id: "resp_lab" } }, { type: "response.output_item.added", item: { ...call, arguments: "" } }, { type: "response.function_call_arguments.delta", item_id: call.id, delta: "{}" }, { type: "response.function_call_arguments.done", item_id: call.id, arguments: "{}" }, { type: "response.output_item.done", item: call }, { type: "response.completed", response: { id: "resp_lab", output, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }]
    : reasoning
      ? (truncated
        ? [{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: reasoningItem.id, summary: [], content: [] } }, { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: reasoningItem.id, summary_index: 0, delta: "partial" }]
        : [{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: reasoningItem.id, summary: [], content: [] } }, { type: "response.reasoning_summary_part.added", output_index: 0, item_id: reasoningItem.id, summary_index: 0, part: { type: "summary_text", text: "" } }, { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: reasoningItem.id, summary_index: 0, delta: "local" }, { type: "response.completed", response: { id: "resp_lab", output: [reasoningItem], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }])
      : [{ type: "response.created", response: { id: "resp_lab", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { ...output[0], status: "in_progress", content: [] } }, { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: output[0].id, part: { type: "output_text", text: "" } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: output[0].id, delta: "local" }, { type: "response.output_item.done", output_index: 0, item: output[0] }, { type: "response.completed", response: { id: "resp_lab", output, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } }];
  // Match the checked-in Responses oracle exactly: its parser receives the
  // event type from JSON `data`, not from a parallel SSE `event:` label.
  return `${events.map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join("")}data: [DONE]\n\n`;
}
function labJson({ reasoning = false, hybridReasoning = false, tool = false } = {}) {
  const output = tool
    ? [{ type: "function_call", id: "fc_lab", call_id: "call_lab", name: "acceptance_tool", arguments: "{}" }]
    : hybridReasoning
      ? [{ type: "reasoning", id: "rs_lab", summary: [{ type: "summary_text", text: "local" }], content: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "local" }] }]
    : reasoning
      ? [{ type: "reasoning", id: "rs_lab", summary: [], content: [{ type: "reasoning_text", text: "local" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "local" }] }]
    : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "local" }] }];
  return { id: "resp_lab", object: "response", status: "completed", output, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } };
}

/**
 * A deliberately small second Router composition used only by Task3.  Unlike
 * a unit fixture, it starts the materialized `src/router.mjs`, gives it a
 * fresh state directory and loopback-only upstreams, and observes only boolean
 * protocol predicates.  It never serialises requests, headers, prompts, or
 * credentials into Task3 evidence.
 */
async function exerciseProtocolLab(env) {
  const labRoot = inside(env.root, path.join(env.root, "protocol-lab", randomBytes(6).toString("hex")), "protocol lab root");
  const stateRoot = inside(env.root, path.join(labRoot, "state"), "protocol lab state");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const observations = { tool: false, forcedTool: false, forcedRequest: false, toolOutput: false, image: false, authoritativeUsage: false, canary: false, native: false, search: false, providerAuthorizationSafe: true, nativeAuthorizationSafe: true, providerAuthorizationKind: "none", nativeAuthorizationKind: "none" };
  let provider; let native; let child; let port; let providerPort; let nativePort; let childEnv; let step = "bootstrap";
  const closeChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
  };
  try {
    const adapter = path.join(env.sourceRoot, "src", "openai-responses-adapter.mjs");
    if (!sourceBytes(env.sourceCommit, "src/openai-responses-adapter.mjs").equals(readFileSync(adapter))) throw new Error("Task3 protocol lab adapter bytes do not match source commit");
    step = "provider"; provider = await loopbackServer(async (request, response) => {
      // Never persist the header.  The only upstream credential a child Router
      // may present here is the fixture value constructed in its closed env.
      const authorization = request.headers.authorization;
      observations.providerAuthorizationKind = authorization === "Bearer task3-loopback" ? "fixture" : authorization === undefined ? "none" : "other";
      if (request.method === "POST" && request.url === "/v1/responses") observations.providerAuthorizationSafe &&= protocolAuthorizationPredicates({ providerAuthorization: authorization }).providerAuthorizationSafe;
      if (request.method === "GET" && request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true })); return; }
      if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
      const body = await readJsonRequest(request), input = JSON.stringify(body.input || "");
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      observations.tool ||= hasTools;
      // The adapter lowers a required Responses choice to `auto` upstream and
      // enforces the required boundary while it relays the response.  Record
      // the exact forced probe only when that routed request reached this
      // upstream with its tool declaration; a later non-tool response must
      // still become the Router's public 422.
      const forcedBoundaryRequest = input.includes("FORCED_BOUNDARY") && hasTools;
      observations.forcedTool ||= forcedBoundaryRequest;
      observations.forcedRequest ||= forcedBoundaryRequest;
      observations.toolOutput ||= JSON.stringify(body).includes("function_call_output");
      observations.image ||= input.includes("input_image");
      observations.canary ||= body.model === "qwen3.7-max";
      if (input.includes("PUBLIC_RETRY")) { response.writeHead(429, { "content-type": "application/json", "retry-after": "3" }).end(JSON.stringify({ error: { type: "rate_limit_error", message: "retry" } })); return; }
      if (body.stream === true) {
        const reply = labSse({ tool: input.includes("TOOL_CALL"), reasoning: input.includes("REASONING_STREAM") || input.includes("TRUNCATED_REASONING"), truncated: input.includes("TRUNCATED_REASONING") });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(reply); return;
      }
      observations.authoritativeUsage = true;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(labJson({ reasoning: true, hybridReasoning: String(body.model || "").startsWith("qwen") })));
    });
    step = "native"; native = await loopbackServer(async (request, response) => {
      // Native loopback must not receive the caller capability or any parent
      // session credential.  It needs no Authorization header at this boundary.
      const nativeAuthorization = request.headers.authorization;
      observations.nativeAuthorizationKind = nativeAuthorization === undefined ? "none" : "other";
      observations.nativeAuthorizationSafe &&= protocolAuthorizationPredicates({ nativeAuthorization }).nativeAuthorizationSafe;
      const isSearch = request.url?.startsWith("/backend-api/codex/alpha/search");
      const isNative = request.url === "/backend-api/codex/responses";
      observations.search ||= Boolean(isSearch); observations.native ||= Boolean(isNative);
      if (!isSearch && !isNative) { response.writeHead(404).end(); return; }
      await readJsonRequest(request);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(isSearch ? { output: "local", results: [] } : labJson()));
    });
    step = "registry"; const [{ MODEL_BY_SLUG }, { registryFingerprint }, { PROTOCOL_PROOF_VERIFIER_VERSION }] = await Promise.all([
      import(pathToFileURL(path.join(env.sourceRoot, "src", "model-registry.mjs")).href),
      import(pathToFileURL(path.join(env.sourceRoot, "src", "protocol-proof.mjs")).href),
      import(pathToFileURL(path.join(env.sourceRoot, "src", "protocol-proof-verifier.mjs")).href),
    ]);
    const deepseek = MODEL_BY_SLUG.get("deepseek/deepseek-v4-flash"), qwen = MODEL_BY_SLUG.get("qwen-plan/qwen3.7-max"), forcedModel = MODEL_BY_SLUG.get("qwen-plan-responses/glm-5.2");
    if (!deepseek || !qwen || !forcedModel) throw new Error("Task3 protocol lab route models are unavailable");
    const route = (model, shape) => ({ ...model, effectiveFinalReasoningShape: shape, routable: true, listed: true, visible: true });
    const proof = { slug: qwen.slug, provider: qwen.provider, upstreamModel: qwen.upstreamModel, transport: qwen.effectiveTransport, toolDialect: qwen.toolDialect, requestProfile: qwen.requestProfile, verdict: "passing", verifierVersion: PROTOCOL_PROOF_VERIFIER_VERSION, fingerprint: registryFingerprint(qwen, PROTOCOL_PROOF_VERIFIER_VERSION), measuredFinalReasoningShape: "hybrid-summary", verifiedAt: "2026-08-25T00:00:00.000Z" };
    writeFileSync(path.join(stateRoot, "enabled-providers.json"), JSON.stringify({ version: 1, providers: ["deepseek", "qwen-plan"] }), { mode: 0o600 });
    writeFileSync(path.join(stateRoot, "deepseek-api-key.secret"), "task3-loopback\n", { mode: 0o600 });
    writeFileSync(path.join(stateRoot, "qwen-plan-api-key.secret"), "task3-loopback\n", { mode: 0o600 });
    writeFileSync(path.join(stateRoot, "experimental-models.json"), JSON.stringify({ version: 1, models: [qwen.slug] }), { mode: 0o600 });
    writeFileSync(path.join(stateRoot, "protocol-proofs.json"), JSON.stringify({ version: 1, revision: 1, revisions: {}, proofs: { [qwen.slug]: proof } }), { mode: 0o600 });
    writeFileSync(path.join(stateRoot, "node-routes.json"), JSON.stringify({ version: 1, routes: [route(deepseek, "raw-content"), route(qwen, "hybrid-summary"), route(forcedModel, "raw-content")] }), { mode: 0o600 });
    step = "spawn"; port = await freeLoopbackPort();
    const callerKey = randomBytes(32).toString("hex"); providerPort = provider.address().port; nativePort = native.address().port;
    childEnv = protocolLabEnvironment({ root: labRoot, stateRoot, port, providerPort, nativePort, callerKey });
    child = spawn(process.execPath, [path.join(env.sourceRoot, "src", "router.mjs")], { cwd: env.sourceRoot, env: childEnv, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.resume();
    const base = `http://127.0.0.1:${port}/_codex-router/${callerKey}/v1`;
    const readyUntil = Date.now() + 15_000;
    while (Date.now() < readyUntil) { if (child.exitCode !== null) throw new Error(`Task3 protocol lab router exited (${child.exitCode})`); try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((resolve) => setTimeout(resolve, 40)); }
    if (child.exitCode !== null) throw new Error("Task3 protocol lab router did not start");
    const routed = (body, { abort = false, headers = {} } = {}) => new Promise((resolve, reject) => {
      const endpoint = new URL(`${base}/responses`);
      let receivedResponse = false;
      const request = http.request({ host: endpoint.hostname, port: endpoint.port, path: endpoint.pathname, method: "POST", headers: { authorization: `Bearer ${callerKey}`, "content-type": "application/json", ...headers } }, (response) => {
        receivedResponse = true;
        let text = ""; response.setEncoding("utf8");
        if (abort) { response.once("error", () => {}); return; }
        response.on("data", (chunk) => { text += chunk; });
        let settled = false;
        const done = () => { if (settled) return; settled = true; resolve({ status: response.statusCode, headers: new Headers(response.headers), body: text }); };
        response.once("end", done);
        // A repaired truncation stream deliberately terminates the HTTP body
        // after writing its public `response.failed` terminal frame.  Capture
        // what reached the client and let the explicit terminal predicate,
        // rather than Node's transport-level `complete` flag, decide it.
        response.once("close", () => done());
        response.once("error", () => done());
      });
      if (abort) { setTimeout(() => { request.destroy(); resolve({ status: 200, aborted: true }); }, 300); }
      request.setTimeout(5_000, () => request.destroy(new Error("Task3 protocol lab request timed out")));
      request.once("error", (error) => { if (!receivedResponse) resolve({ status: 0, headers: new Headers(), body: "", transportError: safeText(error?.message || "transport error") }); }); request.end(JSON.stringify(body));
    });
    const tool = [{ type: "function", name: "acceptance_tool", parameters: { type: "object", properties: {}, additionalProperties: false } }];
    step = "nonstream"; const nonstream = await routed({ model: deepseek.slug, stream: false, input: "reasoning" });
    step = "stream"; const stream = await routed({ model: deepseek.slug, stream: true, input: "reasoning stream" });
    step = "tool-call"; const toolCall = await routed({ model: deepseek.slug, stream: true, input: "TOOL_CALL", tools: tool, tool_choice: "required" });
    step = "forced-tool-boundary"; const forced = await routed({ model: deepseek.slug, stream: true, input: "FORCED_BOUNDARY", tools: tool, tool_choice: "required" });
    step = "continuation"; const continuation = await routed({ model: deepseek.slug, stream: false, input: [{ type: "function_call_output", call_id: "call_lab", output: "local" }] });
    step = "image"; const image = await routed({ model: deepseek.slug, stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] });
    step = "public-error"; const publicError = await routed({ model: deepseek.slug, stream: false, input: "PUBLIC_RETRY" });
    step = "native-bypass"; const nativeResponse = await routed({ model: "gpt-native-task3", stream: false, input: "native" }, { headers: { "chatgpt-account-id": "task3", "x-codex-installation-id": "task3" } });
    step = "search-forwarding"; const searchPayload = zstdCompressSync(Buffer.from(JSON.stringify({ id: "task3-search", model: "gpt-native-task3", commands: { search_query: [{ q: "local" }] }, settings: { external_web_access: true } })));
    let search; try { search = await fetch(`${base}/alpha/search?source=task3`, { method: "POST", headers: { authorization: `Bearer ${callerKey}`, "content-type": "application/json", "content-encoding": "zstd", "chatgpt-account-id": "task3", "x-codex-installation-id": "task3", "x-codex-turn-metadata": "task3" }, body: searchPayload }); } catch { search = { status: 0 }; }
    const childCommand = execFileSync("ps", ["-p", String(child.pid), "-o", "command="], { encoding: "utf8" });
    const noLiteLlm = childCommand.includes(path.join(env.sourceRoot, "src", "router.mjs")) && noOwnedLiteLlmOr4200({ ownerPids: listenerPids(4200), ownedPids: [process.pid, child.pid], commands: [process.argv.join(" "), childCommand] });
    // `provider-dispatch` reads the proof at request time.  Prove the deny
    // side first, then restore the exact matching proof and prove the canary
    // route can pass without reopening a process that could hide stale state.
    writeFileSync(path.join(stateRoot, "protocol-proofs.json"), JSON.stringify({ version: 1, revision: 2, revisions: {}, proofs: {} }), { mode: 0o600 });
    step = "canary-without-proof"; const canaryWithoutProof = await routed({ model: qwen.slug, stream: false, input: "canary-no-proof" });
    writeFileSync(path.join(stateRoot, "protocol-proofs.json"), JSON.stringify({ version: 1, revision: 3, revisions: {}, proofs: { [qwen.slug]: proof } }), { mode: 0o600 });
    step = "canary"; const canary = await routed({ model: qwen.slug, stream: false, input: "canary" });
    step = "reasoning-stream"; const reasoningStream = await routed({ model: qwen.slug, stream: true, input: "REASONING_STREAM" });
    step = "truncation"; let truncation;
    try { truncation = await routed({ model: qwen.slug, stream: true, input: "TRUNCATED_REASONING" }); } catch (error) { truncation = { status: 0, body: "", transportError: safeText(error?.message || "transport error") }; }
    const eventTypes = (body) => [...String(body || "").matchAll(/(?:^|\n)data: ([^\r\n]+)/g)].flatMap((match) => { try { const value = JSON.parse(match[1]); return typeof value?.type === "string" ? [value.type] : []; } catch { return []; } });
    const reasoningEvents = eventTypes(reasoningStream.body), reasoningAdded = reasoningEvents.indexOf("response.output_item.added"), summaryPart = reasoningEvents.indexOf("response.reasoning_summary_part.added"), summaryDelta = reasoningEvents.indexOf("response.reasoning_summary_text.delta"), completed = reasoningEvents.lastIndexOf("response.completed");
    const reasoningLifecycle = reasoningStream.status === 200 && reasoningAdded >= 0 && summaryPart > reasoningAdded && summaryDelta > summaryPart && completed > summaryDelta && /"type":"reasoning"/.test(reasoningStream.body) && /"status":"completed"/.test(reasoningStream.body);
    const truncationEvents = eventTypes(truncation.body), truncationTerminal = truncationEvents.some((type) => ["response.failed", "response.incomplete", "error"].includes(type));
    const predicates = {
      reasoning: nonstream.status === 200 && /"reasoning"/.test(nonstream.body) && stream.status === 200 && /response\.completed/.test(stream.body) && reasoningLifecycle && truncationTerminal,
      toolContinuation: toolCall.status === 200 && /function_call/.test(toolCall.body) && protocolAuthorizationPredicates({ forcedTool: observations.forcedTool, forcedRequest: observations.forcedRequest, forcedStatus: forced.status, forcedBody: forced.body }).forcedToolBoundary && continuation.status === 200 && observations.tool && observations.toolOutput,
      image: image.status === 200 && observations.image,
      authoritativeUsage: observations.authoritativeUsage && existsSync(path.join(stateRoot, "usage-events.jsonl")) && readFileSync(path.join(stateRoot, "usage-events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).some((line) => { try { const value = JSON.parse(line); return value?.inputTokens === 7 && value?.outputTokens === 3; } catch { return false; } }),
      publicError: publicError.status === 429 && publicError.headers.get("retry-after") === "3",
      canary: canaryWithoutProof.status === 404 && canary.status === 200 && observations.canary,
      nativeBypass: nativeResponse.status === 200 && observations.native,
      searchForwarding: search.status === 200 && observations.search,
      noLiteLlm,
      isolatedAuthorization: observations.providerAuthorizationSafe && observations.nativeAuthorizationSafe,
    };
    const failedPredicates = Object.entries(predicates).filter(([, passed]) => !passed).map(([name]) => name);
    if (failedPredicates.length) { privateJson(path.join(env.evidenceRoot, "protocol-lab-failure.json"), { owner: OWNER, sourceCommit: env.sourceCommit, status: "failed", stage: "predicate", failed: failedPredicates, statuses: { nonstream: nonstream.status, stream: stream.status, reasoningStream: reasoningStream.status, truncation: truncation.status, toolCall: toolCall.status, forced: forced.status, continuation: continuation.status, image: image.status, publicError: publicError.status, canaryWithoutProof: canaryWithoutProof.status, canary: canary.status, native: nativeResponse.status, search: search.status }, observations: { tool: observations.tool, forcedTool: observations.forcedTool, toolOutput: observations.toolOutput, providerAuthorizationKind: observations.providerAuthorizationKind, nativeAuthorizationKind: observations.nativeAuthorizationKind, reasoningLifecycle, truncationTerminal, reasoningEventTypes: reasoningEvents, truncationEventTypes: truncationEvents, ...(truncation.transportError ? { truncationTransportError: truncation.transportError } : {}) } }); step = "predicate"; throw new Error("Task3 protocol lab predicate failed"); }
    return predicates;
  } catch (error) {
    // A nested Router may include its caller capability in a low-level socket
    // error.  The stage name is enough for a closed acceptance diagnostic; do
    // not relay arbitrary child error text through the control socket.
    void error;
    throw new Error(`Task3 protocol lab ${step} failed`);
  } finally {
    await closeChild();
    await Promise.all([closeLoopback(provider), closeLoopback(native)]);
    await Promise.all([assertLoopbackPortFree(port, "Router"), assertLoopbackPortFree(providerPort, "provider"), assertLoopbackPortFree(nativePort, "native")]);
    if (existsSync(labRoot)) rmSync(labRoot, { recursive: true, force: true });
  }
}
async function stageWorkerProtocol({ env, callbacks, fixtureState, sourceCommit }) {
  const key = readInstalledCallerSecret(env), base = `http://${env.target.host}:${env.target.ports.router}/_codex-router/${key}/v1`;
  const artifact = inside(env.root, path.join(env.evidenceRoot, "runtime-stage.json"), "runtime stage artifact");
  const observations = [];
  const request = async (name, model, stream, { abort = false, payload = {} } = {}) => {
    const controller = abort ? new AbortController() : undefined;
    const response = await fetch(`${base}/responses`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, input: "local acceptance", stream, ...payload }), signal: controller?.signal });
    if (abort) {
      await response.body?.getReader().read(); controller.abort(); try { await response.text(); } catch {}
      const deadline = Date.now() + 2_000;
      while (Number(fixtureState.closedStreams || 0) < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (Number(fixtureState.closedStreams || 0) < 1) throw new Error("caller abort did not close the loopback stream");
      observations.push({ name, status: response.status, category: "caller_aborted", transport: "responses" }); return;
    }
    const text = await response.text(); observations.push({ name, status: response.status, category: response.ok ? "accepted" : "rejected", transport: "responses" }); return { response, text };
  };
  await callbacks.authenticate(env);
  const health = await callbacks.health(env); if (!health?.ok) throw new Error("runtime health failed before protocol scenarios");
  const denied = await fetch(`http://${env.target.host}:${env.target.ports.router}/_codex-router/invalid/v1/models`); if (denied.status !== 401) throw new Error("invalid caller capability did not receive 401");
  const models = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } }); const listed = (await models.json()).data?.map((model) => model.id).sort();
  if (!models.ok || JSON.stringify(listed) !== JSON.stringify(task3CatalogFixture().models.map((model) => model.slug).sort())) throw new Error("Task3 catalog was not published exactly");
  // The checked-in Task2 callback is the narrow oracle for a fully relayed
  // Responses lifecycle.  It validates the terminal frame against the stable
  // fixture without putting a second fetch/proxy in the observation path.
  const streaming = await callbacks.route(env, "responses");
  if (!streaming?.catalog || streaming.transport !== "responses") throw new Error("streaming Responses lifecycle failed");
  const nonstream = await request("reasoning-json", "deepseek/deepseek-v4-flash", false);
  if (!nonstream?.response.ok || JSON.parse(nonstream.text)?.status !== "completed") throw new Error("nonstream Responses scenario failed");
  await request("caller-abort", "deepseek/deepseek-v4-flash", true, { abort: true });
  const tool = { type: "function", name: "acceptance_tool", parameters: { type: "object", properties: {} } };
  const toolRequest = await request("forced-tool", "deepseek/deepseek-v4-flash", true, { payload: { tools: [tool], tool_choice: "required", reasoning: { effort: "low" } } });
  const imageRequest = await request("image-vision", "deepseek/deepseek-v4-flash", false, { payload: { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] } });
  const toolOutputRequest = await request("tool-output-continuation", "deepseek/deepseek-v4-flash", false, { payload: { input: [{ type: "function_call_output", call_id: "call_acceptance", output: "ok" }] } });
  // These requests deliberately exercise the public Router boundary.  Some
  // model capabilities are refused by the selected DeepSeek fixture; the
  // detailed tools/vision oracle remains the checked-in specialist fixture.
  // Do not turn a known capability refusal into synthetic passed evidence.
  void toolRequest; void imageRequest; void toolOutputRequest;
  const afterAbort = await callbacks.health(env); if (!afterAbort?.ok) throw new Error("router health changed after caller abort");

  const catalogGeneration = exerciseCatalogGeneration(env);
  if (!sameIdentity(assertTask3Catalog(env), assertTask3Catalog(env))) throw new Error("Task3 acceptance catalog changed");
  let mutated = false; try { runMacOSMutation("Task3 runtime fixture", () => { mutated = true; }, { platform: "linux" }); } catch (error) { if (error?.code !== "unsupported_platform") throw error; }
  if (mutated) throw new Error("non-macOS mutation was not rejected");
  let darwinMutation = false; runMacOSMutation("Task3 runtime fixture", () => { darwinMutation = true; }, { platform: "darwin" }); if (!darwinMutation) throw new Error("Darwin platform gate did not admit mutation");
  // The worker owns the live Node child; inspect its immutable process
  // identity rather than re-reading the tray installation (which is optional
  // for the headless runtime oracle and may not exist with --no-swift).
  const args = [process.execPath, path.join(env.sourceRoot, "src", "start.mjs")];
  if (args.some((arg) => /(?:lite|llm|python|4200)/i.test(String(arg)))) throw new Error("Node start arguments are invalid");

  const beforeAttempts = fixtureState.attempts.length; fixtureState.quotaModel = "deepseek-v4-flash";
  try {
    const fallback = await request("quota-fallback", "deepseek/deepseek-v4-flash", true);
    if (!fallback?.response.ok || !String(fallback.response.headers.get("content-type") || "").includes("text/event-stream")) throw new Error(`fallback did not complete on Responses transport (${fallback?.response?.status || 0})`);
  } finally { fixtureState.quotaModel = null; }
  const attempts = fixtureState.attempts.slice(beforeAttempts);
  if (attempts.length !== 2 || attempts[0]?.model !== "deepseek-v4-flash" || attempts[0]?.reason !== "quota" || attempts[1]?.model !== "deepseek-v4-flash-0731" || attempts[1]?.transport !== "responses") throw new Error("quota fallback did not make exactly primary then same-transport fallback attempts");
  assertTask3Catalog(env);
  const protocolLab = await exerciseProtocolLab(env);
  const assertion = (id, proof) => ({ id, passed: true, proof });
  privateJson(artifact, {
    owner: OWNER, sourceCommit, status: "completed", version: 1,
    assertions: [
      assertion("r06", { nonstreamCompleted: true, streamLifecycle: true, abortClosed: Number(fixtureState.closedStreams || 0) > 0, healthAfterAbort: true }),
      assertion("r19", { primaryStatus: 429, fallbackModel: "qwen-plan/deepseek-v4-flash-0731", transport: "responses" }),
      // publish/rollback are checked by the catalog-generation oracle too; the
      // runtime artifact records only observations made through this isolated
      // reader, not a hand-written list of requirements.
      assertion("r22", catalogGeneration),
      assertion("r29", { linuxRejected: true }),
      assertion("r41", { nodeOnly: true, health: true, noLiteLlm: protocolLab.noLiteLlm, protocolLab: true }),
      assertion("r45", { invalidCapability401: true, validModels: true, streamLifecycle: true }),
      assertion("r51", { privateCatalog: true, publisherIsolated: true }),
      assertion("r55", { darwinAllowed: true, nodeStartArgs: true }),
    ],
  });
  // The IPC acknowledgement is not evidence by itself.  Re-open the private
  // stage through the same closed validator before protocol can report done.
  readRuntimeStage(artifact, sourceCommit);
  return artifact;
}
async function protocol(handle) {
  const result = await controlRequest(handle, "protocol");
  if (!result?.ok || result?.stage !== "complete") throw new Error("runtime protocol IPC was rejected");
  return result;
}

export async function finalNonLiveAcceptance({ root, buildRoot, browserProfile, evidence, sourceCommit, task1ManifestPath = path.join(ROOT, "generated", "acceptance", "task1-build", "acceptance-build.json"), requireSwift = true, provenance = assertRuntimeCommandProvenance, run = {} }) {
  const absoluteRoot = path.resolve(root), evidenceFile = path.resolve(evidence), requestedBuildRoot = path.resolve(buildRoot), requestedProfile = path.resolve(browserProfile);
  const priorEvidence = existsSync(evidenceFile) ? readFileSync(evidenceFile) : null;
  let handle, committed = false, fresh = false, pending = false;
  try {
    provenance(sourceCommit);
    if (existsSync(absoluteRoot)) handle = run.activeHandle || (existsSync(handlePath(absoluteRoot)) ? readHandle(handlePath(absoluteRoot)) : undefined);
    if (!handle) {
      if (existsSync(absoluteRoot) && !run.start) throw new Error("final non-live acceptance root has no active runtime handle");
      fresh = true;
      handle = await (run.start || (async () => {
        const preflight = assertCliPreflight(absoluteRoot);
        const manifestPath = path.resolve(task1ManifestPath);
        const manifest = JSON.parse(readPrivateNoFollow(manifestPath, privateIdentity(manifestPath, "Task1 build manifest"), "Task1 build manifest"));
        if (path.resolve(manifest.buildRoot) !== requestedBuildRoot) throw new Error("final non-live build root is not the Task1 manifest build root");
        verifiedSwiftBundle(manifest.bundlePath, sourceCommit, { manifestPath });
        if (requestedProfile !== finalNonLiveBrowserProfile(preflight)) throw new Error("final non-live browser profile does not match the explicit worker plan");
        const env = createIsolatedEnvironment({ root: preflight, nonce: `final-${hash(preflight).slice(0, 16)}`, sourceCommit });
        return startAcceptanceWorker(env, { browserProfile: requestedProfile, requireSwift });
      }))();
    }
    if (!handle || handle.sourceCommit !== sourceCommit || path.resolve(handle.root) !== absoluteRoot) throw new Error("final non-live runtime handle is not bound to this invocation");
    if (requestedProfile !== handle.profile) throw new Error("final non-live browser profile must equal the active runtime profile");
    // The production path binds the supplied build root to Task1's checked-in
    // manifest.  A supplied start callback is a test seam and still has to
    // materialise/validate real reports before any final generation is opened.
    if (!run.start && !run.activeHandle && !fresh) {
      const manifestPath = path.resolve(task1ManifestPath);
      const manifest = JSON.parse(readPrivateNoFollow(manifestPath, privateIdentity(manifestPath, "Task1 build manifest"), "Task1 build manifest"));
      if (path.resolve(manifest.buildRoot) !== requestedBuildRoot) throw new Error("final non-live build root is not the Task1 manifest build root");
      verifiedSwiftBundle(manifest.bundlePath, sourceCommit, { manifestPath });
    }
    const ensurePending = (kind, extra) => {
      const file = inside(absoluteRoot, path.join(absoluteRoot, `${kind}-session.json`), `${kind} pending session`);
      if (existsSync(file)) { pendingSessionStartedAt(absoluteRoot, kind, sourceCommit, handle.runtimeId); return file; }
      privateJsonReplace(file, { owner: OWNER, sourceCommit, runtimeId: handle.runtimeId, captureStartedAt: new Date().toISOString(), status: "pending_manual_session", ...extra });
      return file;
    };
    mkdirSync(handle.profile, { recursive: true, mode: 0o700 });
    ensurePending("browser", { profile: path.relative(handle.captureRoots.browser, handle.profile), url: `http://127.0.0.1:${handle.router.port}` });
    ensurePending("swift", { buildRoot: requestedBuildRoot });
    await (run.protocol || ((value) => protocol(value)))(handle);
    const humanCallbacks = ["browser", "swift", "visuals"].every((name) => typeof run[name] === "function");
    if (!humanCallbacks) { pending = true; return Object.freeze({ status: "pending_manual_capture", sourceCommit, root: absoluteRoot, buildRoot: requestedBuildRoot, browserProfile: handle.profile, evidence: evidenceFile, runtimeHandle: sanitizeRuntimeHandle(handle), captureRoots: Object.freeze({ ...handle.captureRoots }), next: "complete the checked-in browser-session, record-visual, swift-session, and final-nonlive commands" }); }
    await run.browser({ handle, browserProfile: handle.profile, buildRoot: requestedBuildRoot }); await run.swift({ handle, buildRoot: requestedBuildRoot }); await run.visuals({ handle, browserProfile: handle.profile, buildRoot: requestedBuildRoot });
    const reports = completedTask3Reports(handle);
    // The worker and its owned ports/profile must be gone before an evidence
    // generation can become authoritative.  A failing cleanup never gets a
    // chance to overwrite the caller's prior evidence document.
    if (handle?.runtime) { await handle.runtime.dispose(); }
    else { const response = await controlRequest(handle, "stop"); if (!response?.ok) throw new Error("final non-live runtime stop was rejected"); await waitForWorkerCleanup(handle); }
    if (existsSync(handle.captureRoots.browser) || existsSync(handle.captureRoots.swift) || existsSync(handle.profile)) throw new Error("final non-live capture cleanup did not settle");
    const generation = recordFinalTask3Evidence({ evidence: evidenceFile, sourceCommit, runtimeArtifact: readCompletedStage(handle), browserArtifact: reports.browser, swiftArtifact: reports.swift, visualArtifact: reports.visual });
    committed = true; return generation;
  } catch (error) {
    // A final-generation marker is part of the same transaction as every
    // staged report.  A visual/marker failure must restore the exact prior
    // evidence rather than leave a newly opened, partial generation behind.
    if (priorEvidence) writeFileSync(evidenceFile, priorEvidence, { mode: 0o600 }); else rmSync(evidenceFile, { force: true });
    throw error;
  } finally {
    if (!committed && !pending && handle) {
      if (handle.runtime) await handle.runtime.dispose();
      else { const response = await controlRequest(handle, "stop"); if (!response?.ok) throw new Error("final non-live runtime stop was rejected"); await waitForWorkerCleanup(handle); }
    }
    if (!committed && existsSync(absoluteRoot)) { /* root is retained for redacted diagnostics only */ }
  }
}

function option(args, name, optional = false) { const index = args.indexOf(name); if (index < 0) { if (optional) return undefined; throw new Error(`missing ${name}`); } const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`missing ${name}`); return value; }
function cliEnvironment(root, sourceCommit) { const canonical = assertCliPreflight(root); return createIsolatedEnvironment({ root: canonical, nonce: `runtime-${path.basename(canonical).replace(/[^a-z0-9-]/gi, "-")}`, sourceCommit }); }
export function assertControlOwnership(handle, { inspect = psIdentity } = {}) {
  const lease = lstatSync(handle.lease.path);
  if (!sameIdentity(lease, handle.lease.identity)) throw new Error("refusing to contact runtime with replaced lease owner");
  const socket = lstatSync(handle.socket);
  if (!socket.isSocket() || socket.isSymbolicLink() || !sameIdentity(socket, handle.socketIdentity)) throw new Error("refusing to contact runtime with replaced control socket");
  assertProcessIdentity(handle.router.routerIdentity, "router", inspect);
  assertProcessIdentity(handle.router.workerIdentity, "worker", inspect);
}
async function controlRequest(handle, command) {
  assertControlOwnership(handle);
  let handshake;
  try { handshake = JSON.parse(readPrivateNoFollow(handle.handshake.path, handle.handshake.identity, "runtime handshake")); } catch { throw new Error("runtime handshake is invalid"); }
  exactKeys(handshake, ["runtimeId", "token", "version"], "runtime handshake");
  if (handshake.version !== 1 || handshake.runtimeId !== handle.runtimeId || !/^[0-9a-f]{64}$/.test(handshake.token)) throw new Error("runtime handshake is invalid");
  return new Promise((resolve, reject) => {
    const client = net.createConnection(handle.socket); let text = "";
    client.setEncoding("utf8"); client.once("error", () => reject(new Error("runtime control socket is not owned or reachable")));
    client.on("data", (chunk) => { text += chunk; }); client.once("end", () => { try { resolve(JSON.parse(text)); } catch { reject(new Error("runtime control socket returned invalid data")); } });
    client.once("connect", () => client.end(`${JSON.stringify({ version: 1, command, runtimeId: handle.runtimeId, token: handshake.token })}\n`));
  });
}
async function createControlServer(env, runtimeId, token, callbacks, shutdown) {
  const socket = controlPath(env.root); if (existsSync(socket)) throw new Error("runtime control socket already exists");
  // Protocol work can outlive the peer's request half-close.  Keep the write
  // side open until its authenticated result has been framed.
  const server = net.createServer({ allowHalfOpen: true }, async (client) => {
    let text = ""; client.setEncoding("utf8"); client.on("data", (chunk) => { text += chunk; }); client.once("end", async () => {
      try {
        const request = JSON.parse(text); exactKeys(request, ["version", "command", "runtimeId", "token"], "control request");
        if (request.version !== 1 || request.runtimeId !== runtimeId || !["status", "stop", "protocol"].includes(request.command) || typeof request.token !== "string" || request.token.length !== token.length || !timingSafeEqual(Buffer.from(request.token), Buffer.from(token))) throw new Error("runtime control request is not authorized");
        if (request.command === "protocol") { await callbacks.protocol(); client.end(JSON.stringify({ ok: true, stage: "complete" })); return; }
        client.end(`${JSON.stringify({ ok: true, status: request.command === "status" ? "running" : "stopping" })}`); if (request.command === "stop") setImmediate(shutdown);
      } catch (error) { let detail = "rejected"; try { detail = safeText(error?.message || detail); } catch {} client.end(JSON.stringify({ ok: false, error: detail })); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  // A Unix-domain socket inherits protection from the 0700 isolated root.  Do
  // not chmod it: macOS may unlink a socket that has just been bound by a
  // concurrently exiting Node child, which turns the chmod into a race while
  // the directory boundary remains the actual access control.
  if (!lstatSync(env.root).isDirectory() || (statSync(env.root).mode & 0o077) !== 0) throw new Error("runtime control root is not private");
  return server;
}
async function startAcceptanceWorker(env, { browserProfile, requireSwift = true } = {}) {
  const runtimeId = `worker-${randomBytes(8).toString("hex")}`, token = randomBytes(32).toString("hex"), failurePath = path.join(env.root, "runtime-worker-failure.json");
  const args = [fileURLToPath(import.meta.url), "--worker", "--root", env.root, "--source-commit", env.sourceCommit, "--runtime-id", runtimeId, "--token", token, ...(requireSwift ? [] : ["--no-swift"]), ...(browserProfile ? ["--browser-profile", browserProfile] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" }); child.unref();
  const deadline = Date.now() + 15_000;
  while (!existsSync(handlePath(env.root)) && !existsSync(failurePath) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (existsSync(failurePath)) {
    const failure = JSON.parse(readPrivateNoFollow(failurePath, privateIdentity(failurePath, "runtime worker failure"), "runtime worker failure"));
    try { await terminateBoundWorker(child); } catch (cleanupError) { throw new Error(`runtime worker failed during ${safeText(failure.stage || "start")}: ${safeText(failure.message || "unknown")}; worker cleanup: ${safeText(cleanupError.message)}`); }
    throw new Error(`runtime worker failed during ${safeText(failure.stage || "start")}: ${safeText(failure.message || "unknown")}`);
  }
  if (!existsSync(handlePath(env.root))) {
    await terminateBoundWorker(child);
    throw new Error(child.exitCode !== null || child.signalCode !== null ? "runtime worker exited before creating a handle" : "runtime worker did not create a handle before timeout");
  }
  const handle = readHandle(handlePath(env.root));
  if (handle.runtimeId !== runtimeId || handle.router.workerPid !== child.pid || (browserProfile && handle.profile !== browserProfile)) {
    await terminateBoundWorker(child);
    throw new Error("runtime handle is not bound to this worker spawn");
  }
  return handle;
}
async function worker(args) {
  const root = path.resolve(option(args, "--root")), sourceCommit = option(args, "--source-commit"), failurePath = path.join(root, "runtime-worker-failure.json");
  let env, release;
  try { env = cliEnvironment(root, sourceCommit); release = acquireIsolationLease(env.root, env.target.ports); }
  catch (error) { try { privateJsonReplace(failurePath, { owner: OWNER, sourceCommit, status: "failed", stage: "bootstrap", message: safeText(error?.message || "runtime worker bootstrap failed") }); } catch {}; throw error; }
  const fixtureState = { quotaModel: null, attempts: [] };
  let runtime, callbacks, server, started, stopping = false, captureRoots;
  const runtimeId = option(args, "--runtime-id", true) || `worker-${randomBytes(8).toString("hex")}`, token = option(args, "--token", true) || randomBytes(32).toString("hex"), handshakePath = path.join(env.root, "runtime-handshake"), plannedBrowserProfile = option(args, "--browser-profile", true);
  if (!/^worker-[0-9a-f]{16}$/.test(runtimeId) || !/^[0-9a-f]{64}$/.test(token)) throw new Error("runtime worker bootstrap binding is invalid");
  const emergencyStop = () => {
    // The child object is created by this worker, so this fallback does not
    // discover or signal an arbitrary PID after a cleanup timeout.
    try { started?.process?.child?.kill("SIGKILL"); } catch {}
  };
  const shutdown = async ({ exit = true } = {}) => {
    if (stopping) return; stopping = true;
    const failures = [];
    try { await boundedCleanup("runtime", async () => runtime?.dispose()); } catch (error) { failures.push(error); emergencyStop(); }
    try { await boundedCleanup("control socket", async () => new Promise((resolve) => server?.close(resolve))); } catch (error) { failures.push(error); server?.unref(); }
    for (const file of [controlPath(env.root), handshakePath, handlePath(env.root)]) try { unlinkSync(file); } catch (error) { if (error?.code !== "ENOENT") failures.push(error); }
    try { removeCaptureRoots(captureRoots); } catch (error) { failures.push(error); }
    try { release(); } catch (error) { failures.push(error); }
    if (failures.length) {
      if (exit) { try { privateJsonReplace(failurePath, { owner: OWNER, sourceCommit, status: "failed", stage: "cleanup", message: "runtime cleanup failed" }); } catch {}; process.exit(2); return; }
      throw new AggregateError(failures, "runtime worker cleanup failed");
    }
    if (exit) process.exit(0);
  };
  // Install cleanup before materialization: an interrupted checkout owns a
  // lease already, even though it has not started a router yet.
  // Never kill a PID from an exit hook: at that point its identity can no
  // longer be rechecked and a reused PID could belong to somebody else.
  process.on("SIGTERM", () => { void shutdown(); }); process.on("SIGINT", () => { void shutdown(); });
  process.once("uncaughtException", async () => { await shutdown(); }); process.once("unhandledRejection", async () => { await shutdown(); });
  try {
    const runtimeOptions = { sourceCommit, requireSwift: !args.includes("--no-swift") };
    if (!args.includes("--stable-fixture")) runtimeOptions.providerFixtureFactory = async ({ registerServer, signal }) => {
      // Do not proxy the checked-in fixture through an extra HTTP hop.  The
      // Router deliberately observes the upstream stream while relaying it;
      // an acceptance-only mux can consume the terminal frame and turn a
      // valid source lifecycle into an invalid downstream one.  This fixture
      // is itself the loopback upstream and supports both JSON and SSE.
      const fixture = await createRuntimeFixture({ registerServer, signal, slowStreams: true, behavior: fixtureState });
      fixtureState.attempts = fixture.attempts;
      return fixture;
    };
    runtime = await createLocalRuntime(env, runtimeOptions);
    callbacks = runtime.callbacks;
    await callbacks.prerequisites(env); await callbacks.install(env);
    // Keep the installer's checked Task2 catalog byte-identical for the first
    // protocol baseline.  Task3-specific routes are layered only after that
    // stable transport has proved its terminal lifecycle.
    writeTask3Catalog(env); writeFixtureCredential(env, "qwen-plan"); assertTask3Catalog(env); privateJson(path.join(env.stateRoot, "failover.json"), { version: 1, enabled: true, chain: ["qwen-plan/deepseek-v4-flash-0731"] });
    started = await callbacks.start(env); const health = await callbacks.health(env); if (!health?.ok) throw new Error("runtime worker health failed");
    nodeOnlyIdentity({ pid: started.pid }, env.sourceRoot);
    captureRoots = { browser: plannedBrowserProfile ? finalNonLiveBrowserCaptureRoot(env.root, plannedBrowserProfile) : runtimeCaptureRoot(env.root, runtimeId, "browser"), swift: runtimeCaptureRoot(env.root, runtimeId, "swift") }; const profile = plannedBrowserProfile || inside(captureRoots.browser, path.join(captureRoots.browser, "profile"), "runtime browser profile");
    for (const [kind, captureRoot] of Object.entries(captureRoots)) privateJson(path.join(captureRoot, "runtime-capture.json"), { owner: OWNER, kind, runtimeId, root: env.root, sourceCommit });
    privateJson(handshakePath, { version: 1, runtimeId, token }); const handshake = privateIdentity(handshakePath, "runtime handshake");
    server = await createControlServer(env, runtimeId, token, { protocol: () => stageWorkerProtocol({ env, callbacks, fixtureState, sourceCommit }) }, shutdown);
    const leaseInfo = isolationLeasePath(env.target.ports), lease = lstatSync(leaseInfo.lock), socket = lstatSync(controlPath(env.root));
    if (!socket.isSocket()) throw new Error("runtime control endpoint is not a Unix socket");
    writeHandle({ owner: OWNER, sourceCommit, root: env.root, handlePath: handlePath(env.root), runtimeId, socket: controlPath(env.root), socketIdentity: identity(socket), handshake: { path: handshakePath, identity: handshake }, router: { pid: started.pid, workerPid: process.pid, startedAt: Date.now(), port: env.target.ports.router, label: env.target.routerLabel, routerIdentity: psIdentity(started.pid), workerIdentity: psIdentity(process.pid) }, lease: { path: leaseInfo.lock, normalized: leaseInfo.normalized, identity: identity(lease), ports: Object.values(env.target.ports) }, captureRoots, profile, artifacts: { report: path.join(env.evidenceRoot, "runtime.json") } });
    started.process?.exitPromise?.then(() => shutdown()).catch(() => shutdown());
  } catch (error) {
    // Settle resources first: runtime disposal can remove the materialized
    // root.  Recreate only the closed diagnostic afterwards so the detached
    // parent never has to infer a start error from a missing handle.
    let failure = error;
    try { await shutdown({ exit: false }); } catch (cleanupError) { failure = new AggregateError([error, cleanupError], "runtime worker startup and cleanup failed"); }
    try { privateJsonReplace(failurePath, { owner: OWNER, sourceCommit, status: "failed", stage: started ? "post-start" : "start", message: safeText(failure?.message || "runtime worker failed") }); } catch {}
    throw failure;
  }
  await new Promise(() => {});
}
async function waitForWorkerCleanup(handle) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    let workerAlive = true; try { process.kill(handle.router.workerPid, 0); } catch (error) { if (error?.code === "ESRCH") workerAlive = false; else throw error; }
    const capturesGone = !existsSync(handle.captureRoots.browser) && !existsSync(handle.captureRoots.swift) && !existsSync(handle.profile);
    if (!workerAlive && !existsSync(handle.socket) && !existsSync(handle.lease.path) && capturesGone) { await assertPortsAvailable(handle.lease.ports.reduce((ports, port, index) => ({ ...ports, [index]: port }), {})); return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runtime worker did not clean its socket, lease, and ports");
}
async function terminateBoundWorker(child) {
  if (!child || !Number.isInteger(child.pid) || child.pid < 1) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const gone = () => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    try { process.kill(child.pid, 0); return false; } catch (error) { if (error?.code === "ESRCH") return true; throw error; }
  };
  if (gone()) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  }
  const waitGone = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (gone()) return true; await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(resolve, 50))]); }
    return gone();
  };
  if (await waitGone(3_000)) return;
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
  if (!await waitGone(3_000)) throw new Error("runtime worker did not terminate after startup failure");
}
function readCompletedStage(handle) {
  const file = path.join(handle.root, "evidence", "runtime-stage.json"), entry = lstatSync(file);
  if (entry.isSymbolicLink() || !privateRegularFile(file, entry)) throw new Error("runtime stage artifact is unsafe");
  const stage = JSON.parse(readPrivateNoFollow(file, identity(entry), "runtime stage artifact"));
  readRuntimeStage(file, handle.sourceCommit);
  return file;
}
function completedTask3Reports(handle) {
  const browser = readCompletedSessionArtifact(handle.root, "browser", handle.sourceCommit, handle);
  const swift = readCompletedSessionArtifact(handle.root, "swift", handle.sourceCommit, handle);
  const visual = readVisualReport(handle.root, handle.sourceCommit);
  return { browser, swift, visual };
}
export function completedTask3ReportsOrPending(handle) {
  const reports = [
    path.join(handle.root, "evidence", "browser-session-report.json"),
    path.join(handle.root, "evidence", "swift-session-report.json"),
    visualReportPath(handle.root),
  ];
  // Missing reports mean the operator intentionally stopped after the eight
  // runtime rows.  Once any staged report exists, its schema/ownership errors
  // are never downgraded to that benign pending state.
  if (reports.every((file) => !existsSync(file))) return null;
  return completedTask3Reports(handle);
}
export async function runAcceptanceRuntimeCli(argv = process.argv.slice(2), { provenance = assertRuntimeCommandProvenance } = {}) {
  const [command, ...args] = argv; if (command === "--worker") return worker(args);
  if (!["start", "protocol", "browser-session", "record-visual", "swift-session", "stop", "final-nonlive"].includes(command)) throw new Error("Usage: acceptance-runtime start|protocol|browser-session|record-visual|swift-session|stop|final-nonlive");
  if (command === "record-visual") {
    const evidence = path.resolve(option(args, "--evidence")), artifact = path.resolve(option(args, "--artifact")), root = path.resolve(option(args, "--root", true) || runtimeRootForArtifact(artifact)), handle = readHandle(handlePath(root));
    const sourceCommit = option(args, "--source-commit", true) || handle.sourceCommit; provenance(sourceCommit);
    if (sourceCommit !== handle.sourceCommit) throw new Error("visual source commit does not match active runtime");
    const kind = option(args, "--kind"), expected = VISUALS[kind]; if (!expected) throw new Error("unknown visual evidence kind");
    const sessionKind = ["swift-light", "swift-dark", "vision-allow"].includes(kind) ? "swift" : "browser";
    let session;
    if (sessionKind === "browser") {
      session = { captureStartedAt: pendingBrowserVisualSession(root, handle, sourceCommit, artifact), reviewer: option(args, "--reviewer"), inspected: JSON.parse(option(args, "--inspected")) };
    } else if (kind === "vision-allow") {
      const sessionPath = readCompletedSessionArtifact(root, "swift", sourceCommit, handle), sessionEntry = privateIdentity(sessionPath, "swift session report");
      session = JSON.parse(readPrivateNoFollow(sessionPath, identity(sessionEntry), "swift session report"));
    } else {
      session = { captureStartedAt: pendingSessionStartedAt(root, "swift", sourceCommit, handle.runtimeId), reviewer: option(args, "--reviewer"), inspected: JSON.parse(option(args, "--inspected")) };
    }
    const viewport = option(args, "--viewport", true) || (kind === "browser-narrow" ? "390x844" : "1440x900"), appearance = option(args, "--appearance", true) || expected.appearance;
    const reviewer = option(args, "--reviewer", true) || session.reviewer, inspected = option(args, "--inspected", true) ? JSON.parse(option(args, "--inspected")) : session.inspected, issues = option(args, "--issues", true) ? JSON.parse(option(args, "--issues")) : [];
    const captureStartedAt = session.captureStartedAt;
    const captureRoot = sessionKind === "swift" ? handle.captureRoots.swift : handle.captureRoots.browser;
    const sourceCapture = fingerprintFile(canonicalArtifact(captureRoot, artifact, `visual-${kind} source capture`), `visual-${kind} source capture`);
    if (sourceCapture.mtimeMs < Date.parse(session.captureStartedAt)) throw new Error("visual source artifact predates its active session");
    const sidecars = sessionKind === "browser" ? browserSidecarCaptures(root, captureRoot, artifact, sourceCommit, handle.runtimeId, captureStartedAt) : undefined;
    const record = validateVisualRecord({ kind, artifact: archiveCapture(root, captureRoot, artifact, `visual-${kind}`), sourceCommit, runtimeId: handle.runtimeId, captureStartedAt, verdict: option(args, "--verdict"), viewport, appearance, reviewer, inspected, issues, sidecars });
    appendVisualReport(root, record);
    if (kind === "browser-narrow") {
      const visualEntry = privateIdentity(visualReportPath(root), "visual report"), visual = JSON.parse(readPrivateNoFollow(visualReportPath(root), visualEntry, "visual report"));
      if (!visual.records.some((value) => value?.kind === "browser-desktop" && value?.runtimeId === handle.runtimeId)) throw new Error("browser narrow capture requires the prior desktop capture");
      completedSessionArtifact(root, handle.captureRoots.browser, "browser", sourceCommit, handle.runtimeId, handle.router.startedAt, artifact, reviewer, inspected, captureStartedAt);
    }
    if (kind === "swift-dark") {
      const visualEntry = privateIdentity(visualReportPath(root), "visual report"), visual = JSON.parse(readPrivateNoFollow(visualReportPath(root), visualEntry, "visual report"));
      if (!visual.records.some((value) => value?.kind === "swift-light" && value?.runtimeId === handle.runtimeId)) throw new Error("Swift dark capture requires the prior light capture");
      completedSessionArtifact(root, handle.captureRoots.swift, "swift", sourceCommit, handle.runtimeId, handle.router.startedAt, artifact, reviewer, inspected, captureStartedAt);
    }
    return;
  }
  const root = path.resolve(option(args, "--root")), evidence = path.resolve(option(args, "--evidence")), sourceCommit = option(args, "--source-commit", true) || currentCommit();
  provenance(sourceCommit);
  if (command === "start") { if (existsSync(root)) throw new Error("runtime start requires a fresh root with no prior control artifacts"); const env = cliEnvironment(root, sourceCommit); await assertPortsAvailable(env.target.ports); const handle = await startAcceptanceWorker(env); privateJson(path.join(env.evidenceRoot, "runtime-start.json"), runtimeAcceptanceReport(handle)); process.stdout.write(`${handle.handlePath}\n`); return; }
  const handle = readHandle(handlePath(root)); if (handle.sourceCommit !== sourceCommit) throw new Error("runtime handle source commit mismatch");
  if (command === "stop") {
    const reports = completedTask3ReportsOrPending(handle);
    const result = await controlRequest(handle, "stop");
    if (!result?.ok) throw new Error("runtime control stop was rejected");
    await waitForWorkerCleanup(handle);
    const artifact = readCompletedStage(handle);
    if (reports) { recordFinalTask3Evidence({ evidence, sourceCommit, runtimeArtifact: artifact, browserArtifact: reports.browser, swiftArtifact: reports.swift, visualArtifact: reports.visual }); return; }
    recordRuntimeRowsAtomically({ evidence, sourceCommit, artifact }); return;
  }
  if (command === "protocol") return protocol(handle);
  if (command === "browser-session") {
    const profile = path.resolve(option(args, "--profile")); if (profile !== handle.profile) throw new Error("browser profile must be the worker-owned canonical capture profile"); mkdirSync(profile, { recursive: true, mode: 0o700 });
    const artifact = inside(root, path.join(root, "browser-session.json"), "browser session artifact"), completed = option(args, "--completed-artifact", true);
    if (!completed) { privateJsonReplace(artifact, { owner: OWNER, sourceCommit, runtimeId: handle.runtimeId, captureStartedAt: new Date().toISOString(), status: "pending_manual_session", profile: path.relative(handle.captureRoots.browser, profile), url: `http://127.0.0.1:${handle.router.port}` }); process.stdout.write(`http://127.0.0.1:${handle.router.port}\n${profile}\n`); return; }
    completedSessionArtifact(root, handle.captureRoots.browser, "browser", sourceCommit, handle.runtimeId, handle.router.startedAt, path.resolve(completed), option(args, "--reviewer"), JSON.parse(option(args, "--inspected")));
    return;
  }
  if (command === "swift-session") {
    const bundle = path.resolve(option(args, "--bundle")), manifestPath = option(args, "--task1-manifest", true); if (!lstatSync(bundle).isDirectory() || lstatSync(bundle).isSymbolicLink()) throw new Error("Swift bundle must be an explicit regular directory"); verifiedSwiftBundle(bundle, sourceCommit, { manifestPath });
    const artifact = inside(root, path.join(root, "swift-session.json"), "Swift session artifact"), completed = option(args, "--completed-artifact", true);
    if (completed) throw new Error("Swift session is completed only after the light and dark visual captures are both recorded");
    privateJsonReplace(artifact, { owner: OWNER, sourceCommit, runtimeId: handle.runtimeId, captureStartedAt: new Date().toISOString(), status: "pending_manual_session", bundle: path.relative(root, bundle) }); return;
  }
  if (command === "final-nonlive") {
    // The reports are captured while the owned worker is alive, but they are
    // merely staged until the protocol has passed and the worker, lease,
    // socket, ports and profile have all been cleaned up.
    const previousEvidence = existsSync(evidence) ? readFileSync(evidence) : null;
    let stopped = false;
    try {
      const browser = path.resolve(option(args, "--browser-report")), swift = path.resolve(option(args, "--swift-report")), visual = path.resolve(option(args, "--visual-report"));
      for (const file of [browser, swift, visual]) localPath(root, file, "final non-live report");
      if (browser !== inside(root, path.join(root, "evidence", "browser-session-report.json"), "browser report") || swift !== inside(root, path.join(root, "evidence", "swift-session-report.json"), "Swift report") || visual !== visualReportPath(root)) throw new Error("final non-live reports must be the owned staged reports");
      const result = await protocol(handle), runtimeArtifact = readCompletedStage(handle);
      const response = await controlRequest(handle, "stop"); if (!response?.ok) throw new Error("final non-live runtime stop was rejected"); stopped = true;
      await waitForWorkerCleanup(handle);
      const artifact = inside(root, path.join(root, "evidence", "final-nonlive.json"), "final non-live artifact");
      const generation = recordFinalTask3Evidence({ evidence, sourceCommit, runtimeArtifact, browserArtifact: browser, swiftArtifact: swift, visualArtifact: visual });
      privateJsonReplace(artifact, { owner: OWNER, sourceCommit, status: "completed", generationId: generation.generationId, protocol: result?.stage, browser, swift, visual });
    } catch (error) {
      if (previousEvidence) writeFileSync(evidence, previousEvidence, { mode: 0o600 }); else rmSync(evidence, { force: true });
      throw error;
    } finally {
      if (!stopped) { try { const response = await controlRequest(handle, "stop"); if (response?.ok) await waitForWorkerCleanup(handle); } catch {} }
    }
    return;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runAcceptanceRuntimeCli().catch((error) => { process.stderr.write(`${redactSensitive(error.message, { profile: "log" })}\n`); process.exitCode = 2; });
