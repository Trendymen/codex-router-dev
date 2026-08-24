import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Homebrew formula packages the Node-only source tree", () => {
  const formula = readFileSync(path.join(root, "Formula", "codex-router.rb"), "utf8");
  assert.match(formula, /class CodexRouter < Formula/);
  assert.match(formula, /depends_on "node"/);
  assert.match(formula, /npm.*ci.*--omit=dev/);
  assert.match(formula, /src\/install-plan\.mjs/);
  assert.doesNotMatch(formula, /Python|python|LiteLLM|litellm|cargo|rust|Tauri|Electron|\.venv/i);
});
