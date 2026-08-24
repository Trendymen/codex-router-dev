import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// These are the files which can put an executable, package, installer, or
// release artifact on a user's machine. Documentation and historical test
// fixtures deliberately do not enter this scan: they explain the migration,
// but cannot start a removed runtime.
const SHIPPED_ROOTS = Object.freeze([
  "src",
  "bin",
  "scripts",
  "packaging",
  ".github/workflows",
  "Formula",
  "apps/desktop/package.json",
  "apps/desktop/package-lock.json",
  "apps/desktop/ui",
  "apps/macos",
  "package.json",
  "package-lock.json",
  "install.sh",
  "install.ps1",
  "codex-router.ps1",
  "model-router.ps1",
]);

const REMOVED_FILES = Object.freeze([
  "requirements/python.in",
  "requirements/python.txt",
  "src/litellm-config.mjs",
  "src/gateway-supervisor.mjs",
  "src/venv-runtime.mjs",
  ".github/workflows/python-lock.yml",
  "bin/lock-python",
  "scripts/verify-python-lock.py",
  "scripts/verify-zai-litellm-usage.mjs",
  "packaging/homebrew/check-formula.mjs",
  "packaging/homebrew/generate-formula.mjs",
]);

// Prefixes are tracked as a closed set even when a local checkout retains an
// ignored build directory from before the migration. CI audits the checkout's
// shipped files; it must never turn a stale ignored directory into a runtime
// dependency merely because it happens to exist on disk.
const REMOVED_PREFIXES = Object.freeze([
  "requirements/",
  "apps/electron/",
  "apps/control-center/",
  "apps/desktop/src-tauri/",
]);

const REMOVED_TOKENS = Object.freeze([
  ["python-install", /(?:python(?:3)?(?:\.exe)?\s+-|py\s+-\d|uv\s+(?:venv|pip)|pip\s+(?:install|compile)|requirements[\\/]python|PYTHON_[A-Z_]+|python-(?:deps|install-command)|(?:spawn|exec|execFile|execFileSync)\s*\([^\n]*(?:["'](?:python3?|py|uv)["']|\b(?:python3?|uv)\b)|(?:spawn|exec|execFile|execFileSync)\s*\([^\n]*,\s*\[[^\n]*(?:["'](?:python3?|py|uv)["']))/i,],
  ["litellm-runtime", /(?:import[^\n]*litellm|(?:spawn|exec|write|require|dynamic\s+import)[^\n]*litellm|LITELLM_[A-Z_]+|litellm-config\.mjs|gateway-supervisor\.mjs|venv-runtime\.mjs)/i],
  ["rust-tauri-runtime", /(?:\bcargo\s+(?:build|check|test|fmt)|\brustc\b|@tauri-apps|tauri::|src[\\/]tauri)/i],
  ["electron-runtime", /(?:electron-builder|from\s+["']electron["']|require\(["']electron["']\)|apps[\\/](?:electron|control-center)|process\.versions\.electron|ELECTRON_[A-Z_]+|electron\.exe)/i],
  ["legacy-gateway-port", /(?:MODEL_ROUTER_GATEWAY|CODEX_ROUTER_GATEWAY|KIMI_GATEWAY|GATEWAY_BASE_URL|PORTS\.gateway|DEFAULT_PORTS\.gateway|LEGACY_PORTS\.gateway|(?:port|PORT)\s*[:=]\s*4200)/i],
]);

function isTextFile(relative) {
  return /\.(?:cjs|css|html|js|json|mjs|ps1|rb|sh|swift|toml|ts|tsx|yaml|yml)$/.test(relative) ||
    /^(?:install\.sh|install\.ps1|codex-router\.ps1|model-router\.ps1)$/.test(relative);
}

async function shippedFiles(root) {
  const result = [];
  async function visit(relative) {
    const absolute = path.join(root, ...relative.split("/"));
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (isTextFile(child)) result.push(child);
    }
  }
  for (const rootEntry of SHIPPED_ROOTS) {
    const absolute = path.join(root, ...rootEntry.split("/"));
    try {
      const stat = await import("node:fs/promises").then(({ stat }) => stat(absolute));
      if (stat.isDirectory()) await visit(rootEntry);
      else if (isTextFile(rootEntry)) result.push(rootEntry);
    } catch {
      // A closed-list path may already have been deleted; that is audited by
      // the explicit removal-list test and is not itself a finding here.
    }
  }
  return [...new Set(result)].sort();
}

async function trackedFiles(root) {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    const files = String(stdout).split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));
    return files.length ? files : await shippedFiles(root);
  } catch {
    return shippedFiles(root);
  }
}

export function auditRemovedPathList(paths) {
  const findings = [];
  for (const value of paths || []) {
    const relative = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
    const prefix = REMOVED_PREFIXES.find((candidate) => relative.startsWith(candidate));
    if (prefix) findings.push({ kind: "removed-prefix-present", path: relative, line: 0, text: `closed removal prefix is still tracked: ${prefix}` });
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}

export function scanRemovedRuntimeText(contents, relative = "fixture") {
  const findings = [];
  String(contents).split(/\r?\n/).forEach((line, index) => {
    for (const [kind, pattern] of REMOVED_TOKENS) {
      if (pattern.test(line)) findings.push({ kind, path: relative, line: index + 1, text: line.trim().slice(0, 240) });
    }
  });
  return findings;
}

/**
 * Return executable shipped-file findings for the removed runtimes.
 *
 * The result is intentionally structured and deterministic so CI can report
 * the exact path/line without dumping secrets or whole source files.
 */
export async function auditRemovedRuntime(root) {
  const repoRoot = path.resolve(root || ".");
  const findings = [];
  findings.push(...auditRemovedPathList(await trackedFiles(repoRoot)));
  for (const relative of await shippedFiles(repoRoot)) {
    // The audit's own closed-list patterns necessarily contain the names they
    // reject; scanning this source would report the detector instead of the
    // shipped runtime it is meant to inspect.
    if (relative === "src/dependency-removal-audit.mjs") continue;
    const contents = await readFile(path.join(repoRoot, ...relative.split("/")), "utf8");
    findings.push(...scanRemovedRuntimeText(contents, relative));
  }
  for (const relative of REMOVED_FILES) {
    try {
      await import("node:fs/promises").then(({ access }) => access(path.join(repoRoot, ...relative.split("/"))));
      findings.push({ kind: "removed-file-present", path: relative, line: 0, text: "closed removal-list path is still present" });
    } catch {
      // Expected after Task 4 deletion.
    }
  }
  return findings.sort((a, b) => `${a.path}:${a.line}:${a.kind}`.localeCompare(`${b.path}:${b.line}:${b.kind}`));
}

export { REMOVED_FILES, REMOVED_PREFIXES, SHIPPED_ROOTS };
