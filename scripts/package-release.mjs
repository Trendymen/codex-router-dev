import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOTS = Object.freeze([
  "src",
  "bin",
  "config",
  "skills",
  "apps/desktop/ui",
  "apps/macos/ModelRouterTray",
]);
const PACKAGE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "runtime-package.json",
  "install.sh",
  "LICENSE",
  "NOTICE.md",
  "README.md",
  "SECURITY.md",
  "docs/INSTALL.md",
  "docs/DEVIN-CLI-PROBE.md",
  "scripts/build-macos-tray-app.sh",
]);
const REQUIRED_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "runtime-package.json",
  "src/start.mjs",
  "src/router.mjs",
  "src/node-runtime.mjs",
  "apps/desktop/ui/index.html",
  "apps/desktop/ui/app.js",
  "apps/desktop/ui/model.mjs",
  "apps/desktop/ui/styles.css",
  "apps/macos/ModelRouterTray/Package.swift",
  "apps/macos/ModelRouterTray/Resources/Info.plist",
  "config/deepseek/deepseek.json",
  "scripts/build-macos-tray-app.sh",
]);
const PACKAGE_FILE_SET = new Set(PACKAGE_FILES);
const EMPTY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const TAR_BLOCK = 512;

function byteOrder(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function fail(message) {
  throw new Error("Release package refused: " + message);
}

function rejectDotSegments(value, name) {
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(String(value))) {
    fail(name + " contains a dot segment.");
  }
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    fail(name + " must be an absolute path.");
  }
  rejectDotSegments(value, name);
  return path.normalize(value);
}

function pathInside(root, candidate, name) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === "." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    fail(name + " must be inside the source root.");
  }
  return relative;
}

function rejectSymlinkAncestors(root, candidate, name) {
  let current = candidate;
  const boundary = path.resolve(root);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      fail(name + " crosses a symlink or junction.");
    }
    if (current === boundary) return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function sourceRootPath(sourceRoot) {
  const normalized = absolutePath(sourceRoot, "sourceRoot");
  if (!existsSync(normalized) || !lstatSync(normalized).isDirectory()) {
    fail("sourceRoot must be an existing directory.");
  }
  // Canonicalize shared system aliases such as macOS /var -> /private/var.
  // The checkout itself may not be a symlink; ancestors outside its authority
  // are not package entries and need not be rejected.
  if (lstatSync(normalized).isSymbolicLink()) {
    fail("sourceRoot crosses a symlink or junction.");
  }
  return realpathSync(normalized);
}

function normalizeRelative(relative) {
  const value = String(relative).replaceAll("\\", "/");
  if (!value || value.startsWith("/") || value.split("/").includes("..")) {
    fail("tracked path is not normalized: " + relative);
  }
  return value;
}

function forbiddenRuntimePath(relative) {
  const segments = normalizeRelative(relative).split("/");
  return segments.some((segment) =>
    segment === "test" || /^(?:python|electron|tauri)(?:$|[._-])/i.test(segment),
  );
}

function allowedPath(relative) {
  const value = normalizeRelative(relative);
  if (forbiddenRuntimePath(value)) return false;
  if (PACKAGE_FILE_SET.has(value)) return true;
  return PACKAGE_ROOTS.some((root) => value === root || value.startsWith(root + "/"));
}

function gitHeadTree(sourceRoot) {
  let output;
  try {
    output = execFileSync("git", ["-C", sourceRoot, "ls-tree", "-r", "-z", "HEAD", "--"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail("sourceRoot is not a readable Git HEAD tree (" + (error?.code || "git") + ").");
  }
  const result = new Map();
  for (const record of output.toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    if (tab < 0) fail("Git returned an invalid HEAD tree record.");
    const metadata = record.slice(0, tab).split(" ");
    if (metadata.length !== 3 || !/^[0-9a-f]{40,64}$/.test(metadata[2])) {
      fail("Git returned an invalid HEAD blob record.");
    }
    result.set(normalizeRelative(record.slice(tab + 1)), {
      mode: metadata[0],
      type: metadata[1],
      oid: metadata[2],
    });
  }
  return result;
}

function fileMode(headEntry, relative) {
  if (headEntry.type !== "blob") fail(relative + " is not a regular HEAD blob.");
  if (headEntry.mode === "120000") fail(relative + " is a symlink.");
  if (headEntry.mode === "160000") fail(relative + " is a submodule.");
  if (headEntry.mode !== "100644" && headEntry.mode !== "100755") {
    fail(relative + " has unsupported Git mode " + headEntry.mode + ".");
  }
  return headEntry.mode === "100755" ? 0o755 : 0o644;
}

function headBlobs(sourceRoot, oids) {
  const unique = [...new Set(oids)];
  if (!unique.length) return new Map();
  let output;
  try {
    output = execFileSync("git", ["-C", sourceRoot, "cat-file", "--batch"], {
      input: Buffer.from(unique.join("\n") + "\n", "ascii"),
      encoding: "buffer",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    fail("cannot read HEAD blobs (" + (error?.code || "git") + ").");
  }
  const result = new Map();
  let cursor = 0;
  for (const oid of unique) {
    const headerEnd = output.indexOf(0x0a, cursor);
    if (headerEnd < 0) fail("HEAD blob header is incomplete.");
    const header = output.subarray(cursor, headerEnd).toString("ascii").split(" ");
    const size = Number(header[2]);
    if (header[0] !== oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      fail("HEAD blob metadata is invalid for " + oid + ".");
    }
    const start = headerEnd + 1;
    if (output.byteLength < start + size + 1) fail("HEAD blob is truncated for " + oid + ".");
    result.set(oid, Buffer.from(output.subarray(start, start + size)));
    cursor = start + size + 1;
  }
  return result;
}

function trackedFile(sourceRoot, sourceRootReal, relative, headEntry, bytes) {
  const normalized = normalizeRelative(relative);
  const absolute = path.join(sourceRoot, ...normalized.split("/"));
  pathInside(sourceRoot, absolute, normalized);
  const mode = fileMode(headEntry, normalized);
  if (!bytes) fail("HEAD blob is missing for " + normalized + ".");
  return {
    relative: normalized,
    archivePath: "codex-router/" + normalized,
    type: "file",
    mode,
    modeText: mode.toString(8).padStart(4, "0"),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    data: bytes,
  };
}

function runtimePackageDocument(sourcePackage, runtimeMetadata) {
  return {
    name: runtimeMetadata.name || sourcePackage.name,
    version: sourcePackage.version,
    private: false,
    type: "module",
    description: "Codex Router runtime package",
    engines: sourcePackage.engines,
    scripts: runtimeMetadata.scripts || {},
    dependencies: runtimeMetadata.dependencies || {},
  };
}

function replacePackageEntry(entry, document) {
  const data = Buffer.from(JSON.stringify(document, null, 2) + "\n", "utf8");
  return {
    ...entry,
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    data,
  };
}

function packageEntries(sourceRoot) {
  const sourceRootReal = sourceRootPath(sourceRoot);
  const index = gitHeadTree(sourceRootReal);
  const selected = [];
  const selectedHeadEntries = [...index.entries()].filter(([relative]) => allowedPath(relative));
  const blobs = headBlobs(sourceRootReal, selectedHeadEntries.map(([, entry]) => entry.oid));
  for (const [relative, headEntry] of selectedHeadEntries) {
    selected.push(trackedFile(sourceRootReal, sourceRootReal, relative, headEntry, blobs.get(headEntry.oid)));
  }
  const selectedByPath = new Map(selected.map((entry) => [entry.relative, entry]));
  for (const required of REQUIRED_FILES) {
    if (!selectedByPath.has(required)) fail("required package dependency is not tracked: " + required);
  }
  const sourcePackageJson = JSON.parse(selectedByPath.get("package.json").data.toString("utf8"));
  const packageLock = JSON.parse(selectedByPath.get("package-lock.json").data.toString("utf8"));
  const runtimeMetadata = JSON.parse(selectedByPath.get("runtime-package.json").data.toString("utf8"));
  if (runtimeMetadata?.schemaVersion !== 1 || runtimeMetadata.runtime !== "node") {
    fail("runtime-package.json is not a supported Node runtime metadata document.");
  }
  const available = (relative) =>
    selectedByPath.has(relative) || [...selectedByPath.keys()].some((entry) => entry.startsWith(relative + "/"));
  for (const relative of [
    ...(runtimeMetadata.entrypoints || []),
    ...(runtimeMetadata.assets || []),
    ...(runtimeMetadata.docs || []),
  ]) {
    if (typeof relative !== "string" || !available(relative)) {
      fail("runtime-package.json names an unshipped path: " + String(relative));
    }
  }
  const scriptText = JSON.stringify(runtimeMetadata.scripts || {});
  if (/npm\s+(?:run\s+)?(?:test|check)|python|electron|tauri/i.test(scriptText)) {
    fail("runtime-package.json contains an unavailable runtime script.");
  }
  const runtimePackageEntry = replacePackageEntry(
    selectedByPath.get("package.json"),
    runtimePackageDocument(sourcePackageJson, runtimeMetadata),
  );
  selectedByPath.set("package.json", runtimePackageEntry);
  selected[selected.findIndex((entry) => entry.relative === "package.json")] = runtimePackageEntry;
  const packageJson = JSON.parse(selectedByPath.get("package.json").data.toString("utf8"));
  const lockRoot = packageLock?.packages?.[""];
  if (!lockRoot || JSON.stringify(lockRoot.dependencies || {}) !== JSON.stringify(packageJson.dependencies || {})) {
    fail("package-lock root dependencies do not match package.json.");
  }
  const directories = new Set(["codex-router"]);
  for (const entry of selected) {
    const parts = entry.archivePath.split("/");
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  const directoryEntries = [...directories].map((archivePath) => ({
    archivePath,
    type: "directory",
    mode: 0o755,
    modeText: "0755",
    bytes: 0,
    sha256: EMPTY_SHA256,
    data: Buffer.alloc(0),
  }));
  return [...directoryEntries, ...selected].sort((left, right) => byteOrder(left.archivePath, right.archivePath));
}

function outputDirectory(sourceRootReal, outputDir) {
  const normalized = absolutePath(outputDir, "outputDir");
  if (normalized === sourceRootReal) fail("outputDir overlaps the source root.");
  const relative = path.relative(sourceRootReal, normalized).replaceAll("\\", "/");
  if (relative && !relative.startsWith("../") && !path.isAbsolute(relative) &&
      PACKAGE_ROOTS.some((root) => relative === root || relative.startsWith(root + "/"))) {
    fail("outputDir overlaps a package input root.");
  }
  if (existsSync(normalized)) {
    const info = lstatSync(normalized);
    if (info.isSymbolicLink()) fail("outputDir is a symlink or junction.");
    if (!info.isDirectory()) fail("outputDir is not a directory.");
  } else {
    mkdirSync(normalized, { recursive: true, mode: 0o755 });
  }
  return normalized;
}

function validPackageVersion(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)) {
    fail("package version is not a strict safe semantic version.");
  }
  if (/[\\/\u0000-\u001f\u007f]/.test(value) || value.includes("..")) {
    fail("package version contains an unsafe path or control character.");
  }
  return value;
}

function preflightOutputTargets(output, packageVersion) {
  for (const file of [
    path.join(output, "codex-router-" + packageVersion + ".tar.gz"),
    path.join(output, "manifest.json"),
    path.join(output, "SHA256SUMS"),
  ]) {
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (info.isSymbolicLink()) fail("output target is a symlink: " + file);
    if (!info.isFile()) fail("output target is not a regular file: " + file);
    if (info.nlink > 1) fail("output target is a hardlink: " + file);
  }
}

function writeOutput(target, bytes) {
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) fail("output target is a symlink: " + target);
    if (!info.isFile()) fail("output target is not a regular file: " + target);
    if (info.nlink > 1) fail("output target is a hardlink: " + target);
  }
  const temporary = target + ".tmp." + process.pid + "." + randomUUID();
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o644 });
  try {
    if (existsSync(target)) unlinkSync(target);
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function field(buffer, offset, length, value) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") > length - 1) fail("tar header field is too long.");
  buffer.write(text.padStart(length - 1, "0"), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function tarHeader(entry) {
  const header = Buffer.alloc(TAR_BLOCK);
  const name = entry.archivePath;
  let namePart = name;
  let prefix = "";
  if (Buffer.byteLength(namePart, "utf8") > 100) {
    let split = name.lastIndexOf("/");
    while (split > 0) {
      const candidatePrefix = name.slice(0, split);
      const candidateName = name.slice(split + 1);
      if (Buffer.byteLength(candidateName, "utf8") <= 100 && Buffer.byteLength(candidatePrefix, "utf8") <= 155) {
        prefix = candidatePrefix;
        namePart = candidateName;
        break;
      }
      split = name.lastIndexOf("/", split - 1);
    }
    if (!prefix || Buffer.byteLength(namePart, "utf8") > 100 || Buffer.byteLength(prefix, "utf8") > 155) {
      fail("tar path is too long: " + name);
    }
  }
  header.write(namePart, 0, "utf8");
  field(header, 100, 8, entry.mode.toString(8));
  field(header, 108, 8, "0");
  field(header, 116, 8, "0");
  field(header, 124, 12, entry.bytes.toString(8));
  field(header, 136, 12, "0");
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.write(prefix, 345, "utf8");
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}

export function tarBytes(entries) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry));
    if (entry.bytes) {
      chunks.push(entry.data);
      const padding = (TAR_BLOCK - (entry.bytes % TAR_BLOCK)) % TAR_BLOCK;
      if (padding) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(chunks);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function deterministicGzip(bytes) {
  const body = deflateRawSync(bytes, { level: 9 });
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.byteLength >>> 0, 4);
  return Buffer.concat([header, body, trailer]);
}

function manifestFor(entries, packageVersion, sourceCommit) {
  return {
    schemaVersion: 1,
    packageVersion,
    sourceCommit,
    target: "codex",
    platform: "darwin",
    runtime: "node",
    packageKind: "runtime",
    runtimeMetadata: "runtime-package.json",
    sections: {
      router: ["src", "bin", "package.json", "package-lock.json", "runtime-package.json", "install.sh"],
      swiftApp: ["apps/macos/ModelRouterTray"],
      browser: ["apps/desktop/ui"],
      registry: ["config"],
    },
    files: entries.map(({ archivePath, type, modeText, bytes, sha256 }) => ({
      path: archivePath,
      type,
      mode: modeText,
      bytes,
      sha256,
    })),
  };
}

export function validatePathWithin(parent, candidate, name = "path") {
  const root = absolutePath(parent, "parent");
  const value = absolutePath(candidate, name);
  const relative = path.relative(root, value);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    fail(name + " must be below parent.");
  }
  rejectSymlinkAncestors(root, value, name);
  return value;
}

export function buildReleasePackage({
  sourceRoot = SCRIPT_ROOT,
  outputDir = path.join(sourceRoot, "generated", "release"),
} = {}) {
  const sourceRootReal = sourceRootPath(sourceRoot);
  const entries = packageEntries(sourceRootReal);
  const packageJson = entries.find((entry) => entry.relative === "package.json");
  const packageVersion = validPackageVersion(JSON.parse(packageJson.data.toString("utf8")).version);
  const output = outputDirectory(sourceRootReal, outputDir);
  preflightOutputTargets(output, packageVersion);
  const sourceCommit = execFileSync("git", ["-C", sourceRootReal, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = manifestFor(entries, packageVersion, sourceCommit);
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const archiveBytes = deterministicGzip(tarBytes(entries));
  const archivePath = path.join(output, "codex-router-" + packageVersion + ".tar.gz");
  const manifestPath = path.join(output, "manifest.json");
  const checksumPath = path.join(output, "SHA256SUMS");
  const checksumBytes = Buffer.from(
    createHash("sha256").update(archiveBytes).digest("hex") + "  " + path.basename(archivePath) + "\n" +
    createHash("sha256").update(manifestBytes).digest("hex") + "  " + path.basename(manifestPath) + "\n",
    "utf8",
  );
  writeOutput(archivePath, archiveBytes);
  writeOutput(manifestPath, manifestBytes);
  writeOutput(checksumPath, checksumBytes);
  return { archivePath, manifestPath, checksumPath, manifest };
}

function main(argv) {
  let outputDir;
  let sourceRoot = SCRIPT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output" || argument === "--source-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        const error = new Error(`${argument} requires a path value.`);
        error.exitCode = 2;
        throw error;
      }
      if (argument === "--output") outputDir = value;
      else sourceRoot = value;
      index += 1;
    }
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: package-release.mjs [--output PATH] [--source-root PATH]\n");
      return 0;
    } else {
      fail("unknown option: " + argument);
    }
  }
  const result = buildReleasePackage({
    sourceRoot,
    outputDir: outputDir
      ? path.isAbsolute(outputDir) ? outputDir : path.join(sourceRoot, outputDir)
      : path.join(sourceRoot, "generated", "release"),
  });
  process.stdout.write(result.archivePath + "\n" + result.manifestPath + "\n" + result.checksumPath + "\n");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.exitCode === 2 ? 2 : 1;
  }
}
