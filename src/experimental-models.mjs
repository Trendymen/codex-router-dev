import { existsSync, readFileSync } from "node:fs";

import { writePrivateJson } from "./file-security.mjs";
import { EXPERIMENTAL_MODELS_PATH } from "./paths.mjs";

function readExperimentalModels() {
  if (!existsSync(EXPERIMENTAL_MODELS_PATH)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(EXPERIMENTAL_MODELS_PATH, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.models)) return new Set();
    return new Set(parsed.models.filter((slug) => typeof slug === "string"));
  } catch {
    return new Set();
  }
}

export function experimentalModelEnabled(slug) {
  return readExperimentalModels().has(String(slug));
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
