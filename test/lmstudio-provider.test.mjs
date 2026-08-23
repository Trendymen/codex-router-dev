import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const userModelsPath = path.join(mkdtempSync(path.join(os.tmpdir(), "lmstudio-test-")), "user-models.json");
process.env.MODEL_ROUTER_USER_MODELS = userModelsPath;
writeFileSync(
  userModelsPath,
  JSON.stringify({
    version: 1,
    models: [
      {
        slug: "lmstudio/qwen2.5-coder",
        gatewayModel: "lmstudio-qwen2-5-coder",
        upstreamModel: "qwen2.5-coder",
        provider: "lmstudio",
        listed: true,
        displayName: "qwen2.5-coder (LM Studio)",
        description: "Test model served by LM Studio.",
        priority: 900,
        defaultEffort: "high",
        reasoningLevels: [{ effort: "high", description: "Adaptive reasoning" }],
        contextWindow: 32768,
        autoCompact: 28000,
        inputModalities: ["text"],
        compHash: "lmstudio-qwen2-5-coder-test-v1",
      },
    ],
  }),
);

const { MODELS, PROVIDERS } = await import("../src/model-registry.mjs");
const { renderLiteLlmConfig } = await import("../src/litellm-config.mjs");

test("stale LM Studio models are excluded from chat registry and gateway config", () => {
  const model = MODELS.find((entry) => entry.slug === "lmstudio/qwen2.5-coder");
  assert.equal(model, undefined);
  assert.equal(PROVIDERS.get("lmstudio").protocol, "openai");

  const rendered = renderLiteLlmConfig();
  assert.doesNotMatch(rendered, /lmstudio-qwen2-5-coder/);
  assert.doesNotMatch(rendered, /ollama_chat\/qwen2\.5-coder/);
  assert.match(rendered, /os\.environ\/CODEX_ROUTER_API_FORWARD_BASE_URL/);
});
