import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = path.join(ROOT, "test", "acceptance", "acceptance-matrix.json");
const BLOCK = 512;
const LIMIT = Object.freeze({ outer: 128 * 1024 * 1024, manifest: 4 * 1024 * 1024, sums: 1024 * 1024, unpacked: 512 * 1024 * 1024, entries: 10000, depth: 128, file: 64 * 1024 * 1024 });
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REQUIRED = Object.freeze([
  "apps/desktop/ui/index.html", "apps/desktop/ui/app.js", "apps/desktop/ui/model.mjs", "apps/desktop/ui/thinking-orb.mjs", "apps/desktop/ui/i18n.mjs", "apps/desktop/ui/styles.css",
  "Applications/Model Router.app/Contents/MacOS/ModelRouterTray",
  "Applications/Model Router.app/Contents/Info.plist",
  "Applications/Model Router.app/Contents/Resources/AppIcon.icns",
  "catalogs/merged-models.json", "catalogs/routed-models.json",
]);
const APP_EXECUTABLE = "Applications/Model Router.app/Contents/MacOS/ModelRouterTray";
const ROUTE_FIELDS = Object.freeze([
  ["gatewayModel", "gatewayModel"], ["provider", "provider"], ["credentialOwner", "credentialOwner"], ["upstreamModel", "upstreamModel"], ["transport", "effectiveTransport"], ["toolDialect", "toolDialect"], ["reasoningDisplayMode", "reasoningDisplayMode"], ["finalShape", "declaredFinalReasoningShape"], ["purpose", "purpose"], ["rollout", "rolloutState"], ["listed", "listed"],
]);
const NODE_ROUTE_BOUNDARY_FIELDS = Object.freeze(["gatewayModel", "effectiveTransport", "toolDialect", "reasoningDisplayMode", "declaredFinalReasoningShape", "rolloutState", "purpose", "listed", "requestProfile"]);
const NODE_REQUEST_PROFILE_PROVIDERS = Object.freeze({ "deepseek-thinking": "deepseek", "qwen-plan": "qwen-plan" });
const ROUTE_ORACLE_PATH = path.join(ROOT, "test", "fixtures", "node-route-matrix.json");
const FORBIDDEN_PATHS = [["python-runtime", /(?:^|\/)(?:requirements|venv|__pycache__)(?:\/|$)|\.(?:py|pyc|pyo)$/i], ["rust-tauri-runtime", /(?:^|\/)(?:src-tauri|tauri|electron)(?:\/|$)|(?:^|\/)Cargo\.toml$/i]];
const removedRuntimeName = (...parts) => parts.join("");
const REMOVED_RUST_COMMANDS = Object.freeze([removedRuntimeName("car", "go"), removedRuntimeName("rust", "c")]);
const REMOVED_TAURI_SCOPE = removedRuntimeName("@", "ta", "uri-apps");
const REMOVED_RUST_EXECUTABLE = new RegExp("^(?:" + REMOVED_RUST_COMMANDS.join("|") + ")(?:[-_].*)?$", "i");
const EVIDENCE = Object.freeze({ unit: 1, build: 1, runtime: 1, ui: 1, visual: 1, "isolated-install": 1, live: 1 });
const PROVIDERS = new Set(["deepseek", "qwen-plan", "bailian", "glm"]);
const OUT_OF_SCOPE = "out_of_current_provider_scope";
const DEEPSEEK_QUOTA = "quota_approval_absent";
const CHILD_PROCESS_OPERATIONS = new Set(["spawn", "exec", "execFile", "fork"]);
const VARIABLE_CHILD_PROCESS_PROVENANCE = Object.freeze([
  { path: "src/node-runtime.mjs", operation: "spawn", callee: "spawnProcess", argument: "command.command", sourceDigest: "cb8c9033c7bcd33306fcda53a12d7dacde91004d810ae37ac65fdd224d9345dd" },
  { path: "src/subagent-verify.mjs", operation: "spawn", callee: "spawn", argument: "execPath", sourceDigest: "60439116891a1bb2387c245f65c943791aec2529400765d00437e51e6e8771b8" },
  { path: "src/desktop-commands.mjs", operation: "execFile", callee: "execFile", argument: "runtime.command", sourceDigest: "890d928cc8192805ce06cf518597e22702cdca5bfdb39c29931f8ffa9f53f62b" },
  { path: "src/panel.mjs", operation: "execFile", callee: "execFile", argument: "command", sourceDigest: "5a9882835ec91ee3123e729cc6cb55f7c0ecb93e4b397b50aadc396c5706c532" },
  { path: "src/dsh-web.mjs", operation: "spawn", callee: "spawn", argument: "command.command", sourceDigest: "6fb446b2848f2f363e5896c5801560902cd2e79935fd56a10594c3542674b095" },
  { path: "src/control.mjs", operation: "spawn", callee: "spawn", argument: "process.execPath", sourceDigest: "01768ad2029a7aca2099ffa8059061fa24533a4d6c066c846fd1ea2d90d32589" },
]);
const VARIABLE_SHELL_COMMAND_SOURCE_DIGESTS = Object.freeze({
  "bin/api-key": "4c0467704c68e931f88815344a3e71be2e65befb0b6a2a2d649e10c1d30bc3d9",
  "bin/control": "1fa86b010f80c4ebc8a952c13a4b2b5e111eb8a1d83e5155eb61c3e424bd623c",
  "bin/curate-models": "656efe6f0f5de555c0eecdf98b57db03285d121fa1aec91d43ae59784a11803d",
  "bin/devin-probe": "d0985f93ea001e4e1e2474155c8ab5d37357d1a44efa43fe3ba1471563a5ad57",
  "bin/disable": "9436315b5d6f2534ccef5fe8e08c3bf1cfb1878ce71d00894c90e10dba75bb07",
  "bin/discover-models": "6f62bf629f0c47c4a44b0b0eca6e3f65cdb0c6d3cffdfac8b59d2e5bcc3a867b",
  "bin/doctor": "e0f91630f0d2b929ff5ab2f0ec38c9774cf1f403a0db1515e8a49612314bc193",
  "bin/enable": "4a0e832e5ab6c368738fb48644e4d7b02b918498d9882737cef6b4cd6cb63333",
  "bin/install": "7229f40813dba1c6b4b8394d4fcacdd98a0932c59086184991ad0e14bc108d41",
  "bin/media": "cf5e65ee6571fcb085a61b10775d647017330662452e07ed1473b9afcdc4cd1c",
  "bin/migrate": "95866eafca903b9645be523169c8f3b631bd5693686efbad002ed67f9b848e33",
  "bin/model-router": "e858ea418520aec4d9c81df1fbb2191df3d3b702ee856827cccbf0e24e76a0fc",
  "bin/model-router-tray": "1effd07241812da7e4e7f42d57ed9e156e3354e002f63a6a2fd33a72186043e2",
  "bin/multi-agent": "a095d56291a887711aaed1c1718ba5bfaa780bf112b9c7392250dfb0a6c999c6",
  "bin/panel": "819f107e8a562c16641775923d0809b2e9cfde6b2ba64fb9d4db9ca70839face",
  "bin/provider-key": "b0c934a0946fd8e56fdfcb20d892956995bfcf1022ded46b5bec9fc66e03b3dc",
  "bin/providers": "8d8c9db4aa90b96fa939ee30b08cfc9d142bff41a1b0b2496897b3945b1fbed0",
  "bin/refresh-catalog": "a3148e963f7297111d83b7fb523344ec1c0a5a9f00304d76e80f4a7b1da5d132",
  "bin/rollback": "3676352166bb35ec6f15a29dd500ad4388b7e5d4f9fc29c92d7e91e9a8a3843b",
  "bin/setup": "81179bede402b73368644ccac7be28873209328f69e83a564747e5f15e46e88c",
  "bin/shim": "28ff0ae5a4eacb1bd06ae0dd55a8a703902d2d64b9932becd25ddc7d85fda46d",
  "bin/smoke-test": "d1b174476ae21d8884d47fa9cf4ae2550476c5032592b29752d40c3ce7e81c02",
  "bin/start": "68aef6919ad6f61e386a985d657a3fe04100e91cb33976237e448290a29ff248",
  "bin/status": "fdcdafe24b1f382357bad519906a9266af5fca970f090f93b671daaa96fbd2f9",
  "bin/stop": "53b2649136311885be66e61073912e57bd251dd42a1fc89f14a6c5a9b080dad6",
  "bin/subagent-preset": "e9c27754f95c453bf455bd452f7c6fead4f78e34d6bcb0c758de10feba38b008",
  "bin/support-bundle": "0898efa5bfa19d632bb9a08ac79ae2d827121e385bdce8e30f0443512629b78e",
  "bin/test-model": "d5f9e2d421961684dbcd981099b8c4364018f10fb9c5612c4bee46c3ddaa417c",
  "bin/uninstall": "c4013bce72b9d5d44763451d5e84c3670c4d7d942217838a0f61533d136f8d7e",
  "bin/update": "cb62f472671ee642fc9074879ce069e37fabf493b5bf16cf3936b4fffb3605fa",
  "scripts/build-macos-tray-app.sh": "4a39ec11acd967d5ba621d1ae83b75e12925fbd2b4f631cb1c9c9481e0876067",
});

function finding(kind, value, detail) { return { kind, path: value, detail }; }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function safePath(value) { return typeof value === "string" && value && !value.startsWith("/") && !value.includes("\\") && path.posix.normalize(value) === value && value.split("/").every((part) => part && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f]/.test(part)); }
function parseJson(entry) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.data)); } catch { return null; } }
function available(entries, value) { return entries.has(value) || [...entries.keys()].some((entry) => entry.startsWith(value + "/")); }
function routeOracle() {
  let value;
  try { value = JSON.parse(readFileSync(ROUTE_ORACLE_PATH, "utf8")); } catch { throw new Error("checked-in Node route oracle is unavailable"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 12) throw new Error("checked-in Node route oracle is invalid");
  const rows = new Map();
  for (const [slug, row] of Object.entries(value)) {
    if (typeof slug !== "string" || !slug || !row || typeof row !== "object" || Array.isArray(row) || ROUTE_FIELDS.some(([field]) => !(field in row))) throw new Error("checked-in Node route oracle has an invalid row");
    rows.set(slug, row);
  }
  return rows;
}

function parseOctal(field, maximum = Number.MAX_SAFE_INTEGER) {
  let value = 0, end = false, digits = 0;
  for (const byte of field) {
    if (byte === 0) { end = true; continue; }
    if (end || byte < 48 || byte > 55 || value > Math.floor((maximum - (byte - 48)) / 8)) return null;
    value = value * 8 + byte - 48; digits += 1;
  }
  return digits ? value : null;
}
function parseText(field) {
  const end = field.indexOf(0), bytes = end === -1 ? field : field.subarray(0, end);
  if (end !== -1 && field.subarray(end + 1).some((byte) => byte !== 0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
function parseUstar(bytes, name) {
  const entries = [], seen = new Set(); let offset = 0, total = 0;
  const failed = (kind, detail) => ({ entries, findings: [finding(kind, name, detail)] });
  while (true) {
    if (offset + BLOCK > bytes.byteLength) return failed("release-tar-truncated", "USTAR header is truncated");
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (offset + BLOCK * 2 > bytes.byteLength || !bytes.subarray(offset + BLOCK, offset + BLOCK * 2).every((byte) => byte === 0) || offset + BLOCK * 2 !== bytes.byteLength) return failed("release-tar-terminator-invalid", "USTAR archive must end with exactly two zero blocks");
      return { entries, findings: [] };
    }
    if (entries.length >= LIMIT.entries) return failed("release-tar-entry-limit", "USTAR entry count exceeds the audit limit");
    if (!header.subarray(257, 263).equals(Buffer.from("ustar\0")) || !header.subarray(263, 265).equals(Buffer.from("00"))) return failed("release-tar-header-invalid", "archive entry is not USTAR");
    if (header[154] !== 0 || header[155] !== 32 || !/^[0-7]{6}$/.test(header.subarray(148, 154).toString("ascii"))) return failed("release-tar-checksum-invalid", "USTAR checksum field is invalid");
    const expected = Number.parseInt(header.subarray(148, 154).toString("ascii"), 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expected !== actual) return failed("release-tar-checksum-invalid", "USTAR checksum does not match");
    const mode = parseOctal(header.subarray(100, 108), 0o777), size = parseOctal(header.subarray(124, 136), LIMIT.file), rawName = parseText(header.subarray(0, 100)), prefix = parseText(header.subarray(345, 500));
    const value = rawName === null || prefix === null ? null : prefix ? prefix + "/" + rawName : rawName;
    const typeByte = header[156], type = typeByte === 0 || typeByte === 48 ? "file" : typeByte === 53 ? "directory" : null;
    if (mode === null || size === null || !safePath(value) || !type || (type === "directory" && (size !== 0 || mode !== 0o755)) || (type === "file" && ![0o644, 0o755].includes(mode))) return failed("release-tar-header-invalid", "USTAR metadata is invalid");
    if (seen.has(value)) return failed("release-tar-duplicate", "USTAR entry path is duplicated");
    const body = offset + BLOCK, padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (size > bytes.byteLength - body || padding > bytes.byteLength - body - size) return failed("release-tar-truncated", "USTAR entry body or padding is truncated");
    if (!bytes.subarray(body + size, body + size + padding).every((byte) => byte === 0)) return failed("release-tar-padding-invalid", "USTAR padding must be zero-filled");
    total += size; if (total > LIMIT.unpacked) return failed("release-tar-total-limit", "USTAR contents exceed the audit limit");
    seen.add(value); entries.push({ path: value, type, mode, bytes: size, data: Buffer.from(bytes.subarray(body, body + size)) }); offset = body + size + padding;
  }
}
function readRelease(root, name, maximum, findings) {
  const target = path.join(root, name);
  try {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("invalid");
    if (info.size > maximum) { findings.push(finding("release-artifact-too-large", name, "release artifact exceeds the audit limit")); return null; }
    return readFileSync(target);
  } catch { findings.push(finding(existsSync(target) ? "release-artifact-invalid" : "release-artifact-missing", name, "required release artifact is unavailable")); return null; }
}
function manifest(bytes, archiveName, findings) {
  let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { findings.push(finding("release-manifest-invalid", "manifest.json", "release manifest is not valid JSON")); return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.target !== "codex" || value.platform !== "darwin" || value.runtime !== "node" || value.packageKind !== "runtime" || value.runtimeMetadata !== "runtime-package.json" || !SEMVER.test(value.packageVersion) || !COMMIT.test(value.sourceCommit) || archiveName !== "codex-router-" + value.packageVersion + ".tar.gz" || !Array.isArray(value.files) || !value.files.length || value.files.length > LIMIT.entries) { findings.push(finding("release-manifest-invalid", "manifest.json", "release manifest has an unsupported schema or identity")); return null; }
  const listed = new Map();
  for (const entry of value.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !safePath(entry.path) || !["file", "directory"].includes(entry.type) || !/^0[0-7]{3}$/.test(entry.mode) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > LIMIT.file || (entry.type === "directory" && entry.bytes !== 0) || !SHA256.test(entry.sha256) || listed.has(entry.path)) { findings.push(finding("release-manifest-invalid", "manifest.json", "release manifest files are invalid or duplicated")); return null; }
    listed.set(entry.path, entry);
  }
  return listed;
}

function runtimePackage(entries) {
  const metadata = entries.get("runtime-package.json");
  if (!metadata) return [finding("runtime-package-missing", "runtime-package.json", "release artifact must include runtime package metadata")];
  const value = parseJson(metadata);
  if (!value || value.schemaVersion !== 1 || value.runtime !== "node" || value.platform !== "darwin" || value.target !== "codex") return [finding("runtime-manifest-invalid", "runtime-package.json", "runtime package metadata is invalid")];
  const findings = [];
  for (const [label, rows] of [["entrypoints", value.entrypoints], ["assets", value.assets], ["docs", value.docs]]) {
    const missing = Array.isArray(rows) && rows.find((entry) => !safePath(entry) || !available(entries, entry));
    if (!Array.isArray(rows) || !rows.length || new Set(rows).size !== rows.length || missing) findings.push(finding("runtime-package-missing", typeof missing === "string" ? missing : "runtime-package.json", "runtime package " + label + " are absent or invalid"));
  }
  if (findings.length) return findings;
  const visited = new Set();
  const visit = (relative) => {
    if (visited.has(relative)) return; visited.add(relative);
    const entry = entries.get(relative);
    if (!entry || entry.type !== "file") { findings.push(finding("runtime-import-missing", relative, "runtime entrypoint or local import is absent")); return; }
    if (!/\.(?:cjs|js|mjs)$/i.test(relative)) return;
    let source; try { source = new TextDecoder("utf-8", { fatal: true }).decode(entry.data); } catch { findings.push(finding("runtime-import-invalid", relative, "runtime source is not UTF-8")); return; }
    for (const match of source.matchAll(/(?:import\s*(?:[^"']*?from\s*)?|export\s*[^"']*?from\s*|import\s*\()\s*["'](\.[^"']+)["']/g)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      if (!safePath(resolved)) findings.push(finding("runtime-import-outside", relative, "runtime import escapes artifact root"));
      else if (entries.has(resolved)) visit(resolved);
      else if (!path.posix.extname(resolved) && entries.has(resolved + ".mjs")) visit(resolved + ".mjs");
      else if (!path.posix.extname(resolved) && entries.has(resolved + ".js")) visit(resolved + ".js");
      else findings.push(finding("runtime-import-missing", path.posix.extname(resolved) ? resolved : resolved + ".mjs", "runtime entrypoint or local import is absent"));
    }
  };
  for (const entrypoint of value.entrypoints) visit(entrypoint);
  return findings;
}
function isNodeRoute(model) {
  return model && typeof model === "object" && !Array.isArray(model) &&
    typeof model.slug === "string" && NODE_ROUTE_BOUNDARY_FIELDS.every((field) =>
      field === "listed" ? typeof model[field] === "boolean" : typeof model[field] === "string" && model[field],
    );
}
function registry(entries) {
  const expected = routeOracle(), findings = [], actual = new Map(), providers = new Map();
  for (const [relative, entry] of entries) {
    if (!relative.startsWith("config/") || !relative.endsWith(".json") || entry.type !== "file") continue;
    const value = parseJson(entry);
    if (!value || value.version !== 1) continue;
    if (value.providers !== undefined) {
      if (!Array.isArray(value.providers)) { findings.push(finding("registry-provider-invalid", relative, "registry provider document is invalid")); continue; }
      for (const provider of value.providers) {
        if (!provider || typeof provider !== "object" || Array.isArray(provider) || typeof provider.id !== "string" || !provider.id || typeof provider.kind !== "string" || !provider.kind || typeof provider.displayName !== "string" || !provider.displayName || typeof provider.ownedBy !== "string" || !provider.ownedBy || providers.has(provider.id)) findings.push(finding("registry-provider-invalid", relative, "registry provider document is invalid or duplicated"));
        else providers.set(provider.id, provider);
      }
    }
    if (value.models === undefined) continue;
    if (!Array.isArray(value.models)) { findings.push(finding("registry-model-invalid", relative, "registry document has an invalid model set")); continue; }
    for (const model of value.models) {
      if (!isNodeRoute(model)) continue;
      const slug = String(model.slug);
      if (actual.has(slug)) findings.push(finding("registry-model-duplicate", slug, "registry slug is duplicated"));
      actual.set(slug, model);
      const wanted = expected.get(slug);
      if (!wanted) findings.push(finding("registry-model-extra", slug, "registry contains a Node route absent from the checked-in oracle"));
      else if (ROUTE_FIELDS.some(([oracleField, routeField]) => !(routeField in model) || model[routeField] !== wanted[oracleField])) findings.push(finding("registry-model-mismatch", slug, "registry route fields differ from the checked-in oracle"));
    }
  }
  for (const [slug, model] of actual) {
    if (!providers.has(model.provider)) findings.push(finding("registry-provider-missing", String(model.provider), "Node route references a missing provider"));
    if (NODE_REQUEST_PROFILE_PROVIDERS[model.requestProfile] !== model.provider) findings.push(finding("registry-request-profile-invalid", slug, "Node route request profile is not valid for its provider"));
  }
  for (const slug of expected.keys()) if (!actual.has(slug)) findings.push(finding("registry-model-missing", slug, "checked-in registry slug is absent"));
  return { findings, routes: actual };
}
function catalogRouteSlug(slug, expected) {
  return expected.has(slug) || /^(?:deepseek|qwen-plan|qwen-plan-responses)\//.test(slug);
}
function catalogs(entries, routes) {
  const expected = routeOracle(), expectedSlugs = [...expected.keys()].sort(), findings = [];
  for (const relative of ["catalogs/merged-models.json", "catalogs/routed-models.json"]) {
    const entry = entries.get(relative); if (!entry) { findings.push(finding("catalog-missing", relative, "published catalog is absent")); continue; }
    const value = parseJson(entry), valid = Array.isArray(value?.models) && value.models.every((model) => model && typeof model === "object" && !Array.isArray(model) && typeof model.slug === "string" && model.model_messages && typeof model.model_messages.instructions_template === "string" && (relative.endsWith("merged-models.json") || (typeof model.base_instructions === "string" && typeof model.supports_parallel_tool_calls === "boolean")));
    if (!valid) { findings.push(finding("catalog-schema-invalid", relative, "published catalog has an unsupported public schema")); continue; }
    const nodeModels = value.models.filter((model) => catalogRouteSlug(model.slug, expected));
    const slugs = nodeModels.map((model) => model.slug).sort();
    if (new Set(slugs).size !== slugs.length || JSON.stringify(slugs) !== JSON.stringify(expectedSlugs)) { findings.push(finding("catalog-route-set-mismatch", relative, "published catalog Node-route slugs differ from the checked-in oracle")); continue; }
    for (const model of nodeModels) {
      const route = routes.get(model.slug);
      if (!route || model.display_name !== route.displayName || model.description !== route.description || model.priority !== route.priority || model.context_window !== route.contextWindow || JSON.stringify(model.input_modalities) !== JSON.stringify(route.inputModalities)) findings.push(finding("catalog-route-mismatch", model.slug, "published catalog public route fields differ from registry"));
    }
  }
  return findings;
}
function staticSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
  return [...code.matchAll(/(?:\bimport\s*(?:\(\s*)?(?:[^"']*?\sfrom\s*)?|\bexport\s*[^"']*?\sfrom\s*|\brequire\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
}
function removedKind(value) {
  const name = String(value).replace(/^node:/, "").toLowerCase();
  if (/^(?:python(?:3(?:\.\d+)?)?|pip(?:3)?|uvx?)$/.test(name)) return "python-runtime";
  if (/^litellm(?:[-_].*)?$/.test(name)) return "litellm-runtime";
  if (REMOVED_RUST_EXECUTABLE.test(name) || name === REMOVED_TAURI_SCOPE || name.startsWith(REMOVED_TAURI_SCOPE + "/")) return "rust-tauri-runtime";
  return null;
}
function commandSegments(value) {
  const segments = []; let quote = "", escaped = false, start = 0, substitutions = 0;
  const source = String(value);
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (character === "(" && index > 0 && ["$", "<", ">"].includes(source[index - 1])) { substitutions += 1; continue; }
    if (character === ")" && substitutions > 0) { substitutions -= 1; continue; }
    if (substitutions) continue;
    const ampersand = character === "&" && source[index - 1] !== ">" && source[index - 1] !== "<" && source[index + 1] !== ">";
    const chained = character === ";" || character === "|" || ampersand;
    if (!chained) continue;
    const segment = source.slice(start, index).trim(); if (segment) segments.push(segment);
    start = index + (character === "&" && source[index + 1] === "&" ? 2 : 1);
  }
  const final = source.slice(start).trim(); if (final) segments.push(final);
  return quote || substitutions ? null : segments;
}
function unquoteToken(value) {
  const token = String(value).trim();
  return token.length >= 2 && ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) ? token.slice(1, -1) : token;
}
const SAFE_SHELL_COMMANDS = new Set(["[", "]", "cd", "echo", "false", "mkdir", "mv", "node", "printf", "pwd", "rm", "set", "sleep", "test", "true"]);
function commandKindSingle(value) {
  const source = String(value).trim();
  if (!source) return ["runtime-command-unresolved"];
  if ((source.startsWith("(") && source.endsWith(")")) || (source.startsWith("{") && source.endsWith("}"))) {
    const nested = commandKinds(source.slice(1, -1));
    return nested ? ["runtime-command-unresolved", ...nested] : ["runtime-command-unresolved"];
  }
  const parts = source.match(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s])+/g) || [];
  let index = 0, command = unquoteToken(parts[index] || "");
  if (path.posix.basename(command) === "env") {
    index += 1;
    while (parts[index] && (/^-/.test(parts[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[index]))) index += 1;
    command = unquoteToken(parts[index] || "");
    if (!command) return ["runtime-command-unresolved"];
  }
  if (["sh", "bash", "zsh", "pwsh", "powershell"].includes(path.posix.basename(command).toLowerCase())) {
    const option = parts.findIndex((part, partIndex) => partIndex > index && part === "-c");
    if (option !== -1 && parts[option + 1]) return commandKinds(unquoteToken(parts[option + 1]));
    return ["runtime-command-unresolved"];
  }
  if (["if", "then", "else", "elif", "do", "done", "fi", "for", "while", "case", "esac"].includes(command)) {
    const nested = commandKinds(source.slice(command.length).trim());
    return nested ? ["runtime-command-unresolved", ...nested] : ["runtime-command-unresolved"];
  }
  if (["eval", "command", "xargs"].includes(command)) {
    const nested = commandKinds(unquoteToken(source.slice(command.length).trim()));
    return nested ? ["runtime-command-unresolved", ...nested] : ["runtime-command-unresolved"];
  }
  const removed = removedKind(path.posix.basename(command));
  if (removed) return [removed];
  return SAFE_SHELL_COMMANDS.has(path.posix.basename(command)) ? [] : ["runtime-command-unresolved"];
}
function commandKinds(value) {
  const segments = commandSegments(value);
  if (!segments) return null;
  return segments.flatMap((segment) => {
    const kinds = commandKindSingle(segment);
    return Array.isArray(kinds) ? kinds : ["runtime-command-unresolved"];
  });
}
function admittedShellFindings(kinds, sourceTrusted) {
  return (kinds || ["runtime-command-unresolved"]).filter((kind) => kind !== "runtime-command-unresolved" || !sourceTrusted);
}
function balancedShellCommand(source, opening) {
  let depth = 1, quote = "", escaped = false;
  for (let index = opening + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return { command: source.slice(opening + 1, index), end: index };
  }
  return null;
}
function shellSubstitutionKinds(value) {
  const source = String(value), findings = []; let quote = "", escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote === "'") { if (character === "'") quote = ""; continue; }
    if (character === "\"") { quote = quote ? "" : "\""; continue; }
    if (character === "'") { quote = "'"; continue; }
    if (character === "`") {
      const end = source.indexOf("`", index + 1); if (end === -1) return null;
      const nested = shellSubstitutionKinds(source.slice(index + 1, end)), kinds = commandKinds(source.slice(index + 1, end));
      if (!nested || !kinds) return null;
      findings.push(...nested, ...kinds); index = end; continue;
    }
    if (["$", "<", ">"].includes(character) && source[index + 1] === "(") {
      const nestedCommand = balancedShellCommand(source, index + 1); if (!nestedCommand) return null;
      const nested = shellSubstitutionKinds(nestedCommand.command), kinds = commandKinds(nestedCommand.command);
      if (!nested || !kinds) return null;
      findings.push(...nested, ...kinds); index = nestedCommand.end;
    }
  }
  return findings;
}
function normalized(value) { return String(value).replace(/\s+/g, ""); }
function parseChildProcessNames(binding, separator, bindings) {
  for (const raw of binding.split(",")) {
    const [operation, alias = operation] = raw.trim().split(separator).map((value) => value.trim());
    if (CHILD_PROCESS_OPERATIONS.has(operation) && /^[A-Za-z_$][\w$]*$/.test(alias)) bindings.set(alias, operation);
  }
}
function childProcessBindings(code) {
  const bindings = new Map(), namespaces = new Set();
  const module = "(?:node:)?child_process";
  for (const match of code.matchAll(new RegExp("\\bimport\\s*{([^}]+)}\\s*from\\s*[\"']" + module + "[\"']", "g"))) parseChildProcessNames(match[1], /\s+as\s+/, bindings);
  for (const match of code.matchAll(new RegExp("\\bimport\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*[\"']" + module + "[\"']", "g"))) namespaces.add(match[1]);
  for (const match of code.matchAll(new RegExp("\\bconst\\s*{([^}]+)}\\s*=\\s*(?:await\\s+)?(?:import|require)\\s*\\(\\s*[\"']" + module + "[\"']\\s*\\)", "g"))) parseChildProcessNames(match[1], /\s*:\s*/, bindings);
  for (const match of code.matchAll(new RegExp("\\bimport\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*[\"']" + module + "[\"']", "g"))) namespaces.add(match[1]);
  for (const match of code.matchAll(new RegExp("\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:import|require)\\s*\\(\\s*[\"']" + module + "[\"']\\s*\\)", "g"))) namespaces.add(match[1]);
  return { bindings, namespaces };
}
function permittedVariableCommand(relative, operation, callee, argument, source, callIndex) {
  const normalizedArgument = normalized(argument);
  return VARIABLE_CHILD_PROCESS_PROVENANCE.some((entry) => {
    if (entry.path !== relative || entry.operation !== operation || entry.callee !== callee || entry.argument !== normalizedArgument) return false;
    return hash(Buffer.from(source, "utf8")) === entry.sourceDigest;
  });
}
function childProcessCommands(relative, source) {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "");
  const { bindings, namespaces } = childProcessBindings(code);
  if (!bindings.size && !namespaces.size) return [];
  const findings = [];
  for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(\s*([^,\)\r\n]+)/g)) {
    const callee = match[1], [namespace, member] = callee.split(".");
    const operation = member ? (namespaces.has(namespace) && CHILD_PROCESS_OPERATIONS.has(member) ? member : undefined) : bindings.get(callee);
    if (!operation) continue;
    const argument = match[2].trim();
    const literal = /^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)')$/.exec(argument);
    if (!literal) {
      if (!permittedVariableCommand(relative, operation, callee, argument, source, match.index)) findings.push("runtime-command-unresolved");
      continue;
    }
    findings.push(...(commandKinds(literal[1] ?? literal[2]) || ["runtime-command-unresolved"]));
  }
  return findings;
}
function scriptCommands(relative, entry, source) {
  const lines = source.split(/\r?\n/);
  const shebang = lines.find((line) => line.startsWith("#!")) || "";
  const sourceTrusted = VARIABLE_SHELL_COMMAND_SOURCE_DIGESTS[relative] === hash(Buffer.from(source, "utf8"));
  const interpreterKinds = (entry.mode & 0o111) !== 0 && shebang ? commandKinds(shebang.slice(2)) : [];
  const shellShebang = /\b(?:sh|bash|zsh|pwsh|powershell)(?:\s|$)/i.test(shebang);
  if (!shellShebang && interpreterKinds?.length) return admittedShellFindings(interpreterKinds, sourceTrusted);
  if ((entry.mode & 0o111) === 0 || (!/\.(?:sh|ps1)$/i.test(relative) && !/\b(?:sh|bash|zsh|pwsh|powershell)(?:\s|$)/i.test(shebang))) return [];
  const findings = [], variables = new Map();
  let continued = false;
  for (const raw of lines) {
    if (continued) { continued = /\\\s*$/.test(raw); continue; }
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    continued = /\\\s*$/.test(line);
    const statements = commandSegments(line);
    if (!statements) { if (!sourceTrusted) findings.push("runtime-command-unresolved"); continue; }
    for (const statement of statements) {
      let current = statement.trim(); if (!current) continue;
      const substitutions = shellSubstitutionKinds(current);
      if (!substitutions) { findings.push("runtime-command-unresolved"); continue; }
      findings.push(...admittedShellFindings(substitutions, sourceTrusted));
      current = current.replace(/^(?:export|readonly|local|typeset)\s+/, "");
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\$\([^)]*\))|([^\s]+))$/.exec(current);
      if (assignment) { variables.set(assignment[1], assignment[2] ?? assignment[3] ?? assignment[4] ?? assignment[5]); continue; }
      current = current.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, "").replace(/^(?:&\s*|exec\s+|command\s+|Start-Process\s+)/i, "");
      const command = current.split(/\s+/)[0];
      const variable = /^(?:"|')?\$(?:\{)?([A-Za-z_][A-Za-z0-9_]*)(?:\})?(?:"|')?$/.exec(command);
      if (variable) {
        const value = variables.get(variable[1]);
        const kinds = value && commandKinds(`${value} ${current.slice(command.length).trim()}`);
        if (kinds?.length) findings.push(...admittedShellFindings(kinds, sourceTrusted));
        else if (!sourceTrusted) findings.push("runtime-command-unresolved");
        continue;
      }
      if (!command || /^[&]/.test(command)) { findings.push("runtime-command-unresolved"); continue; }
      const kinds = commandKinds(current);
      findings.push(...admittedShellFindings(kinds, sourceTrusted));
    }
  }
  return findings;
}
function semanticRuntimeReferences(relative, entry) {
  const findings = [];
  let source; try { source = new TextDecoder("utf-8", { fatal: true }).decode(entry.data); } catch { return findings; }
  if (/\.(?:cjs|js|mjs)$/i.test(relative)) for (const specifier of staticSpecifiers(source)) {
    const kind = removedKind(specifier); if (kind) findings.push(kind);
  }
  if (/\.(?:cjs|js|mjs)$/i.test(relative)) findings.push(...childProcessCommands(relative, source));
  findings.push(...scriptCommands(relative, entry, source));
  if (path.posix.basename(relative) === "package.json") {
    const value = parseJson(entry);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) for (const dependency of Object.keys(value?.[field] || {})) {
      const kind = removedKind(dependency); if (kind) findings.push(kind);
    }
  }
  if (/\.plist$/i.test(relative)) {
    const xml = source.replace(/<!--[\s\S]*?-->/g, "");
    for (const match of xml.matchAll(/<string>([^<]+)<\/string>/g)) {
      const command = path.posix.basename(match[1].trim().split(/\s+/)[0]);
      const kind = removedKind(command); if (kind) findings.push(kind);
    }
  }
  return findings;
}
function removedRuntime(entries) {
  const findings = [];
  for (const [relative, entry] of entries) {
    for (const [kind, pattern] of FORBIDDEN_PATHS) if (pattern.test(relative)) findings.push(finding(kind, relative, "forbidden removed-runtime artifact path"));
    if (entry.type !== "file") continue;
    const name = path.posix.basename(relative).toLowerCase();
    const executable = (entry.mode & 0o111) !== 0 ? removedKind(name) : null;
    if (executable) findings.push(finding(executable, relative, "forbidden removed-runtime executable name"));
    for (const kind of semanticRuntimeReferences(relative, entry)) findings.push(finding(kind, relative, "forbidden removed-runtime import, dependency, or service command"));
  }
  return findings;
}
function audit(entries) {
  const findings = [];
  for (const required of REQUIRED) if (!entries.has(required)) findings.push(finding("required-artifact-missing", required, "required Node-native release artifact is absent"));
  const executable = entries.get(APP_EXECUTABLE);
  if (executable && (executable.type !== "file" || executable.mode !== 0o755)) findings.push(finding("app-executable-invalid", APP_EXECUTABLE, "built Model Router.app executable must be a 0755 regular file"));
  const registryAudit = registry(entries);
  findings.push(...runtimePackage(entries), ...registryAudit.findings, ...catalogs(entries, registryAudit.routes), ...removedRuntime(entries));
  return findings;
}
function release(root, names) {
  const findings = [], archives = names.filter((name) => name.startsWith("codex-router-") && name.endsWith(".tar.gz")), archiveName = archives.find((name) => SEMVER.test(name.slice(13, -7)));
  if (names.length !== 3 || archives.length !== 1 || !archiveName || ![archiveName, "manifest.json", "SHA256SUMS"].every((name) => names.includes(name))) findings.push(finding("release-output-invalid", ".", "release output must contain exactly archive, manifest, and checksums"));
  const archive = archiveName ? readRelease(root, archiveName, LIMIT.outer, findings) : null, manifestBytes = readRelease(root, "manifest.json", LIMIT.manifest, findings), sums = readRelease(root, "SHA256SUMS", LIMIT.sums, findings);
  if (archive && manifestBytes && sums) {
    let lines = []; try { const text = new TextDecoder("utf-8", { fatal: true }).decode(sums); lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : []; } catch {}
    const expected = new Map([[archiveName, hash(archive)], ["manifest.json", hash(manifestBytes)]]), actual = new Map();
    for (const line of lines) { const match = /^([0-9a-f]{64}) {2}([^\s]+)$/.exec(line); if (match && !actual.has(match[2])) actual.set(match[2], match[1]); }
    if (lines.length !== 2 || actual.size !== 2 || [...expected].some(([name, digest]) => actual.get(name) !== digest)) findings.push(finding("release-checksum-invalid", "SHA256SUMS", "checksum manifest must exactly match release artifacts"));
  }
  const listed = manifestBytes && archiveName ? manifest(manifestBytes, archiveName, findings) : null;
  if (!archive || !listed || findings.length) return findings;
  let parsed; try { parsed = parseUstar(gunzipSync(archive, { maxOutputLength: LIMIT.unpacked }), archiveName); } catch { findings.push(finding("release-archive-invalid", archiveName, "release archive cannot be decompressed within the audit limit")); return findings; }
  findings.push(...parsed.findings); if (parsed.findings.length) return findings;
  const actual = new Map(parsed.entries.map((entry) => [entry.path, entry]));
  for (const [relative, expected] of listed) { const entry = actual.get(relative); if (!entry || entry.type !== expected.type || entry.mode !== Number.parseInt(expected.mode, 8) || entry.bytes !== expected.bytes || hash(entry.data) !== expected.sha256) findings.push(finding("release-manifest-mismatch", relative, "manifest metadata does not match archive entry")); }
  for (const relative of actual.keys()) if (!listed.has(relative)) findings.push(finding("release-manifest-mismatch", relative, "archive entry is absent from manifest"));
  if (findings.length) return findings;
  const logical = new Map();
  for (const entry of parsed.entries) {
    if (entry.path === "codex-router" && entry.type === "directory") continue;
    if (!entry.path.startsWith("codex-router/")) { findings.push(finding("release-tar-path-invalid", entry.path, "release entry is outside the logical package root")); continue; }
    const relative = entry.path.slice(13); if (!safePath(relative) || logical.has(relative)) findings.push(finding("release-tar-path-invalid", entry.path, "release logical path is invalid or duplicated")); else logical.set(relative, entry);
  }
  if (!findings.length) findings.push(...audit(logical));
  return findings;
}
function walk(root) {
  const entries = [], findings = [], pending = [{ full: root, relative: "", depth: 0 }]; let total = 0;
  while (pending.length) {
    const current = pending.pop();
    let names;
    try { names = readdirSync(current.full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { findings.push(finding("artifact-directory-unreadable", current.relative || ".", "artifact directory cannot be read")); continue; }
    for (const item of names) {
      const relative = current.relative ? current.relative + "/" + item.name : item.name;
      if (!safePath(relative)) { findings.push(finding("artifact-path-invalid", relative, "artifact path is not canonical")); continue; }
      if (entries.length >= LIMIT.entries) { findings.push(finding("artifact-entry-limit", relative, "artifact entry count exceeds the audit limit")); return { entries, findings }; }
      const full = path.join(root, ...relative.split("/")); let info;
      try { info = lstatSync(full); } catch { findings.push(finding("artifact-entry-unreadable", relative, "artifact entry cannot be inspected")); continue; }
      const mode = info.mode & 0o777;
      if (info.isSymbolicLink()) { entries.push({ path: relative, type: "symlink", mode, bytes: 0 }); continue; }
      if (info.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode, bytes: 0 });
        if (current.depth + 1 > LIMIT.depth) { findings.push(finding("artifact-depth-limit", relative, "artifact directory depth exceeds the audit limit")); continue; }
        pending.push({ full, relative, depth: current.depth + 1 });
        continue;
      }
      if (!info.isFile()) { entries.push({ path: relative, type: "special", mode, bytes: 0 }); continue; }
      if (info.nlink !== 1) { entries.push({ path: relative, type: "hardlink", mode, bytes: info.size }); continue; }
      if (info.size > LIMIT.file) { entries.push({ path: relative, type: "oversize", mode, bytes: info.size }); findings.push(finding("artifact-too-large", relative, "artifact file exceeds the audit limit")); continue; }
      total += info.size;
      if (total > LIMIT.unpacked) { entries.push({ path: relative, type: "oversize", mode, bytes: info.size }); findings.push(finding("artifact-total-limit", relative, "artifact contents exceed the audit limit")); return { entries, findings }; }
      try { entries.push({ path: relative, type: "file", mode, bytes: info.size, data: readFileSync(full) }); } catch { findings.push(finding("artifact-entry-unreadable", relative, "artifact file cannot be read")); }
    }
  }
  return { entries, findings };
}

export function loadAcceptanceMatrix(matrixPath = MATRIX_PATH) {
  const parsed = JSON.parse(readFileSync(matrixPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("acceptance matrix must be an array");
  const ids = new Set(), requirementIds = new Set();
  for (const theme of parsed) {
    if (!theme || typeof theme !== "object" || Array.isArray(theme) || Object.keys(theme).some((key) => !["id", "oracle", "owners", "requiredEvidence"].includes(key))) throw new Error("acceptance matrix theme has invalid fields");
    if (typeof theme.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(theme.id) || ids.has(theme.id)) throw new Error("acceptance matrix has an invalid or duplicate id"); ids.add(theme.id);
    if (!safePath(theme.oracle) || !existsSync(path.join(ROOT, theme.oracle))) throw new Error("acceptance matrix theme has a missing oracle: " + theme.id);
    if (!Array.isArray(theme.owners) || !theme.owners.length || theme.owners.some((owner) => !safePath(owner) || !existsSync(path.join(ROOT, owner)))) throw new Error("acceptance matrix theme has a missing owner: " + theme.id);
    if (!Array.isArray(theme.requiredEvidence) || !theme.requiredEvidence.length) throw new Error("acceptance matrix theme has no evidence: " + theme.id);
    for (const evidence of theme.requiredEvidence) {
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).some((key) => !["kind", "initialState", "allowedNotRunReasons", "requirementId", "profile", "provider"].includes(key)) || !EVIDENCE[evidence.kind] || !["pending", "not_run"].includes(evidence.initialState) || !/^[a-z0-9][a-z0-9._-]+$/.test(evidence.requirementId || "") || requirementIds.has(evidence.requirementId) || !/^[a-z0-9][a-z0-9._-]+$/.test(evidence.profile || "") || !Array.isArray(evidence.allowedNotRunReasons) || evidence.allowedNotRunReasons.some((reason) => typeof reason !== "string" || !reason)) throw new Error("acceptance matrix theme has invalid evidence: " + theme.id);
      requirementIds.add(evidence.requirementId);
      const provider = evidence.provider;
      if (evidence.kind === "live") {
        if (!PROVIDERS.has(provider)) throw new Error("acceptance matrix live evidence needs a supported provider: " + theme.id);
      } else if (provider !== undefined && provider !== null) throw new Error("acceptance matrix non-live evidence cannot name a provider: " + theme.id);
      if (evidence.initialState === "not_run") {
        if (evidence.kind !== "live" || provider === "deepseek" || evidence.allowedNotRunReasons.length !== 1 || evidence.allowedNotRunReasons[0] !== OUT_OF_SCOPE) throw new Error("acceptance matrix not-run evidence needs an out-of-scope non-DeepSeek provider: " + theme.id);
      } else if (evidence.kind === "live" && provider === "deepseek") {
        if (evidence.allowedNotRunReasons.length !== 1 || evidence.allowedNotRunReasons[0] !== DEEPSEEK_QUOTA) throw new Error("acceptance matrix DeepSeek live evidence needs quota approval state: " + theme.id);
      } else if (evidence.allowedNotRunReasons.length) throw new Error("acceptance matrix pending evidence cannot declare a not-run reason: " + theme.id);
    }
  }
  return parsed;
}
export function loadAcceptanceOracle(oraclePath) {
  let parsed; try { parsed = JSON.parse(readFileSync(oraclePath, "utf8")); } catch { throw new Error("acceptance oracle must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.rows)) throw new Error("acceptance oracle has an invalid schema");
  const ids = new Set();
  for (const row of parsed.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(row.id) || ids.has(row.id)) throw new Error("acceptance oracle has an invalid or duplicate row");
    const contract = row.contract;
    if (!contract || typeof contract !== "object" || Array.isArray(contract) || (!Object.hasOwn(contract, "fixture") && !Object.hasOwn(contract, "input")) || (!Object.hasOwn(contract, "expected") && !Object.hasOwn(contract, "boundary") && !Object.hasOwn(contract, "error"))) throw new Error("acceptance oracle row requires an independent behavior contract");
    ids.add(row.id);
  }
  return parsed;
}
export function verifyNodeOnlyBuild(artifactRoot) {
  let root = path.resolve(artifactRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) return [finding("artifact-root-missing", ".", "artifact root must be a real directory")];
  try { root = realpathSync(root); } catch { return [finding("artifact-root-missing", ".", "artifact root must be a real directory")]; }
  const names = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name);
  if (names.includes("manifest.json") || names.includes("SHA256SUMS") || names.some((name) => name.startsWith("codex-router-") && name.endsWith(".tar.gz"))) return release(root, names).sort((a, b) => (a.path + ":" + a.kind).localeCompare(b.path + ":" + b.kind));
  const walked = walk(root), findings = [...walked.findings], entries = new Map();
  for (const entry of walked.entries) {
    if (entry.type === "symlink") findings.push(finding("symlink-artifact", entry.path, "release artifact must not be a symlink or junction"));
    else if (entry.type === "hardlink") findings.push(finding("hardlink-artifact", entry.path, "release artifact must not be a hard link"));
    else if (entry.type === "special") findings.push(finding("special-artifact", entry.path, "release artifact must be a regular file or directory"));
    else entries.set(entry.path, entry);
  }
  findings.push(...audit(entries));
  return findings.sort((a, b) => (a.path + ":" + a.kind).localeCompare(b.path + ":" + b.kind));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifactRoot = process.argv[2];
  if (!artifactRoot) { process.stderr.write("Usage: node scripts/verify-node-only-build.mjs ARTIFACT_ROOT\n"); process.exitCode = 2; }
  else { const findings = verifyNodeOnlyBuild(artifactRoot); if (findings.length) { process.stdout.write(JSON.stringify({ status: "failed", findings }, null, 2) + "\n"); process.exitCode = 1; } else process.stdout.write(JSON.stringify({ status: "passed", artifactRoot: path.resolve(artifactRoot), findings: [] }, null, 2) + "\n"); }
}
