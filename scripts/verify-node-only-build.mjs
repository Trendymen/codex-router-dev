import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = path.join(SCRIPT_ROOT, "test", "acceptance", "acceptance-matrix.json");
const REQUIRED_ARTIFACTS = Object.freeze([
  "src/router.mjs",
  "src/node-runtime.mjs",
  "apps/desktop/ui/index.html",
  "apps/desktop/ui/app.js",
  "apps/macos/ModelRouterTray/ModelRouterTray.app/Contents/MacOS/ModelRouterTray",
  "config/deepseek/deepseek.json",
  "config/qwen/plan/qwen3.8-max.json",
]);
const FORBIDDEN_PATHS = Object.freeze([
  ["python-runtime", /(?:^|\/)(?:requirements|venv)(?:\/|$)|\.py$/i],
  ["rust-tauri-runtime", /(?:^|\/)(?:src-tauri|tauri|electron)(?:\/|$)|\.(?:rs|toml)$/i],
]);
const FORBIDDEN_TEXT = Object.freeze([
  ["python-runtime", /(?:\bpython(?:3)?\b|\bpip\b|\buv\b)/i],
  ["litellm-runtime", /\blitellm\b/i],
  ["rust-tauri-runtime", /(?:\bcargo\b|\brustc\b|@tauri-apps|\btauri::)/i],
]);

function walk(root, relative = "") {
  const directory = path.join(root, relative);
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...walk(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

function finding(kind, relative, detail) {
  return { kind, path: relative, detail };
}

export function loadAcceptanceMatrix(matrixPath = MATRIX_PATH) {
  const parsed = JSON.parse(readFileSync(matrixPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("acceptance matrix must be an array");
  return parsed;
}

export function verifyNodeOnlyBuild(artifactRoot) {
  const root = path.resolve(artifactRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [finding("artifact-root-missing", ".", "artifact root is not a directory")];
  const files = walk(root);
  const findings = [];
  for (const required of REQUIRED_ARTIFACTS) {
    if (!files.includes(required)) findings.push(finding("required-artifact-missing", required, "required Node-native release artifact is absent"));
  }
  for (const relative of files) {
    for (const [kind, pattern] of FORBIDDEN_PATHS) {
      if (pattern.test(relative)) findings.push(finding(kind, relative, "forbidden removed-runtime artifact path"));
    }
    if (!/\.(?:cjs|css|html|js|json|mjs|ps1|sh|swift|toml|ts|tsx|yaml|yml)$/i.test(relative)) continue;
    const text = readFileSync(path.join(root, ...relative.split("/")), "utf8");
    for (const [kind, pattern] of FORBIDDEN_TEXT) {
      if (pattern.test(text)) findings.push(finding(kind, relative, "forbidden removed-runtime executable/import/dependency text"));
    }
  }
  return findings.sort((left, right) => `${left.path}:${left.kind}`.localeCompare(`${right.path}:${right.kind}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifactRoot = process.argv[2];
  if (!artifactRoot) {
    process.stderr.write("Usage: node scripts/verify-node-only-build.mjs ARTIFACT_ROOT\\n");
    process.exitCode = 2;
  } else {
    const findings = verifyNodeOnlyBuild(artifactRoot);
    if (findings.length) {
      process.stdout.write(`${JSON.stringify({ status: "failed", findings }, null, 2)}\\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify({ status: "passed", artifactRoot: path.resolve(artifactRoot), findings: [] }, null, 2)}\\n`);
    }
  }
}
