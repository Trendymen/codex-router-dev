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
const { nodeRoutableModels } = await import("../src/model-contract.mjs");

test("stale LM Studio models are excluded from the chat and Node registries", () => {
  const model = MODELS.find((entry) => entry.slug === "lmstudio/qwen2.5-coder");
  assert.equal(model, undefined);
  assert.equal(PROVIDERS.get("lmstudio").protocol, "openai");
  assert.deepEqual(
    nodeRoutableModels({ enabledProviders: new Set(["lmstudio"]), hiddenModels: new Set() })
      .filter((entry) => entry.provider === "lmstudio"),
    [],
  );
});
