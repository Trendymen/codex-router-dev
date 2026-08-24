import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveServiceTarget } from "../src/service-target.mjs";
import { commandOnPath, spawnableCommand } from "../src/spawnable-command.mjs";
import { readTrayFixtureContext, writeTrayFixtureContext } from "../src/tray-build-plan.mjs";
import { recordAcceptanceEvidence } from "./verify-acceptance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "codex-router-acceptance-build-v1";
const MARKER = ".acceptance-build-owner.json";
const MANIFEST = "acceptance-build.json";
const REQUIRED_SOURCE = ["scripts/build-macos-tray-app.sh", "apps/macos/ModelRouterTray/Package.swift", "apps/macos/ModelRouterTray/Resources/Info.plist", "apps/macos/ModelRouterTray/Resources/AppIcon.icns"];

function absolute(value, name) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return path.resolve(value);
}

export function classifyCliIsolationRoot(value, pathApi = path) {
  if (!value || value.startsWith("-")) throw new Error("invalid --isolation-root");
  const windows = pathApi.sep === "\\";
  if (windows) {
    if (/^(?:[\\/]|[A-Za-z]:$|[A-Za-z]:[^\\/])/.test(value)) throw new Error("relative isolationRoot is ambiguous");
    if (/^[A-Za-z]:[\\/]/.test(value) && pathApi.isAbsolute(value)) return { absolute: true, value };
    if (value.split(/[\\/]/).some((part) => part === ".." || !part)) throw new Error("relative isolationRoot is ambiguous");
    return { absolute: false, value, components: value.split(/[\\/]/) };
  }
  if (value.includes("\\") || /^[A-Za-z]:/.test(value) || /^\/\//.test(value)) throw new Error("relative isolationRoot is ambiguous");
  if (pathApi.isAbsolute(value)) return { absolute: true, value };
  if (value.split("/").some((part) => part === ".." || !part)) throw new Error("relative isolationRoot is ambiguous");
  return { absolute: false, value, components: value.split("/") };
}

function cliIsolationRoot(value) {
  const classified = classifyCliIsolationRoot(value);
  if (classified.absolute) return classified.value;
  const cwd = realpathSync(process.cwd()); let cursor = cwd;
  for (const part of classified.components) { cursor = path.join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("relative isolationRoot must not cross a symbolic link"); }
  return within(cwd, path.resolve(cwd, classified.value), "relative isolationRoot");
}

function cliManifest(value) {
  const classified = classifyCliIsolationRoot(value);
  if (classified.absolute) return classified.value;
  const cwd = realpathSync(process.cwd()); let cursor = cwd;
  for (const part of classified.components) { cursor = path.join(cursor, part); if (!existsSync(cursor) || lstatSync(cursor).isSymbolicLink()) throw new Error("relative manifest must be an existing regular file without symbolic links"); }
  const target = within(cwd, canonicalPath(path.resolve(cwd, classified.value), "manifest"), "relative manifest");
  if (!statSync(target).isFile()) throw new Error("relative manifest must be an existing regular file");
  return target;
}

function cliEvidence(value) {
  if (value === undefined) return undefined;
  const classified = classifyCliIsolationRoot(value);
  if (classified.absolute) return classified.value;
  const cwd = realpathSync(process.cwd()); let cursor = cwd;
  for (const part of classified.components) { cursor = path.join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("relative evidence must not cross a symbolic link"); }
  const target = within(cwd, canonicalPath(path.resolve(cwd, classified.value), "evidence"), "relative evidence");
  if (existsSync(target) && !statSync(target).isFile()) throw new Error("relative evidence must be a regular file");
  return target;
}

function canonicalPath(value, name) {
  const resolved = absolute(value, name);
  const missing = [];
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`${name} has no existing ancestor`);
    missing.unshift(path.basename(ancestor)); ancestor = parent;
  }
  // `realpath` canonicalizes OS-provided aliases such as macOS /var -> /private/var.
  // The nearest existing user-supplied ancestor must itself be real: otherwise a
  // missing descendant could be created through an attacker-controlled link.
  if (lstatSync(ancestor).isSymbolicLink()) throw new Error(`${name} must not have a symbolic-link ancestor`);
  return path.join(realpathSync(ancestor), ...missing);
}

function within(root, value, name) {
  const relative = path.relative(root, value);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return value;
  throw new Error(`${name} must remain below isolationRoot`);
}

function assertNoSymlink(value, name) {
  if (existsSync(value) && lstatSync(value).isSymbolicLink()) throw new Error(`${name} must not be a symlink`);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function digestFile(file) { return sha256(readFileSync(file)); }

function digestTree(root, relative = "") {
  const hash = createHash("sha256");
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(current, entry.name), name = path.relative(root, child).split(path.sep).join("/");
      const info = lstatSync(child);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("materialized source contains an unsupported entry");
      if (info.isDirectory()) { hash.update(`d ${name}\n`); visit(child); }
      else hash.update(`f ${info.mode & 0o777} ${name} ${sha256(readFileSync(child))}\n`);
    }
  };
  visit(path.join(root, relative));
  return hash.digest("hex");
}

function manifestDigest(manifest) {
  const { manifestIntegrity, ...payload } = manifest;
  return sha256(JSON.stringify(payload));
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: options.encoding || "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function sourceCommit(commit) {
  const value = git(["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error("sourceCommit must resolve to a commit");
  return value;
}

function prepareRoot(root) {
  assertNoSymlink(root, "isolationRoot");
  if (!existsSync(root)) { mkdirSync(root, { recursive: true, mode: 0o700 }); return; }
  const names = readdirSync(root);
  if (!names.length) return;
  const marker = path.join(root, MARKER);
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink()) throw new Error("refusing nonempty isolationRoot without its acceptance marker");
  const value = JSON.parse(readFileSync(marker, "utf8"));
  if (value.owner !== OWNER) throw new Error("refusing isolationRoot owned by another process");
  for (const name of names) if (name !== MARKER) rmSync(path.join(root, name), { recursive: true, force: true });
}

function treeEntries(commit) {
  const output = execFileSync("git", ["-C", ROOT, "ls-tree", "-r", "-z", commit], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return output.toString("utf8").split("\0").filter(Boolean).map((entry) => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (!match || match[2] !== "blob" || match[1] === "120000") throw new Error("source commit contains an unsupported tree entry");
    if (match[4].startsWith("/") || match[4].split("/").some((part) => !part || part === "." || part === "..")) throw new Error("source commit contains an unsafe path");
    return { mode: Number.parseInt(match[1], 8), oid: match[3], relative: match[4] };
  });
}

function materialize(commit, destination) {
  for (const entry of treeEntries(commit)) {
    const target = within(destination, path.join(destination, entry.relative), "source entry");
    mkdirSync(path.dirname(target), { recursive: true });
    const bytes = execFileSync("git", ["-C", ROOT, "cat-file", "blob", entry.oid], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(target, bytes, { mode: entry.mode & 0o777 });
    chmodSync(target, entry.mode & 0o777);
  }
}

function toolIdentity(tool) {
  const resolved = path.isAbsolute(tool)
    ? tool
    : execFileSync("/bin/sh", ["-lc", `command -v ${tool}`], { encoding: "utf8" }).trim();
  const target = realpathSync(resolved), info = statSync(target);
  if (!info.isFile()) throw new Error(`acceptance tool is not a regular file: ${tool}`);
  return { path: target, mode: info.mode & 0o777, digest: digestFile(target) };
}

function writeWrapper(file, identity) {
  writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(identity.path)} "$@"\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  return { path: file, mode: lstatSync(file).mode & 0o777, digest: digestFile(file), tool: identity };
}

function verifyWrappers(wrappers) {
  if (!wrappers || typeof wrappers !== "object" || Array.isArray(wrappers)) throw new Error("manifest wrappers are invalid");
  for (const name of ["uname", "swift", "codesign", "plistBuddy"]) {
    const wrapper = wrappers[name];
    if (!wrapper || typeof wrapper !== "object" || wrapper.mode !== 0o700 || !/^[0-9a-f]{64}$/.test(wrapper.digest) || !wrapper.tool || !/^[0-9a-f]{64}$/.test(wrapper.tool.digest)) throw new Error("manifest wrapper integrity is invalid");
    if (!existsSync(wrapper.path) || lstatSync(wrapper.path).isSymbolicLink() || (lstatSync(wrapper.path).mode & 0o777) !== wrapper.mode || digestFile(wrapper.path) !== wrapper.digest) throw new Error("manifest wrapper digest mismatch");
    const identity = toolIdentity(wrapper.tool.path);
    if (identity.path !== wrapper.tool.path || identity.mode !== wrapper.tool.mode || identity.digest !== wrapper.tool.digest) throw new Error("manifest tool identity mismatch");
  }
}

function writeManifest(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function copyRuntimeClosure(sourceRoot, buildRoot) {
  const metadata = JSON.parse(readFileSync(path.join(sourceRoot, "runtime-package.json"), "utf8"));
  const names = new Set(["src", "bin", "apps/desktop/ui", "apps/macos/ModelRouterTray", "package.json", "package-lock.json", "runtime-package.json", ...metadata.docs, ...metadata.entrypoints]);
  for (const name of names) {
    const from = path.join(sourceRoot, name);
    if (!existsSync(from)) throw new Error(`runtime closure source is missing ${name}`);
    cpSync(from, path.join(buildRoot, name), { recursive: true, preserveTimestamps: true });
  }
}

function routeSlugs(sourceRoot) {
  return new Set(Object.keys(JSON.parse(readFileSync(path.join(sourceRoot, "test", "fixtures", "node-route-matrix.json"), "utf8"))));
}

function copyRouteRegistry(sourceRoot, buildRoot, slugs) {
  const selectedProviders = new Set(), fragments = [];
  const visit = (relative = "") => {
    for (const entry of readdirSync(path.join(sourceRoot, "config", relative), { withFileTypes: true })) {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        const from = path.join(sourceRoot, "config", child), value = JSON.parse(readFileSync(from, "utf8"));
        const models = Array.isArray(value.models) ? value.models.filter((model) => slugs.has(model?.slug)) : [];
        for (const model of models) selectedProviders.add(model.provider);
        fragments.push({ child, from, value, models });
      }
    }
  };
  visit();
  for (const { child, from, value, models } of fragments) {
    const providers = Array.isArray(value.providers) ? value.providers.filter((provider) => selectedProviders.has(provider?.id)) : [];
    if (!models.length && !providers.length) continue;
    const target = path.join(buildRoot, "config", child), mode = lstatSync(from).mode & 0o777;
    const output = { ...value, ...(Array.isArray(value.providers) ? { providers } : {}), ...(Array.isArray(value.models) ? { models } : {}) };
    mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, { mode }); chmodSync(target, mode);
  }
}

function prepareCatalogTooling(sourceRoot, root) {
  const tooling = within(root, path.join(root, "catalog-tooling"), "catalogTooling");
  for (const name of ["package.json", "package-lock.json"]) cpSync(path.join(sourceRoot, name), path.join(tooling, name));
  const npm = commandOnPath("npm");
  if (!npm) throw new Error("npm is required to prepare hash-verified catalog tooling");
  const npmConfig = spawnableCommand(npm, ["config", "get", "cache"]);
  const cache = execFileSync(npmConfig.command, npmConfig.args, { ...npmConfig.options, encoding: "utf8", windowsHide: true }).trim();
  const command = ["ci", "--ignore-scripts", "--omit=dev", "--offline", "--audit=false", "--fund=false", "--cache", cache];
  // npm's offline lockfile install is the SRI verifier. A cache miss is an
  // explicit failure; there is no network or current-node_modules fallback.
  const npmCi = spawnableCommand(npm, command);
  execFileSync(npmCi.command, npmCi.args, { ...npmCi.options, cwd: tooling, encoding: "utf8", windowsHide: true, env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" }, maxBuffer: 64 * 1024 * 1024 });
  return { path: tooling, digest: digestTree(tooling), lockDigest: sha256(readFileSync(path.join(sourceRoot, "package-lock.json"))), command: `npm ${command.join(" ")}` };
}

function generateCatalogs(sourceRoot, buildRoot, publicationRoot, tooling, slugs) {
  const producer = `
    import { readFileSync } from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const [sourceRoot, publicationRoot] = process.argv.slice(1);
    const fixture = JSON.parse(readFileSync(path.join(sourceRoot, "test", "fixtures", "node-route-matrix.json"), "utf8"));
    const wanted = new Set(Object.keys(fixture));
    const { nodeRegistryModels } = await import(pathToFileURL(path.join(sourceRoot, "src", "model-contract.mjs")).href);
    const { buildRoutedCatalog, publishCatalogGeneration } = await import(pathToFileURL(path.join(sourceRoot, "src", "catalog-generation.mjs")).href);
    const models = nodeRegistryModels().filter((model) => wanted.has(model.slug));
    if (models.length !== wanted.size || new Set(models.map((model) => model.slug)).size !== wanted.size) throw new Error("materialized registry does not contain exact route oracle");
    const routed = buildRoutedCatalog({ nativeModels: [], templateModels: [models[0]], routedModels: models });
    if (routed.models.length !== wanted.size || routed.models.some((model) => !wanted.has(model.slug))) throw new Error("production catalog did not retain exact route oracle");
    const ui = { version: 1, models: [] };
    publishCatalogGeneration({ files: { "merged-models.json": { models: routed.models }, "routed-models.json": routed, "node-routes.json": { version: 1, routes: [] }, "control-models.json": ui, "swift-models.json": ui, "browser-models.json": ui }, generationsDir: path.join(publicationRoot, "generations"), currentDir: path.join(publicationRoot, "generations", "current"), legacyPaths: {} });
  `;
  // The publisher is executed from the immutable materialized commit. Its
  // pinned runtime dependency is mounted only for this child and removed
  // before the source-tree digest is recorded.
  const modules = path.join(sourceRoot, "node_modules");
  symlinkSync(path.join(tooling.path, "node_modules"), modules);
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(?:MODEL_ROUTER|CODEX_ROUTER)_/.test(key)) delete env[key];
    Object.assign(env, {
      MODEL_ROUTER_REGISTRY: path.join(sourceRoot, "config"), CODEX_ROUTER_REGISTRY: path.join(sourceRoot, "config"),
      MODEL_ROUTER_STATE_DIR: path.join(publicationRoot, "state"), CODEX_HOME: path.join(publicationRoot, "codex-home"),
      CODEX_ROUTER_SOURCE_ROOT: sourceRoot, MODEL_ROUTER_TARGET: "codex",
    });
    execFileSync(process.execPath, ["--input-type=module", "-e", producer, sourceRoot, publicationRoot], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  } finally { rmSync(modules, { recursive: true, force: true }); }
  const catalogs = path.join(buildRoot, "catalogs");
  mkdirSync(catalogs, { recursive: true });
  for (const name of ["merged-models.json", "routed-models.json"]) writeFileSync(path.join(catalogs, name), readFileSync(path.join(publicationRoot, "generations", "current", name)), { mode: 0o600 });
  const catalog = JSON.parse(readFileSync(path.join(catalogs, "routed-models.json"), "utf8"));
  if (catalog.models.length !== slugs.size || catalog.models.some((model) => !slugs.has(model.slug))) throw new Error("published routed catalog does not match route oracle");
}

export function prepareAcceptanceBuild({ isolationRoot, sourceCommit: requestedCommit, dryRun = false }) {
  let root = canonicalPath(isolationRoot, "isolationRoot");
  const commit = sourceCommit(requestedCommit);
  prepareRoot(root);
  root = canonicalPath(root, "isolationRoot");
  writeFileSync(path.join(root, MARKER), `${JSON.stringify({ owner: OWNER })}\n`, { mode: 0o600 });
  const sourceRoot = within(root, path.join(root, "source"), "sourceRoot");
  materialize(commit, sourceRoot);
  for (const required of REQUIRED_SOURCE) if (!existsSync(path.join(sourceRoot, required))) throw new Error(`source commit missing ${required}`);
  const buildRoot = within(root, path.join(root, "build-root"), "buildRoot");
  mkdirSync(buildRoot);
  copyRuntimeClosure(sourceRoot, buildRoot);
  const slugs = routeSlugs(sourceRoot);
  copyRouteRegistry(sourceRoot, buildRoot, slugs);
  const publicationRoot = within(root, path.join(root, "catalog-publication"), "catalogPublication");
  const catalogTooling = prepareCatalogTooling(sourceRoot, root);
  try { generateCatalogs(sourceRoot, buildRoot, publicationRoot, catalogTooling, slugs); } finally { rmSync(publicationRoot, { recursive: true, force: true }); }
  const bundlePath = within(root, path.join(buildRoot, "Applications", "Model Router.app"), "bundlePath");
  const toolsRoot = within(root, path.join(root, "tools"), "toolsRoot");
  mkdirSync(toolsRoot);
  const wrappers = Object.fromEntries(["uname", "swift", "codesign", "plistBuddy"].map((name) => {
    const destination = path.join(toolsRoot, name);
    return [name, writeWrapper(destination, toolIdentity(dryRun ? process.execPath : name === "plistBuddy" ? "/usr/libexec/PlistBuddy" : name))];
  }));
  const tools = Object.fromEntries(Object.entries(wrappers).map(([name, wrapper]) => [name, wrapper.path]));
  const swiftScratchPath = within(root, path.join(buildRoot, ".swift-scratch"), "swiftScratchPath");
  const target = resolveServiceTarget({
    mode: "acceptance", isolationRoot: root, sourceRoot: buildRoot,
    appPath: bundlePath,
    routerLabel: "io.github.codex-router.acceptance.task1",
    trayLabel: "io.github.codex-router.acceptance.task1.tray",
    ports: { oauth: 5601, router: 5602, api: 5603, grokOauth: 5608, devinCli: 5610 },
  });
  const fixtureContext = within(root, path.join(root, "fixture-context.json"), "fixtureContext");
  writeTrayFixtureContext(fixtureContext, target, { tools, buildOnly: true, dryRun: Boolean(dryRun), configuration: "release" });
  const manifest = {
    schemaVersion: 3, owner: OWNER, sourceCommit: commit, sourceTreeOid: git(["rev-parse", `${commit}^{tree}`]).trim(), buildOnly: true,
    isolationRoot: root, sourceRoot, fixtureContext, bundlePath, buildRoot, executionRoot: buildRoot, swiftScratchPath,
    materializedSourceDigest: digestTree(sourceRoot), fixtureContextDigest: digestFile(fixtureContext), catalogTooling,
    wrappers,
  };
  manifest.manifestIntegrity = manifestDigest(manifest);
  writeManifest(path.join(root, MANIFEST), manifest);
  return Object.freeze(manifest);
}

function readManifest(file) {
  const manifestPath = canonicalPath(file, "manifest");
  assertNoSymlink(manifestPath, "manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.schemaVersion !== 3 || manifest.owner !== OWNER || manifest.buildOnly !== true) throw new Error("invalid acceptance build manifest");
  const root = canonicalPath(manifest.isolationRoot, "isolationRoot");
  assertNoSymlink(root, "isolationRoot");
  for (const field of ["sourceRoot", "fixtureContext", "bundlePath", "buildRoot", "executionRoot", "swiftScratchPath"]) {
    manifest[field] = within(root, canonicalPath(manifest[field], field), field);
    assertNoSymlink(manifest[field], field);
  }
  if (path.join(root, MANIFEST) !== manifestPath || !existsSync(manifest.sourceRoot) || !existsSync(manifest.fixtureContext) || !/^[0-9a-f]{40}$/.test(manifest.sourceTreeOid) || !/^[0-9a-f]{64}$/.test(manifest.materializedSourceDigest) || !/^[0-9a-f]{64}$/.test(manifest.fixtureContextDigest) || !/^[0-9a-f]{64}$/.test(manifest.manifestIntegrity)) throw new Error("manifest does not name a prepared acceptance build");
  if (git(["rev-parse", `${manifest.sourceCommit}^{tree}`]).trim() !== manifest.sourceTreeOid) throw new Error("manifest Git tree integrity mismatch");
  if (digestTree(manifest.sourceRoot) !== manifest.materializedSourceDigest) throw new Error("manifest materialized source digest mismatch");
  if (digestFile(manifest.fixtureContext) !== manifest.fixtureContextDigest) throw new Error("manifest fixture context digest mismatch");
  if (!manifest.catalogTooling || manifest.catalogTooling.path !== within(root, canonicalPath(manifest.catalogTooling.path, "catalogTooling"), "catalogTooling") || manifest.catalogTooling.digest !== digestTree(manifest.catalogTooling.path) || manifest.catalogTooling.lockDigest !== sha256(readFileSync(path.join(manifest.sourceRoot, "package-lock.json")))) throw new Error("manifest catalog tooling integrity mismatch");
  verifyWrappers(manifest.wrappers);
  if (manifestDigest(manifest) !== manifest.manifestIntegrity) throw new Error("manifest integrity mismatch");
  return Object.freeze(manifest);
}

export function executeAcceptanceSwift({ manifest, action, evidence }) {
  const prepared = readManifest(manifest);
  if (!new Set(["test-swift", "build-swift"]).has(action)) throw new Error("action must be test-swift or build-swift");
  const context = readTrayFixtureContext(prepared.fixtureContext);
  if (context.target.sourceRoot !== prepared.executionRoot || context.target.appPath !== prepared.bundlePath || context.buildOnly !== true) throw new Error("fixture context does not match manifest");
  let result = { status: 0, stdout: "", stderr: "" };
  if (!context.dryRun) {
    result = action === "test-swift"
      ? spawnSync(context.tools.swift, ["test", "--scratch-path", prepared.swiftScratchPath, "--package-path", path.join(prepared.executionRoot, "apps", "macos", "ModelRouterTray")], { cwd: prepared.executionRoot, encoding: "utf8" })
      : spawnSync(path.join(prepared.executionRoot, "scripts", "build-macos-tray-app.sh"), [prepared.bundlePath, "--fixture-context", prepared.fixtureContext], { cwd: prepared.executionRoot, encoding: "utf8" });
  }
  if (evidence) recordAcceptanceEvidence({ themeId: action === "test-swift" ? "testing-swift-build" : "success-desktop-app", kind: "build", state: context.dryRun ? "pending" : result.status === 0 ? "passed" : "failed", reason: `${action} ${context.dryRun ? "dry-run (not evidence)" : "completed"}`, artifact: prepared.buildRoot, sourceCommit: prepared.sourceCommit }, canonicalPath(evidence, "evidence"));
  if (result.status !== 0) throw new Error(`${action} failed: ${String(result.stderr || "").trim()}`);
  return prepared;
}

export function finalizeAcceptanceBuild({ manifest }) {
  const prepared = readManifest(manifest);
  // SwiftPM and the tray script may leave build/scratch links below the
  // execution tree. They are not release artifacts and must never enter the
  // logical root consumed by the audit; the fixed Applications bundle remains.
  rmSync(prepared.swiftScratchPath, { recursive: true, force: true });
  rmSync(path.join(prepared.executionRoot, "apps", "macos", "ModelRouterTray", ".build"), { recursive: true, force: true });
  return readManifest(manifest);
}

function cli() {
  const [command, ...args] = process.argv.slice(2);
  const value = (name, optional = false) => {
    const index = args.indexOf(name);
    if (index === -1) { if (optional) return undefined; throw new Error(`missing ${name}`); }
    const result = args[index + 1];
    if (!result || result.startsWith("-")) throw new Error(`missing value for ${name}`);
    return result;
  };
  if (command === "prepare") {
    const manifest = prepareAcceptanceBuild({ isolationRoot: cliIsolationRoot(value("--isolation-root")), sourceCommit: value("--source-commit"), dryRun: args.includes("--dry-run") });
    process.stdout.write(`${path.join(manifest.isolationRoot, MANIFEST)}\n`);
    return;
  }
  if (command === "test-swift" || command === "build-swift") { executeAcceptanceSwift({ manifest: cliManifest(value("--manifest")), action: command, evidence: cliEvidence(value("--evidence", true)) }); return; }
  if (command === "finalize") { finalizeAcceptanceBuild({ manifest: cliManifest(value("--manifest")) }); return; }
  throw new Error("Usage: prepare-acceptance-build prepare|test-swift|build-swift|finalize");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
