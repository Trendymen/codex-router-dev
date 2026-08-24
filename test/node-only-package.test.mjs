import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validatePathWithin } from "../src/service-target.mjs";
import { buildReleasePackage, deterministicGzip, tarBytes } from "../scripts/package-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function gitFiles() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  }).toString("utf8").split("\0").filter(Boolean);
}

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: "ignore" });
}

function fixtureRoot() {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "node-only-package-fixture-"));
  for (const relative of gitFiles()) {
    const source = path.join(root, relative);
    const destination = path.join(fixture, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { dereference: false });
  }
  // The implementation helper is deliberately copied even when this test is
  // run before the parent Task stages the new file into the source index.
  for (const relative of ["runtime-package.json", "scripts/package-release.mjs", "scripts/package-release.sh"]) {
    const source = path.join(root, relative);
    if (!lstatSync(source).isFile()) throw new Error(`fixture source is not regular: ${relative}`);
    const destination = path.join(fixture, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  runGit(fixture, ["init", "-q"]);
  runGit(fixture, ["config", "user.email", "test@example.invalid"]);
  runGit(fixture, ["config", "user.name", "Package Fixture"]);
  runGit(fixture, ["add", "-A"]);
  runGit(fixture, ["commit", "-qm", "fixture"]);
  return fixture;
}

function parseTar(archive) {
  const bytes = gunzipSync(archive);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const mode = Number.parseInt(text(100, 8).trim() || "0", 8);
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const type = text(156, 1) === "5" ? "directory" : "file";
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    entries.set((prefix ? `${prefix}/` : "") + name.replace(/\/$/, ""), { type, mode, bytes: Buffer.from(body) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function verifyPackage(result) {
  const manifestBytes = readFileSync(result.manifestPath);
  const manifest = JSON.parse(manifestBytes);
  const archiveBytes = readFileSync(result.archivePath);
  const tarEntries = parseTar(archiveBytes);
  assert.ok(manifest.files.length > 0);
  for (const entry of manifest.files) {
    const actual = tarEntries.get(entry.path);
    assert.ok(actual, `missing archive entry ${entry.path}`);
    assert.equal(actual.type, entry.type, entry.path);
    assert.equal(actual.mode, Number.parseInt(entry.mode, 8), entry.path);
    assert.equal(entry.bytes, actual.type === "file" ? actual.bytes.byteLength : 0, entry.path);
    assert.equal(entry.sha256, sha256(actual.type === "file" ? actual.bytes : Buffer.alloc(0)), entry.path);
  }
  assert.equal(tarEntries.size, manifest.files.length);
  const checksum = readFileSync(result.checksumPath, "utf8").trim().split(/\s+/);
  assert.deepEqual(checksum, [sha256(archiveBytes), path.basename(result.archivePath), sha256(manifestBytes), path.basename(result.manifestPath)]);
  return {
    manifest,
    archiveBytes,
    manifestBytes,
    checksumBytes: readFileSync(result.checksumPath),
    archivePath: result.archivePath,
    manifestPath: result.manifestPath,
    checksumPath: result.checksumPath,
  };
}

test("release package is built from tracked regular files and has a verified deterministic manifest", () => {
  const fixture = fixtureRoot();
  const firstOutput = mkdtempSync(path.join(os.tmpdir(), "node-only-package-out-"));
  const secondOutput = mkdtempSync(path.join(os.tmpdir(), "node-only-package-out-"));
  try {
    writeFileSync(path.join(fixture, "src", "untracked-secret.txt"), "MUST NOT SHIP\n");
    const first = verifyPackage(buildReleasePackage({ sourceRoot: fixture, outputDir: firstOutput }));
    const second = verifyPackage(buildReleasePackage({ sourceRoot: fixture, outputDir: secondOutput }));
    assert.deepEqual(first.archiveBytes, second.archiveBytes);
    assert.deepEqual(first.manifestBytes, second.manifestBytes);
    assert.deepEqual(first.checksumBytes, second.checksumBytes);
    assert.equal(first.manifest.files.some(({ path: relative }) => relative.includes("untracked-secret")), false);
    assert.equal(first.manifest.files.some(({ path: relative }) => relative.endsWith("apps/desktop/ui/index.html")), true);
    assert.equal(first.manifest.files.some(({ path: relative }) => relative.endsWith("apps/macos/ModelRouterTray/Package.swift")), true);
    assert.equal(first.manifest.files.some(({ path: relative }) => relative.endsWith("config/deepseek/deepseek.json")), true);
    assert.ok(first.manifest.files.every(({ type, mode, bytes, sha256: digest }) =>
      ["file", "directory"].includes(type) && /^0[0-7]{3}$/.test(mode) && Number.isInteger(bytes) && /^[0-9a-f]{64}$/.test(digest)));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(firstOutput, { recursive: true, force: true });
    rmSync(secondOutput, { recursive: true, force: true });
  }
});

test("release package reads committed HEAD blobs instead of dirty tracked files", () => {
  const fixture = fixtureRoot();
  const output = mkdtempSync(path.join(os.tmpdir(), "node-only-package-head-"));
  try {
    const expected = execFileSync("git", ["show", "HEAD:src/start.mjs"], { cwd: fixture, encoding: "buffer" });
    writeFileSync(path.join(fixture, "src", "start.mjs"), "staged tracked bytes\n");
    runGit(fixture, ["add", "src/start.mjs"]);
    writeFileSync(path.join(fixture, "src", "start.mjs"), "dirty tracked bytes\n");
    const result = verifyPackage(buildReleasePackage({ sourceRoot: fixture, outputDir: output }));
    const actual = parseTar(readFileSync(result.archivePath)).get("codex-router/src/start.mjs").bytes;
    assert.deepEqual(actual, expected);
    assert.equal(result.manifest.sourceCommit, execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("release package rejects unsafe committed package versions before output", () => {
  const fixture = fixtureRoot();
  const output = mkdtempSync(path.join(os.tmpdir(), "node-only-package-version-"));
  try {
    const packageJsonPath = path.join(fixture, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageJson.version = "1.0.0/unsafe";
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
    runGit(fixture, ["add", "package.json"]);
    runGit(fixture, ["commit", "-qm", "unsafe version"]);
    assert.throws(() => buildReleasePackage({ sourceRoot: fixture, outputDir: output }), /version|semantic|unsafe/i);
    assert.deepEqual(readdirSync(output), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("USTAR path splitting uses byte limits, prefix fields, and UTF-8 boundaries", () => {
  const entry = (archivePath) => ({ archivePath, type: "file", mode: 0o644, bytes: 1, data: Buffer.from("x") });
  const exact100 = "codex-router/" + "a".repeat(87);
  const split101 = "codex-router/" + "b".repeat(88);
  const split255 = "p".repeat(154) + "/" + "n".repeat(100);
  const utf8Exact100 = "u/" + "é".repeat(49);
  const archive = deterministicGzip(tarBytes([entry(exact100), entry(split101), entry(split255), entry(utf8Exact100)]));
  const parsed = parseTar(archive);
  for (const name of [exact100, split101, split255, utf8Exact100]) assert.ok(parsed.has(name), name);
  assert.throws(() => tarBytes([entry("z".repeat(101))]), /tar path|long/i);
  assert.throws(() => tarBytes([entry("p".repeat(156) + "/x")]), /tar path|long/i);
  assert.throws(() => tarBytes([entry("u/" + "é".repeat(50) + "x")]), /tar path|long/i);
});

test("packager refuses missing tracked dependencies, symlinks, hardlinks, and dot-segment targets", () => {
  const missing = fixtureRoot();
  const symlinked = fixtureRoot();
  const hardlinked = fixtureRoot();
  const clean = fixtureRoot();
  const output = mkdtempSync(path.join(os.tmpdir(), "node-only-package-negative-"));
  try {
    rmSync(path.join(missing, "src", "start.mjs"));
    runGit(missing, ["add", "-A"]);
    runGit(missing, ["commit", "-qm", "remove dependency"]);
    assert.throws(() => buildReleasePackage({ sourceRoot: missing, outputDir: output }), /required|missing|tracked/i);

    let symlinkSupported = true;
    try {
      symlinkSync("start.mjs", path.join(symlinked, "src", "linked-start.mjs"));
    } catch (error) {
      symlinkSupported = false;
      assert.match(String(error?.code || error), /EPERM|EACCES|operation not permitted/i);
    }
    if (symlinkSupported) {
      runGit(symlinked, ["add", "-A"]);
      runGit(symlinked, ["commit", "-qm", "add symlink"]);
      assert.throws(() => buildReleasePackage({ sourceRoot: symlinked, outputDir: output }), /symlink|link|regular/i);
    }

    linkSync(path.join(hardlinked, "src", "start.mjs"), path.join(hardlinked, "src", "hardlinked-start.mjs"));
    const hardlinkedOutput = path.join(output, "manifest.json");
    linkSync(path.join(hardlinked, "src", "start.mjs"), hardlinkedOutput);
    assert.throws(() => buildReleasePackage({ sourceRoot: hardlinked, outputDir: output }), /hardlink|link|nlink|regular/i);

    const outputLink = path.join(output, "symlink-output");
    let outputSymlinkSupported = true;
    try {
      symlinkSync(output, outputLink, "junction");
    } catch (error) {
      outputSymlinkSupported = false;
      assert.match(String(error?.code || error), /EPERM|EACCES|operation not permitted/i);
    }
    if (outputSymlinkSupported) assert.throws(() => buildReleasePackage({ sourceRoot: clean, outputDir: outputLink }), /symlink|junction|link/i);

    const dottedOutput = `${output}${path.sep}nested${path.sep}..${path.sep}release`;
    assert.throws(() => buildReleasePackage({ sourceRoot: clean, outputDir: dottedOutput }), /\.\.|dot segment/i);
    assert.throws(() => buildReleasePackage({ sourceRoot: `${clean}${path.sep}..${path.sep}${path.basename(clean)}`, outputDir: output }), /\.\.|dot segment/i);
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(symlinked, { recursive: true, force: true });
    rmSync(hardlinked, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test("tray output validation rejects traversal and symlinked target parents", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "tray-package-target-"));
  try {
    assert.throws(() => validatePathWithin(rootDir, `${rootDir}${path.sep}..${path.sep}escape`, "bundle"), /\.\.|dot segment/i);
    const parent = path.join(rootDir, "parent");
    mkdirSync(parent, { recursive: true });
    const parentLink = path.join(rootDir, "parent-link");
    const link = path.join(rootDir, "link");
    let supported = true;
    try {
      symlinkSync(parent, link, "junction");
    } catch (error) {
      supported = false;
      assert.match(String(error?.code || error), /EPERM|EACCES|operation not permitted/i);
    }
    if (supported) assert.throws(() => validatePathWithin(rootDir, path.join(link, "bundle"), "bundle"), /symlink|junction|link/i);
    if (supported) {
      symlinkSync(parent, parentLink, "junction");
      assert.throws(() => validatePathWithin(parentLink, path.join(parentLink, "bundle"), "bundle"), /symlink|junction|link/i);
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
