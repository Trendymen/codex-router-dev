import { existsSync, readFileSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import { EXPERIMENTAL_MODELS_PATH } from "./paths.mjs";

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

export function setExperimentalModel(slug, enabled) {
  const models = readExperimentalModels();
  const key = String(slug);
  if (enabled === true) models.add(key);
  else models.delete(key);
  writePrivateJson(
    EXPERIMENTAL_MODELS_PATH,
    { version: 1, models: [...models].sort() },
    { directoryMode: 0o700 },
  );
}
