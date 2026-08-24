import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RETIRED_PATHS = new Set(["test/acceptance/normative-requirements.json"]);

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function nulPaths(value) {
  return value.split("\0").filter(Boolean);
}

function baselinePathProbe(root, value) {
  const result = spawnSync("git", ["-C", root, "ls-tree", "--name-only", "-z", "HEAD", "--", value], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    return { error: `git baseline probe failed (${result.status ?? result.error?.code ?? "unknown"})` };
  }
  return { tracked: nulPaths(result.stdout).includes(value) };
}

export function readAllowedPaths(file) {
  const values = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (values.some((value) => path.posix.normalize(value) !== value || value.startsWith("/") || value.includes(".."))) {
    throw new Error("allowlist contains an unsafe path");
  }
  if (new Set(values).size !== values.length) throw new Error("allowlist contains duplicate paths");
  return new Set(values);
}

export function verifyTaskScope({ mode, allowedPaths, repoRoot = process.cwd() }) {
  if (!new Set(["worktree", "index"]).has(mode)) throw new Error("mode must be worktree or index");
  const allowed = allowedPaths instanceof Set ? allowedPaths : new Set(allowedPaths);
  const changed = new Set();
  if (mode === "worktree") for (const value of nulPaths(git(repoRoot, ["diff", "--name-only", "-z"]))) changed.add(value);
  for (const value of nulPaths(git(repoRoot, ["diff", "--cached", "--name-only", "-z"]))) changed.add(value);
  for (const value of nulPaths(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))) changed.add(value);
  const stagedDeletions = new Set(nulPaths(git(repoRoot, ["diff", "--cached", "--diff-filter=D", "--name-only", "-z"])));
  const findings = [];
  for (const value of [...changed].sort()) if (!allowed.has(value)) findings.push({ kind: "extra", path: value });
  for (const value of [...allowed].sort()) {
    if (!RETIRED_PATHS.has(value)) {
      if (!changed.has(value)) findings.push({ kind: "missing", path: value });
      continue;
    }
    const baseline = baselinePathProbe(repoRoot, value);
    if (baseline.error) { findings.push({ kind: "baseline-probe-error", path: value, detail: baseline.error }); continue; }
    if (baseline.tracked && !stagedDeletions.has(value)) findings.push({ kind: "required-deletion", path: value });
    if (!baseline.tracked && changed.has(value)) findings.push({ kind: "reappeared", path: value });
  }
  return findings;
}

function cli() {
  const [mode, flag, allowFile] = process.argv.slice(2);
  if (!mode || flag !== "--allow-file" || !allowFile) throw new Error("Usage: verify-task-scope worktree|index --allow-file PATH");
  const findings = verifyTaskScope({ mode, allowedPaths: readAllowedPaths(path.resolve(allowFile)) });
  for (const finding of findings) process.stdout.write(`${finding.kind}: ${finding.path}\n`);
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
}
