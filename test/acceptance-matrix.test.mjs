import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { loadAcceptanceMatrix, verifyNodeOnlyBuild } from "../scripts/verify-node-only-build.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeOracle = JSON.parse(readFileSync(path.join(repoRoot, "test", "fixtures", "node-route-matrix.json"), "utf8"));
const expectedThemeIds = Object.freeze([
  "reasoning-identity-state", "reasoning-stream-final", "reasoning-abort-nonstream", "reasoning-errors",
  "stable-routes", "experimental-proof-gates",
  "tool-names-conversion", "forced-tool-boundaries", "glm-messages-continuation",
  "retry", "failover", "ownership-writes", "catalog-lifecycle-atomicity", "capability-command-ui", "protocol-proof-lifecycle",
  "upgrade-preservation", "platform-removal", "vision-allow", "public-errors", "redaction-leaks", "write-sessions", "browser-security",
  "testing-unit", "testing-node-build", "testing-swift-build", "testing-runtime", "testing-live-provider",
  "success-node-router", "success-desktop-app", "success-browser-panel", "success-catalog", "success-upgrade", "success-platform", "success-vision", "success-public-errors", "success-testing-evidence",
]);
const expectedProfiles = Object.freeze([
  "task1-artifact-audit", "task1-build", "task1-node-check", "task1-node-test", "task1-swift-build",
  "task2-isolated-install", "task3-runtime", "task3-ui", "task3-visual", "task4-live",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function octalField(header, offset, width, value) {
  header.write(value.toString(8).padStart(width - 1, "0"), offset, width - 1, "ascii");
  header[offset + width - 1] = 0;
}

function tarArchive(entries) {
  const chunks = [];
  for (const { path: relative, data = Buffer.alloc(0), mode = 0o644 } of entries) {
    const header = Buffer.alloc(512);
    header.write(relative, 0, "utf8");
    octalField(header, 100, 8, mode);
    octalField(header, 108, 8, 0);
    octalField(header, 116, 8, 0);
    octalField(header, 124, 12, data.byteLength);
    octalField(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = [...header].reduce((total, byte) => total + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    chunks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function releaseFixture(entries) {
  const root = mkdtempSync(path.join(os.tmpdir(), "node-only-release-audit-"));
  const archiveName = "codex-router-1.2.3.tar.gz";
  const files = entries.map(({ path: relative, data = Buffer.alloc(0), mode = 0o644 }) => ({
    path: relative, type: "file", mode: `0${mode.toString(8).padStart(3, "0")}`, bytes: data.byteLength, sha256: sha256(data),
  }));
  const archive = gzipSync(tarArchive(entries));
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, packageVersion: "1.2.3", sourceCommit: "a".repeat(40), target: "codex", platform: "darwin", runtime: "node", packageKind: "runtime", runtimeMetadata: "runtime-package.json", files,
  }, null, 2)}\n`);
  writeFileSync(path.join(root, archiveName), archive);
  writeFileSync(path.join(root, "manifest.json"), manifest);
  writeFileSync(path.join(root, "SHA256SUMS"), `${sha256(archive)}  ${archiveName}\n${sha256(manifest)}  manifest.json\n`);
  return root;
}

function routeFile(slug) {
  if (slug.startsWith("deepseek/")) return `config/deepseek/${slug.slice("deepseek/".length)}.json`;
  if (slug.startsWith("qwen-plan-responses/")) return `config/qwen/plan/${slug.slice("qwen-plan-responses/".length)}-responses.json`;
  if (slug.startsWith("qwen-plan/")) return `config/qwen/plan/${slug.slice("qwen-plan/".length)}.json`;
  throw new Error(`unexpected checked-in Node route ${slug}`);
}

function write(relative, value, root, mode = 0o644) {
  const target = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value, { mode });
  chmodSync(target, mode);
  return target;
}

function catalogModel(model) {
  return {
    slug: model.slug,
    display_name: model.displayName,
    description: model.description,
    priority: model.priority,
    context_window: model.contextWindow,
    input_modalities: model.inputModalities,
    base_instructions: "You are Codex.",
    model_messages: { instructions_template: "You are Codex." },
    supports_parallel_tool_calls: false,
  };
}

function expectedBuildRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "node-only-expected-build-"));
  write("runtime-package.json", JSON.stringify({
    schemaVersion: 1,
    target: "codex",
    platform: "darwin",
    runtime: "node",
    entrypoints: ["src/start.mjs"],
    assets: ["apps/desktop/ui", "Applications/Model Router.app", "config", "catalogs"],
    docs: ["README.md"],
  }), root);
  write("src/start.mjs", 'import "./runtime.mjs";\n', root);
  write("src/runtime.mjs", "export const runtime = 'node';\n", root);
  for (const relative of ["index.html", "app.js", "model.mjs", "thinking-orb.mjs", "i18n.mjs", "styles.css"]) write(`apps/desktop/ui/${relative}`, "artifact\n", root);
  write("README.md", "artifact\n", root);
  const routeModels = [];
  for (const slug of Object.keys(routeOracle)) {
    const relative = routeFile(slug);
    const source = path.join(repoRoot, ...relative.split("/"));
    const target = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
    routeModels.push(JSON.parse(readFileSync(source, "utf8")).models[0]);
  }
  for (const relative of ["config/deepseek/deepseek.json", "config/qwen/qwen.json"]) {
    const source = path.join(repoRoot, ...relative.split("/"));
    const target = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target);
  }
  const catalog = { models: routeModels.map(catalogModel) };
  write("catalogs/merged-models.json", JSON.stringify(catalog), root);
  write("catalogs/routed-models.json", JSON.stringify(catalog), root);
  const bundle = "Applications/Model Router.app/Contents";
  write(`${bundle}/MacOS/ModelRouterTray`, "binary\n", root, 0o755);
  write(`${bundle}/Info.plist`, "<plist version=\"1.0\"/>\n", root);
  write(`${bundle}/Resources/AppIcon.icns`, "icon\n", root);
  return root;
}

function findingsFor(root) {
  return verifyNodeOnlyBuild(root).map(({ kind, path: relative }) => `${kind}:${relative}`);
}

function releaseEntries(root, relative = "") {
  const entries = [];
  for (const item of readdirSync(path.join(root, ...relative.split("/").filter(Boolean)))) {
    const child = relative ? `${relative}/${item}` : item;
    const full = path.join(root, ...child.split("/"));
    if (statSync(full).isDirectory()) entries.push(...releaseEntries(root, child));
    else entries.push({ path: `codex-router/${child}`, data: readFileSync(full), mode: statSync(full).mode & 0o777 });
  }
  return entries;
}

test("紧凑验收矩阵仅索引 36 个主题、专项 oracle、owner 和证据状态", () => {
  const matrix = loadAcceptanceMatrix();
  assert.deepEqual(matrix.map(({ id }) => id), expectedThemeIds);
  const referenced = new Set(), requirementIds = new Set(), profiles = new Set();
  for (const theme of matrix) {
    assert.deepEqual(Object.keys(theme).sort(), ["id", "oracle", "owners", "requiredEvidence"]);
    assert.ok(existsSync(path.join(repoRoot, theme.oracle)), `${theme.id} oracle missing`);
    referenced.add(theme.oracle);
    assert.ok(theme.owners.length > 0, `${theme.id} needs an owner`);
    for (const owner of theme.owners) assert.ok(existsSync(path.join(repoRoot, owner)), `${theme.id} owner missing: ${owner}`);
    for (const evidence of theme.requiredEvidence) {
      assert.deepEqual(Object.keys(evidence).sort(), ["allowedNotRunReasons", "initialState", "kind", "profile", "provider", "requirementId"]);
      assert.match(evidence.kind, /^(?:unit|build|runtime|ui|visual|isolated-install|live)$/);
      assert.match(evidence.initialState, /^(?:pending|not_run)$/);
      assert.match(evidence.requirementId, /^[a-z0-9][a-z0-9._-]+$/);
      assert.equal(requirementIds.has(evidence.requirementId), false, `duplicate requirementId: ${evidence.requirementId}`);
      requirementIds.add(evidence.requirementId);
      assert.match(evidence.profile, /^[a-z0-9][a-z0-9._-]+$/);
      profiles.add(evidence.profile);
      if (evidence.kind === "live") assert.match(evidence.provider, /^(?:deepseek|qwen-plan|bailian|glm)$/);
      else assert.equal(evidence.provider, null, `${evidence.requirementId}: non-live evidence has no provider`);
      if (evidence.kind === "visual") assert.equal(evidence.initialState, "pending", "tests/builds never substitute for visual acceptance");
      if (evidence.kind === "live" && evidence.provider === "deepseek") assert.deepEqual(evidence.allowedNotRunReasons, ["quota_approval_absent"]);
      if (evidence.kind === "live" && evidence.initialState === "not_run") assert.deepEqual(evidence.allowedNotRunReasons, ["out_of_current_provider_scope"]);
    }
  }
  assert.equal(referenced.size, 11, "every checked-in specialist oracle is referenced");
  assert.equal(requirementIds.size, 61, "each required evidence row has its own requirement identity");
  assert.deepEqual([...profiles].sort(), expectedProfiles);
});

test("紧凑验收矩阵拒绝旧逐条账本和非法 evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "acceptance-matrix-schema-"));
  try {
    const matrixPath = path.join(root, "matrix.json");
    const theme = {
      id: "per-requirement-row", oracle: "test/acceptance/oracles/reasoning.json", owners: ["src/router.mjs"],
      requiredEvidence: [{ kind: "visual", requirementId: "r01", profile: "task3-visual", provider: null, initialState: "passed", allowedNotRunReasons: [] }], requirement: "copied prose",
    };
    writeFileSync(matrixPath, JSON.stringify([theme]));
    assert.throws(() => loadAcceptanceMatrix(matrixPath), /invalid|evidence|owner|matrix/i);
    theme.requirement = undefined;
    delete theme.requirement;
    theme.requiredEvidence = [
      { kind: "unit", requirementId: "r01", profile: "task1-node-test", provider: null, initialState: "pending", allowedNotRunReasons: [] },
      { kind: "live", requirementId: "r01", profile: "task4-live", provider: "qwen-plan", initialState: "not_run", allowedNotRunReasons: ["out_of_current_provider_scope"] },
    ];
    writeFileSync(matrixPath, JSON.stringify([theme]));
    assert.throws(() => loadAcceptanceMatrix(matrixPath), /invalid|duplicate|evidence/i);
    theme.requiredEvidence[1] = { kind: "live", requirementId: "r02", profile: "task4-live", provider: "deepseek", initialState: "not_run", allowedNotRunReasons: ["out_of_current_provider_scope"] };
    writeFileSync(matrixPath, JSON.stringify([theme]));
    assert.throws(() => loadAcceptanceMatrix(matrixPath), /DeepSeek|not-run|evidence/i);
    theme.requiredEvidence[1] = { kind: "unit", requirementId: "r02", profile: "task1-node-test", provider: "glm", initialState: "pending", allowedNotRunReasons: [] };
    writeFileSync(matrixPath, JSON.stringify([theme]));
    assert.throws(() => loadAcceptanceMatrix(matrixPath), /provider|evidence/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release archive applies the same runtime-package closure audit as an unpacked build root", () => {
  const root = releaseFixture([
    { path: "codex-router/runtime-package.json", data: Buffer.from(JSON.stringify({
      schemaVersion: 1, target: "codex", platform: "darwin", runtime: "node", entrypoints: ["src/start.mjs"], assets: ["apps/desktop/ui"], docs: ["README.md"],
    })) },
    { path: "codex-router/src/start.mjs", data: Buffer.from('import "./missing.mjs";\n') },
    { path: "codex-router/apps/desktop/ui/index.html", data: Buffer.from("<main />\n") },
    { path: "codex-router/README.md", data: Buffer.from("docs\n") },
  ]);
  try {
    const findings = verifyNodeOnlyBuild(root);
    assert.ok(findings.some(({ kind, path: relative }) => kind === "runtime-import-missing" && relative === "src/missing.mjs"), findings.map(({ kind, path: relative }) => `${kind}:${relative}`).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release archive rejects a runtime-package asset absent from its logical artifact map", () => {
  const root = releaseFixture([
    { path: "codex-router/runtime-package.json", data: Buffer.from(JSON.stringify({
      schemaVersion: 1, target: "codex", platform: "darwin", runtime: "node", entrypoints: ["src/start.mjs"], assets: ["apps/macos/ModelRouterTray"], docs: ["README.md"],
    })) },
    { path: "codex-router/src/start.mjs", data: Buffer.from("export {};\n") },
    { path: "codex-router/README.md", data: Buffer.from("docs\n") },
  ]);
  try {
    const findings = verifyNodeOnlyBuild(root);
    assert.ok(findings.some(({ kind, path: relative }) => kind === "runtime-package-missing" && relative === "apps/macos/ModelRouterTray"), findings.map(({ kind, path: relative }) => `${kind}:${relative}`).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("预期 build-root 使用 checked-in 的 12 条 Node route oracle 并通过完整产物审计", { skip: process.platform === "win32" }, () => {
  const root = expectedBuildRoot();
  try {
    assert.equal(Object.keys(routeOracle).length, 12, "fixture is the complete Node route oracle");
    assert.deepEqual(verifyNodeOnlyBuild(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("同一完整逻辑 artifact map 在未打包根与 release archive 都通过审计", { skip: process.platform === "win32" }, () => {
  const unpacked = expectedBuildRoot();
  let releaseRoot;
  try {
    assert.deepEqual(verifyNodeOnlyBuild(unpacked), []);
    releaseRoot = releaseFixture(releaseEntries(unpacked));
    assert.deepEqual(verifyNodeOnlyBuild(releaseRoot), []);
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
    if (releaseRoot) rmSync(releaseRoot, { recursive: true, force: true });
  }
});

test("产物审计要求 runtime metadata、两个 catalog 与已构建的 Model Router.app", () => {
  const cases = [
    ["runtime-package.json", "runtime-package-missing:runtime-package.json"],
    ["catalogs/merged-models.json", "catalog-missing:catalogs/merged-models.json"],
    ["Applications/Model Router.app/Contents/MacOS/ModelRouterTray", "required-artifact-missing:Applications/Model Router.app/Contents/MacOS/ModelRouterTray"],
  ];
  for (const [relative, expected] of cases) {
    const root = expectedBuildRoot();
    try {
      rmSync(path.join(root, ...relative.split("/")), { recursive: true, force: true });
      assert.ok(findingsFor(root).includes(expected), `${relative}: ${findingsFor(root).join(", ")}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("产物审计要求已构建 app 的可执行文件具有 0755 模式", () => {
  const root = expectedBuildRoot();
  try {
    const executable = path.join(root, "Applications", "Model Router.app", "Contents", "MacOS", "ModelRouterTray");
    chmodSync(executable, 0o644);
    assert.ok(findingsFor(root).includes("app-executable-invalid:Applications/Model Router.app/Contents/MacOS/ModelRouterTray"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("产物审计精确覆盖 fixture 的 12 条 route：额外、重复和每个规范字段不一致都失败", () => {
  const fieldToArtifact = Object.freeze({
    gatewayModel: "gatewayModel",
    provider: "provider",
    credentialOwner: "credentialOwner",
    upstreamModel: "upstreamModel",
    transport: "effectiveTransport",
    toolDialect: "toolDialect",
    reasoningDisplayMode: "reasoningDisplayMode",
    finalShape: "declaredFinalReasoningShape",
    purpose: "purpose",
    rollout: "rolloutState",
    listed: "listed",
  });
  for (const [slug, expected] of Object.entries(routeOracle)) {
    for (const [field, artifactField] of Object.entries(fieldToArtifact)) {
      const root = expectedBuildRoot();
      try {
        const file = path.join(root, ...routeFile(slug).split("/"));
        const document = JSON.parse(readFileSync(file, "utf8"));
        document.models[0][artifactField] = typeof expected[field] === "boolean" ? !expected[field] : `${expected[field]}-wrong`;
        writeFileSync(file, JSON.stringify(document));
        assert.ok(findingsFor(root).includes(`registry-model-mismatch:${slug}`), `${slug}/${field}: ${findingsFor(root).join(", ")}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
  const root = expectedBuildRoot();
  try {
    const first = Object.keys(routeOracle)[0];
    const duplicate = path.join(root, "config", "qwen", "plan", "duplicate-route.json");
    mkdirSync(path.dirname(duplicate), { recursive: true });
    cpSync(path.join(root, ...routeFile(first).split("/")), duplicate);
    assert.ok(findingsFor(root).includes(`registry-model-duplicate:${first}`), findingsFor(root).join(", "));
    const extra = JSON.parse(readFileSync(duplicate, "utf8"));
    extra.models[0].slug = "qwen-plan/unapproved-extra";
    writeFileSync(duplicate, JSON.stringify(extra));
    assert.ok(findingsFor(root).includes("registry-model-extra:qwen-plan/unapproved-extra"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact audit 只将具备完整 Node-route 边界字段的模型纳入 Appendix B 闭集", { skip: process.platform === "win32" }, () => {
  const root = expectedBuildRoot();
  try {
    write("config/other/ordinary-model.json", JSON.stringify({
      version: 1,
      models: [{ slug: "other/ordinary", provider: "other", gatewayModel: "ordinary", listed: true }],
    }), root);
    assert.deepEqual(verifyNodeOnlyBuild(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact audit 验证 Node route 的 provider 与 request-profile 闭包", () => {
  for (const [relative, expected] of [
    ["config/deepseek/deepseek.json", "registry-provider-missing:deepseek"],
    ["config/qwen/qwen.json", "registry-provider-missing:qwen-plan"],
  ]) {
    const root = expectedBuildRoot();
    try {
      rmSync(path.join(root, ...relative.split("/")));
      assert.ok(findingsFor(root).includes(expected), findingsFor(root).join(", "));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const root = expectedBuildRoot();
  try {
    const route = path.join(root, ...routeFile("deepseek/deepseek-v4-flash").split("/"));
    const document = JSON.parse(readFileSync(route, "utf8"));
    document.models[0].requestProfile = "unresolved-profile";
    writeFileSync(route, JSON.stringify(document));
    assert.ok(findingsFor(root).includes("registry-request-profile-invalid:deepseek/deepseek-v4-flash"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact audit 要求 merged/routed catalogs 精确映射 12 条 public Node routes", () => {
  const root = expectedBuildRoot();
  try {
    write("catalogs/merged-models.json", JSON.stringify({ models: [] }), root);
    assert.ok(findingsFor(root).includes("catalog-route-set-mismatch:catalogs/merged-models.json"), findingsFor(root).join(", "));
    const routed = JSON.parse(readFileSync(path.join(root, "catalogs", "routed-models.json"), "utf8"));
    routed.models.push(catalogModel({ slug: "qwen-plan/unapproved", displayName: "Extra", description: "Extra", priority: 1, contextWindow: 1, inputModalities: ["text"] }));
    write("catalogs/routed-models.json", JSON.stringify(routed), root);
    assert.ok(findingsFor(root).includes("catalog-route-set-mismatch:catalogs/routed-models.json"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
  const mismatchRoot = expectedBuildRoot();
  try {
    const merged = JSON.parse(readFileSync(path.join(mismatchRoot, "catalogs", "merged-models.json"), "utf8"));
    merged.models[0].display_name = "Wrong public name";
    write("catalogs/merged-models.json", JSON.stringify(merged), mismatchRoot);
    assert.ok(findingsFor(mismatchRoot).includes(`catalog-route-mismatch:${merged.models[0].slug}`), findingsFor(mismatchRoot).join(", "));
  } finally { rmSync(mismatchRoot, { recursive: true, force: true }); }
});

test("未打包产物在读取文件前拒绝空目录 runtime、过深树、过大 sparse 文件", () => {
  const root = expectedBuildRoot();
  try {
    mkdirSync(path.join(root, "vendor", "venv"), { recursive: true });
    const deep = Array.from({ length: 129 }, (_, index) => `d${index}`).join("/");
    mkdirSync(path.join(root, ...deep.split("/")), { recursive: true });
    const sparse = write("large-sparse.bin", "", root);
    truncateSync(sparse, 64 * 1024 * 1024 + 1);
    const findings = findingsFor(root);
    assert.ok(findings.includes("python-runtime:vendor/venv"), findings.join(", "));
    assert.ok(findings.includes(`artifact-depth-limit:${deep}`), findings.join(", "));
    assert.ok(findings.includes("artifact-too-large:large-sparse.bin"), findings.join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed-runtime 审计仅判定路径、可执行文件、依赖/import 与 service 命令，不误报注释", () => {
  const root = expectedBuildRoot();
  try {
    write("src/comment-only.mjs", "// cargo rustc @tauri-apps tauri:: litellm python\nexport {};\n", root);
    assert.equal(findingsFor(root).filter((value) => /^(?:python-runtime|litellm-runtime|rust-tauri-runtime):src\/comment-only\.mjs$/.test(value)).length, 0, findingsFor(root).join(", "));
    write("bin/python", "#!/bin/sh\nexit 0\n", root, 0o755);
    assert.ok(findingsFor(root).includes("python-runtime:bin/python"), findingsFor(root).join(", "));
    write("package.json", JSON.stringify({ dependencies: { litellm: "1.0.0" } }), root);
    assert.ok(findingsFor(root).includes("litellm-runtime:package.json"), findingsFor(root).join(", "));
    write("package.json", JSON.stringify({ dependencies: { "@tauri-apps/api": "1.0.0" } }), root);
    assert.ok(findingsFor(root).includes("rust-tauri-runtime:package.json"), findingsFor(root).join(", "));
    write("LaunchAgents/router.plist", "<plist><array><string>/usr/bin/python3</string></array></plist>", root);
    assert.ok(findingsFor(root).includes("python-runtime:LaunchAgents/router.plist"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed-runtime 审计识别 literal dynamic import、child_process 与可执行脚本命令，并拒绝不可证明命令", () => {
  const root = expectedBuildRoot();
  try {
    write("src/dynamic-import.mjs", 'import("litellm");\n', root);
    assert.ok(findingsFor(root).includes("litellm-runtime:src/dynamic-import.mjs"), findingsFor(root).join(", "));
    write("src/static-imports.mjs", [
      'import "litellm";',
      'export * from "litellm";',
      'require("litellm");',
    ].join("\n"), root);
    assert.equal(findingsFor(root).filter((value) => value === "litellm-runtime:src/static-imports.mjs").length, 3, findingsFor(root).join(", "));
    write("src/child-process.mjs", [
      'import { spawn, exec, execFile, fork } from "node:child_process";',
      'spawn("python3", []);',
      'exec("pip install example");',
      'execFile("uv", ["run"]);',
      'fork("cargo");',
    ].join("\n"), root);
    const childFindings = findingsFor(root);
    for (const kind of ["python-runtime", "rust-tauri-runtime"]) assert.ok(childFindings.includes(`${kind}:src/child-process.mjs`), childFindings.join(", "));
    assert.equal(childFindings.filter((value) => /^(?:python-runtime|rust-tauri-runtime):src\/child-process\.mjs$/.test(value)).length, 4, childFindings.join(", "));
    write("bin/legacy.sh", "#!/bin/sh\npython3 -m pip install example\n", root, 0o755);
    assert.ok(findingsFor(root).includes("python-runtime:bin/legacy.sh"), findingsFor(root).join(", "));
    write("scripts/legacy.ps1", "& rustc --version\n", root, 0o755);
    assert.ok(findingsFor(root).includes("rust-tauri-runtime:scripts/legacy.ps1"), findingsFor(root).join(", "));
    write("src/indirect-command.mjs", 'import { spawn } from "node:child_process";\nspawn(command, []);\n', root);
    assert.ok(findingsFor(root).includes("runtime-command-unresolved:src/indirect-command.mjs"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed-runtime 审计追踪 child_process binding 形态、无扩展 shebang 与已赋值 shell 变量", () => {
  const root = expectedBuildRoot();
  try {
    write("src/bound-child-process.mjs", [
      'import { spawn as launch } from "node:child_process";',
      'import * as child from "node:child_process";',
      'const { execFile: invoke } = require("node:child_process");',
      'const common = require("node:child_process");',
      'const { fork: later } = await import("node:child_process");',
      'launch("python3", []);',
      'child.exec("pip install example");',
      'invoke("uv", ["run"]);',
      'common.spawn("litellm", []);',
      'later("cargo");',
    ].join("\n"), root);
    const bindingFindings = findingsFor(root).filter((value) => value.endsWith(":src/bound-child-process.mjs"));
    assert.equal(bindingFindings.filter((value) => value === "python-runtime:src/bound-child-process.mjs").length, 3, bindingFindings.join(", "));
    assert.equal(bindingFindings.filter((value) => value === "litellm-runtime:src/bound-child-process.mjs").length, 1, bindingFindings.join(", "));
    assert.equal(bindingFindings.filter((value) => value === "rust-tauri-runtime:src/bound-child-process.mjs").length, 1, bindingFindings.join(", "));
    write("bin/shebang-node-runtime", "#!/usr/bin/env bash\npython3 -m pip install example\n", root, 0o755);
    assert.ok(findingsFor(root).includes("python-runtime:bin/shebang-node-runtime"), findingsFor(root).join(", "));
    write("bin/variable-node-runtime", "#!/bin/zsh\ncmd=python3; \"$cmd\" -m pip install example\n", root, 0o755);
    assert.ok(findingsFor(root).includes("python-runtime:bin/variable-node-runtime"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact audit 仅放行绑定来源的合法 production variable child_process callsite", () => {
  const root = expectedBuildRoot();
  try {
    cpSync(path.join(repoRoot, "src", "node-runtime.mjs"), path.join(root, "src", "node-runtime.mjs"));
    const findings = findingsFor(root);
    assert.equal(findings.includes("runtime-command-unresolved:src/node-runtime.mjs"), false, findings.join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed-runtime 审计覆盖 default import、wrapper 链、Python shebang，且 provenance 不接受注释伪锚点", () => {
  const root = expectedBuildRoot();
  try {
    write("src/default-child-process.mjs", 'import child from "node:child_process";\nchild.spawn("python3", []);\nchild.exec("env python3 -m pip install example");\n', root);
    assert.equal(findingsFor(root).filter((value) => value === "python-runtime:src/default-child-process.mjs").length, 2, findingsFor(root).join(", "));
    write("bin/python-shebang", "#!/usr/bin/env python3\nprint('bad')\n", root, 0o755);
    assert.ok(findingsFor(root).includes("python-runtime:bin/python-shebang"), findingsFor(root).join(", "));
    write("scripts/build-macos-tray-app.sh", "#!/bin/sh\nswift_bin=$ATTACKER; \"$swift_bin\" build\n", root, 0o755);
    assert.ok(findingsFor(root).includes("runtime-command-unresolved:scripts/build-macos-tray-app.sh"), findingsFor(root).join(", "));
    write("src/node-runtime.mjs", [
      'import { spawn as spawnProcess } from "node:child_process";',
      '// const command = spawnableCommand(spec.command, spec.args || []);',
      'spawnProcess(command.command, command.args, {});',
    ].join("\n"), root);
    assert.ok(findingsFor(root).includes("runtime-command-unresolved:src/node-runtime.mjs"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed-runtime 审计将完整 shell wrapper 行交给命令解析器，并在重赋值后撤销 provenance", () => {
  const root = expectedBuildRoot();
  try {
    write("bin/wrapper-chain", "#!/bin/sh\n/usr/bin/env python3 -V\n/bin/sh -c \"python3 -V\"\n", root, 0o755);
    assert.equal(findingsFor(root).filter((value) => value === "python-runtime:bin/wrapper-chain").length, 2, findingsFor(root).join(", "));
    write("src/node-runtime.mjs", [
      'import { spawn as spawnProcess } from "node:child_process";',
      'const command = spawnableCommand(spec.command, spec.args || []);',
      'command.command = "python3";',
      'spawnProcess(command.command, command.args, {});',
    ].join("\n"), root);
    assert.ok(findingsFor(root).includes("runtime-command-unresolved:src/node-runtime.mjs"), findingsFor(root).join(", "));
    write("scripts/build-macos-tray-app.sh", "#!/bin/sh\nswift_bin=swift; swift_bin=$(context_field tools.swift); \"$swift_bin\" build\n", root, 0o755);
    assert.ok(findingsFor(root).includes("runtime-command-unresolved:scripts/build-macos-tray-app.sh"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed-runtime 审计拒绝等价 JS 写入，并扫描 exec 与 shell 的后续命令链", () => {
  const root = expectedBuildRoot();
  try {
    write("src/node-runtime.mjs", [
      'import { spawn as spawnProcess, exec } from "node:child_process";',
      'const command = spawnableCommand(spec.command, spec.args || []);',
      'command["command"] = "python3";',
      'Object.assign(command, { command: "python3" });',
      'spawnProcess(command.command, command.args, {});',
      'exec("echo ok; python3 -V");',
    ].join("\n"), root);
    const jsFindings = findingsFor(root);
    assert.ok(jsFindings.includes("runtime-command-unresolved:src/node-runtime.mjs"), jsFindings.join(", "));
    assert.ok(jsFindings.includes("python-runtime:src/node-runtime.mjs"), jsFindings.join(", "));
    write("bin/chained-shell", "#!/bin/sh\necho ok && python3 -V || echo no | cat\n", root, 0o755);
    assert.ok(findingsFor(root).includes("python-runtime:bin/chained-shell"), findingsFor(root).join(", "));
    write("scripts/build-macos-tray-app.sh", "#!/bin/sh\nexport swift_bin=python3; \"$swift_bin\" -V\n", root, 0o755);
    assert.ok(findingsFor(root).includes("python-runtime:scripts/build-macos-tray-app.sh"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("合法变量命令放行绑定 exact source identity，任意同路径 drift 都撤销", () => {
  const root = expectedBuildRoot();
  try {
    const source = path.join(repoRoot, "src", "node-runtime.mjs");
    const target = path.join(root, "src", "node-runtime.mjs");
    cpSync(source, target);
    assert.equal(findingsFor(root).includes("runtime-command-unresolved:src/node-runtime.mjs"), false, findingsFor(root).join(", "));
    writeFileSync(target, `${readFileSync(target, "utf8")}\n// source identity drift\n`);
    assert.ok(findingsFor(root).includes("runtime-command-unresolved:src/node-runtime.mjs"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("已登记的 production variable-command source identity 集合不产生 unresolved", () => {
  const root = expectedBuildRoot();
  try {
    for (const relative of ["bin/model-router", "bin/model-router-tray", "bin/subagent-preset", "bin/update", "scripts/build-macos-tray-app.sh"]) {
      const target = path.join(root, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(path.join(repoRoot, ...relative.split("/")), target);
    }
    assert.equal(findingsFor(root).filter((value) => value.startsWith("runtime-command-unresolved:")).length, 0, findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removed-runtime 审计覆盖 shell 引号、后台链与所有命令替换，并拒绝 digest 不匹配的伪 context_field", () => {
  const root = expectedBuildRoot();
  try {
    write("bin/shell-substitutions", [
      "#!/bin/sh",
      '"/usr/bin/python3" -V',
      "echo ok & python3 -V",
      "value=$(python3 -V); echo \"$value\"",
      "echo `python3 -V`",
      "echo <(python3 -V)",
    ].join("\n"), root, 0o755);
    assert.equal(findingsFor(root).filter((value) => value === "python-runtime:bin/shell-substitutions").length, 5, findingsFor(root).join(", "));
    write("scripts/build-macos-tray-app.sh", [
      "#!/bin/sh",
      "context_field() { node tray-build-plan.mjs --fixture-field \"$fixture_context\" \"$1\"; }",
      "swift_bin=$(context_field tools.swift); \"$swift_bin\" build",
    ].join("\n"), root, 0o755);
    assert.ok(findingsFor(root).includes("runtime-command-unresolved:scripts/build-macos-tray-app.sh"), findingsFor(root).join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unregistered executable shell 对未知、grouping、控制流与 eval 维持 explicit unresolved/removed 三态", () => {
  const root = expectedBuildRoot();
  try {
    write("bin/tri-state-shell", [
      "#!/bin/sh",
      "unknown-benign-wrapper --help",
      "(python3 -V)",
      "if true; then python3 -V; fi",
      'eval "python3 -V"',
    ].join("\n"), root, 0o755);
    const findings = findingsFor(root);
    assert.ok(findings.includes("runtime-command-unresolved:bin/tri-state-shell"), findings.join(", "));
    assert.equal(findings.filter((value) => value === "python-runtime:bin/tri-state-shell").length, 3, findings.join(", "));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact audit reports internal symlinks and duplicate checked-in registry slugs", () => {
  const root = expectedBuildRoot();
  try {
    const flash = path.join(root, ...routeFile("deepseek/deepseek-v4-flash").split("/"));
    const duplicate = path.join(root, "config", "qwen", "plan", "duplicate-route.json");
    cpSync(flash, duplicate);
    symlinkSync(flash, path.join(root, "linked-model.json"));
    const findings = verifyNodeOnlyBuild(root);
    assert.ok(findings.some(({ kind, path: relative }) => kind === "symlink-artifact" && relative === "linked-model.json"), JSON.stringify(findings));
    assert.ok(findings.some(({ kind, path: relative }) => kind === "registry-model-duplicate" && relative === "deepseek/deepseek-v4-flash"), JSON.stringify(findings));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
