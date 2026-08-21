import { existsSync, readFileSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { EXPERIMENTAL_MODELS_PATH } from "./paths.mjs";
import { transactNodeStateMutation } from "./catalog-rebuild.mjs";
import { transactNodeMutationAndRefreshTargets } from "./node-snapshot-triggers.mjs";

function readExperimentalModels() {
  if (!existsSync(EXPERIMENTAL_MODELS_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(EXPERIMENTAL_MODELS_PATH, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.models) ||
      !parsed.models.every((slug) => typeof slug === "string" && slug.length > 0)
    ) {
      return new Set();
    }
    return new Set(parsed.models);
  } catch {
    return new Set();
  }
}

export function experimentalModelEnabled(slug) {
  return readExperimentalModels().has(String(slug));
}

export function experimentalModelForSlug(slug) {
  const key = String(slug);
  const model = MODEL_BY_SLUG.get(key);
  if (model?.rolloutState === "experimental") return model;
  const error = new Error(`Unknown experimental model slug: ${key}`);
  error.code = "unknown_experimental_model";
  error.status = 404;
  throw error;
}

export async function setExperimentalModel(slug, enabled, options = {}) {
  const key = String(slug);
  const { transaction = transactNodeStateMutation, refreshTargets, ...transactionOptions } = options;
  return transactNodeMutationAndRefreshTargets({
    transaction,
    files: [EXPERIMENTAL_MODELS_PATH],
    reason: `experimental-model:${enabled === true ? "enable" : "disable"}:${key}`,
    mutate: () => {
      const models = readExperimentalModels();
      if (enabled === true) models.add(key);
      else models.delete(key);
      writePrivateJson(
        EXPERIMENTAL_MODELS_PATH,
        { version: 1, models: [...models].sort() },
        { directoryMode: 0o700 },
      );
    },
    ...transactionOptions,
    refreshTargets: refreshTargets || (async () => {
      const { refreshTargetPickerIfInstalled } = await import("./target-integration.mjs");
      return refreshTargetPickerIfInstalled({ rebuildCodex: false });
    }),
  });
}
