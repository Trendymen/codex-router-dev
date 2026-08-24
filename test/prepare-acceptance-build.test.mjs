import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyCliIsolationRoot } from "../scripts/prepare-acceptance-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(root, "scripts", "prepare-acceptance-build.mjs");

function run(args, cwd = root) {
  return spawnSync(process.execPath, [tool, ...args], { cwd, encoding: "utf8" });
}

test("prepare 从指定提交创建隔离、可复现的 build-only manifest", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-"));
  try {
    const isolation = path.join(temp, "isolated");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const result = run(["prepare", "--isolation-root", isolation, "--source-commit", commit, "--dry-run"], temp);
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = path.join(isolation, "acceptance-build.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.sourceCommit, commit);
    assert.equal(manifest.buildOnly, true);
    assert.equal(manifest.bundlePath, path.join(manifest.buildRoot, "Applications", "Model Router.app"));
    for (const value of [manifest.isolationRoot, manifest.sourceRoot, manifest.fixtureContext, manifest.bundlePath, manifest.buildRoot]) {
      assert.equal(path.isAbsolute(value), true);
      assert.equal(path.relative(realpathSync(isolation), value).startsWith(".."), false, value);
    }
    assert.equal(existsSync(path.join(manifest.sourceRoot, "scripts", "build-macos-tray-app.sh")), true);
    assert.equal(existsSync(manifest.fixtureContext), true);
    const fixture = JSON.parse(readFileSync(manifest.fixtureContext, "utf8"));
    assert.equal(fixture.mode, "acceptance");
    assert.equal(fixture.buildOnly, true);
    assert.notEqual(fixture.target.routerLabel, "io.github.codex-router");
    assert.notEqual(fixture.target.ports.router, 4202);
    for (const wrapper of Object.values(manifest.wrappers)) {
      assert.equal(path.isAbsolute(wrapper.tool.path), true);
      assert.equal(existsSync(wrapper.tool.path), true);
      assert.equal(wrapper.tool.path, realpathSync(process.execPath));
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("prepare CLI 从仓库 cwd 接受相对 isolation root，但 manifest 与后续命令保持 absolute", () => {
  const relative = path.join("generated", "acceptance", `relative-contract-${process.pid}-${Date.now()}`);
  const absoluteRoot = path.join(root, relative);
  try {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const prepared = run(["prepare", "--isolation-root", relative, "--source-commit", commit, "--dry-run"], root);
    assert.equal(prepared.status, 0, prepared.stderr);
    const manifest = JSON.parse(readFileSync(path.join(absoluteRoot, "acceptance-build.json"), "utf8"));
    for (const value of [manifest.isolationRoot, manifest.sourceRoot, manifest.fixtureContext, manifest.buildRoot, manifest.bundlePath, manifest.catalogTooling.path]) {
      assert.equal(path.isAbsolute(value), true);
      assert.equal(path.relative(realpathSync(absoluteRoot), value).startsWith(".."), false);
    }
    const outside = mkdtempSync(path.join(os.tmpdir(), "acceptance-relative-cwd-"));
    const evidence = path.join(relative, "evidence.json");
    for (const action of ["test-swift", "build-swift"]) assert.equal(run([action, "--manifest", path.join(relative, "acceptance-build.json"), "--evidence", evidence], root).status, 0);
    assert.equal(run(["finalize", "--manifest", path.join(relative, "acceptance-build.json")], root).status, 0);
    assert.equal(existsSync(path.join(absoluteRoot, "evidence.json")), true);
    try { for (const action of ["test-swift", "build-swift", "finalize"]) assert.equal(run([action, "--manifest", path.join(absoluteRoot, "acceptance-build.json")], outside).status, 0); }
    finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(absoluteRoot, { recursive: true, force: true }); }
});

test("prepare 在写入前拒绝缺失 value flag 与 fully-existing symlink relative root", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-cli-"));
  try {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const decoy = path.join(temp, "decoy"); mkdirSync(decoy);
    const missing = run(["prepare", "--isolation-root", "--source-commit", commit, "--dry-run"], temp);
    assert.equal(missing.status, 2); assert.equal(existsSync(path.join(temp, "--source-commit")), false);
    const outside = path.join(temp, "outside"); mkdirSync(path.join(outside, "child"), { recursive: true }); symlinkSync(outside, path.join(temp, "link"));
    const linked = run(["prepare", "--isolation-root", "link/child", "--source-commit", commit, "--dry-run"], temp);
    assert.equal(linked.status, 2); assert.equal(existsSync(path.join(outside, "child", ".acceptance-build-owner.json")), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("POSIX CLI relative root 在写入前拒绝反斜杠歧义", { skip: path.sep !== "/" }, () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-backslash-"));
  try {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const result = run(["prepare", "--isolation-root", "a\\b", "--source-commit", commit, "--dry-run"], temp);
    assert.equal(result.status, 2); assert.equal(existsSync(path.join(temp, "a\\b")), false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("pure CLI path classifier uses Windows lexical semantics before filesystem access", () => {
  assert.deepEqual(classifyCliIsolationRoot("safe\\nested", path.win32), { absolute: false, value: "safe\\nested", components: ["safe", "nested"] });
  assert.deepEqual(classifyCliIsolationRoot("C:\\isolated", path.win32), { absolute: true, value: "C:\\isolated" });
  for (const value of ["C:", "C:relative", "\\rooted", "/rooted", "\\\\server\\share", "//server/share", "\\\\?\\C:\\x", "\\\\.\\pipe"]) assert.throws(() => classifyCliIsolationRoot(value, path.win32));
});

test("Swift 子命令只消费 manifest 的绝对路径，并拒绝非受管或生产构建", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-cwd-"));
  try {
    const isolation = path.join(temp, "isolated");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    assert.equal(run(["prepare", "--isolation-root", isolation, "--source-commit", commit, "--dry-run"], temp).status, 0);
    const manifest = path.join(isolation, "acceptance-build.json");
    for (const action of ["test-swift", "build-swift", "finalize"]) {
      const result = run([action, "--manifest", manifest], temp);
      assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    }
    assert.notEqual(run(["prepare", "--isolation-root", root, "--source-commit", commit], temp).status, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("prepare 拒绝非受管非空根和符号链接根", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-refuse-"));
  try {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const occupied = path.join(temp, "occupied");
    mkdirSync(occupied);
    writeFileSync(path.join(occupied, "other-owner"), "nope\n");
    symlinkSync(temp, path.join(temp, "linked"));
    assert.notEqual(run(["prepare", "--isolation-root", occupied, "--source-commit", commit], temp).status, 0);
    assert.notEqual(run(["prepare", "--isolation-root", path.join(temp, "linked"), "--source-commit", commit], temp).status, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("dry-run 不能记录 passed，且每个子命令复核树、fixture 与 manifest 完整性", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-integrity-"));
  try {
    const isolation = path.join(temp, "isolated");
    const evidence = path.join(temp, "evidence.json");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    assert.equal(run(["prepare", "--isolation-root", isolation, "--source-commit", commit, "--dry-run"], temp).status, 0);
    const manifest = path.join(isolation, "acceptance-build.json");
    assert.equal(run(["test-swift", "--manifest", manifest, "--evidence", evidence], temp).status, 0);
    const recorded = JSON.parse(readFileSync(evidence, "utf8")).entries.at(-1);
    assert.equal(recorded.state, "pending");
    writeFileSync(path.join(isolation, "source", "package.json"), "tampered\n");
    const finalized = run(["finalize", "--manifest", manifest], temp);
    assert.notEqual(finalized.status, 0);
    assert.match(finalized.stderr, /digest|integrity|materialized/i);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("完整 Swift dry-run 序列为 test/build 分别记录既有 r40/r46，wrapper 篡改会阻止 finalize", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-sequence-"));
  try {
    const isolation = path.join(temp, "isolated");
    const evidence = path.join(temp, "evidence.json");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const verifier = path.join(root, "scripts", "verify-acceptance.mjs");
    assert.equal(spawnSync(process.execPath, [verifier, "begin-final", "--evidence", evidence, "--source-commit", commit], { encoding: "utf8" }).status, 0);
    assert.equal(run(["prepare", "--isolation-root", isolation, "--source-commit", commit, "--dry-run"], temp).status, 0);
    const manifest = path.join(isolation, "acceptance-build.json");
    for (const action of ["test-swift", "build-swift", "finalize"]) assert.equal(run([action, "--manifest", manifest, ...(action === "finalize" ? [] : ["--evidence", evidence])], temp).status, 0);
    const entries = JSON.parse(readFileSync(evidence, "utf8")).entries;
    assert.deepEqual(entries.map(({ requirementId }) => requirementId).sort(), ["r40", "r46"]);
    writeFileSync(path.join(isolation, "tools", "swift"), "#!/bin/sh\necho tampered\n");
    assert.notEqual(run(["finalize", "--manifest", manifest], temp).status, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("真实 prepare 输出只缺完整 app，补齐固定 app 后 audit CLI 严格通过且不保留 catalog staging", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-audit-"));
  try {
    const isolation = path.join(temp, "isolated");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    assert.equal(run(["prepare", "--isolation-root", isolation, "--source-commit", commit, "--dry-run"], temp).status, 0);
    const buildRoot = path.join(isolation, "build-root");
    const audit = () => spawnSync(process.execPath, [path.join(root, "scripts", "verify-node-only-build.mjs"), buildRoot], { cwd: temp, encoding: "utf8" });
    const initial = audit();
    assert.notEqual(initial.status, 0);
    assert.deepEqual(JSON.parse(initial.stdout).findings.map(({ kind, path: findingPath }) => `${kind}:${findingPath}`).sort(), [
      "required-artifact-missing:Applications/Model Router.app/Contents/Info.plist",
      "required-artifact-missing:Applications/Model Router.app/Contents/MacOS/ModelRouterTray",
      "required-artifact-missing:Applications/Model Router.app/Contents/Resources/AppIcon.icns",
    ]);
    for (const [relative, contents, mode] of [["Applications/Model Router.app/Contents/Info.plist", "plist", 0o644], ["Applications/Model Router.app/Contents/MacOS/ModelRouterTray", "binary", 0o755], ["Applications/Model Router.app/Contents/Resources/AppIcon.icns", "icon", 0o644]]) {
      const target = path.join(buildRoot, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, contents); chmodSync(target, mode);
    }
    const complete = audit();
    assert.equal(complete.status, 0, complete.stderr);
    assert.deepEqual(JSON.parse(complete.stdout).findings, []);
    assert.equal(existsSync(path.join(buildRoot, ".catalog-generation")), false);
    for (const relative of ["README.md", "LICENSE", "bin/model-router", "runtime-package.json", "catalogs/merged-models.json", "catalogs/routed-models.json"]) assert.equal(existsSync(path.join(buildRoot, relative)), true, relative);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("prepare 的 materialized registry 在 hostile external registry 环境下仍可导入且精确为 12 routes", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-registry-"));
  try {
    const isolation = path.join(temp, "isolated"), hostile = path.join(temp, "hostile.json");
    writeFileSync(hostile, JSON.stringify({ version: 1, providers: [], models: [{ slug: "hostile/model" }] }));
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const prepared = spawnSync(process.execPath, [tool, "prepare", "--isolation-root", isolation, "--source-commit", commit, "--dry-run"], { cwd: temp, encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: hostile, CODEX_ROUTER_REGISTRY: hostile } });
    assert.equal(prepared.status, 0, prepared.stderr);
    const probe = 'import { MODEL_BY_SLUG, PROVIDERS } from "./src/model-registry.mjs"; process.stdout.write(JSON.stringify({ slugs:[...MODEL_BY_SLUG.keys()].sort(), providers:[...PROVIDERS.keys()].sort() }));';
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: path.join(isolation, "build-root"), encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: path.join(isolation, "build-root", "config"), CODEX_ROUTER_REGISTRY: path.join(isolation, "build-root", "config") } });
    assert.equal(result.status, 0, result.stderr);
    const expected = Object.keys(JSON.parse(readFileSync(path.join(root, "test", "fixtures", "node-route-matrix.json"), "utf8"))).sort();
    const registry = JSON.parse(result.stdout);
    assert.deepEqual(registry.slugs, expected);
    assert.equal(registry.providers.length > 0, true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("catalog tooling 只执行物化 lock 的 offline npm ci，忽略 hostile NODE_PATH 依赖", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "acceptance-build-tooling-"));
  try {
    const hostileRoot = path.join(temp, "hostile-node-modules");
    mkdirSync(path.join(hostileRoot, "proper-lockfile"), { recursive: true });
    writeFileSync(path.join(hostileRoot, "proper-lockfile", "index.js"), "throw new Error('hostile dependency executed');\n");
    const isolation = path.join(temp, "isolated");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const result = spawnSync(process.execPath, [tool, "prepare", "--isolation-root", isolation, "--source-commit", commit, "--dry-run"], { cwd: temp, encoding: "utf8", env: { ...process.env, NODE_PATH: hostileRoot } });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(path.join(isolation, "acceptance-build.json"), "utf8"));
    assert.match(manifest.catalogTooling.command, /^npm ci .*--ignore-scripts.*--offline/);
    assert.equal(existsSync(path.join(manifest.catalogTooling.path, "package-lock.json")), true);
    assert.equal(existsSync(path.join(manifest.catalogTooling.path, "node_modules", "proper-lockfile")), true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
