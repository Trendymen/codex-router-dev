import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { buildRoutedCatalog, publishCatalogGeneration } from "./catalog-generation.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { MERGED_CATALOG_PATH } from "./paths.mjs";

function readJson(target, label) {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`Cannot rebuild Node snapshots: ${label} is unavailable or invalid (${error.message}).`, {
      cause: error,
    });
  }
}

function safeModel(model) {
  return {
    slug: model.slug,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    effectiveTransport: model.effectiveTransport,
    toolDialect: model.toolDialect,
    reasoningDisplayMode: model.reasoningDisplayMode,
    declaredFinalReasoningShape: model.declaredFinalReasoningShape,
    effectiveFinalReasoningShape: model.effectiveFinalReasoningShape,
    rolloutState: model.rolloutState,
    purpose: model.purpose,
    routable: model.routable,
    listed: model.listed,
    visible: model.visible,
    ...(model.publicError ? { publicError: model.publicError } : {}),
  };
}

function route(model) {
  return {
    slug: model.slug,
    provider: model.provider,
    upstreamModel: model.upstreamModel,
    effectiveTransport: model.effectiveTransport,
    toolDialect: model.toolDialect,
    requestProfile: model.requestProfile,
    reasoningDisplayMode: model.reasoningDisplayMode,
    effectiveFinalReasoningShape: model.effectiveFinalReasoningShape,
    purpose: model.purpose,
  };
}

/**
 * Shape a full six-artifact generation from the existing native/merged
 * template and the current Node contract. No active provider profile is read.
 */
export async function buildNodeSnapshotFiles() {
  const [{ MODEL_BY_SLUG }, { nodeRoutableModels }, { configuredProviderIds }, { readHiddenModels }] =
    await Promise.all([
      import("./model-registry.mjs"),
      import("./model-contract.mjs"),
      import("./provider-selection.mjs"),
      import("./model-picker-state.mjs"),
    ]);
  const previous = readJson(MERGED_CATALOG_PATH, "merged catalog");
  if (!Array.isArray(previous.models) || previous.models.length === 0) {
    throw new Error("Cannot rebuild Node snapshots: merged catalog has no native template.");
  }
  const nodeModels = nodeRoutableModels({
    enabledProviders: new Set(configuredProviderIds()),
    hiddenModels: readHiddenModels(),
  });
  const nodeSlugs = new Set(MODEL_BY_SLUG.keys());
  const nativeModels = previous.models.filter((model) => !nodeSlugs.has(String(model?.slug)));
  const routed = buildRoutedCatalog({ nativeModels, routedModels: nodeModels });
  const merged = {
    models: [
      ...previous.models.filter((model) => !nodeSlugs.has(String(model?.slug))),
      ...routed.models,
    ],
  };
  const models = { version: 1, models: nodeModels.map(safeModel) };
  return {
    "merged-models.json": merged,
    "routed-models.json": routed,
    "node-routes.json": { version: 1, routes: nodeModels.map(route) },
    "control-models.json": models,
    "swift-models.json": models,
    "browser-models.json": models,
  };
}

function captureProtectedFiles(files) {
  return [...new Set((files || []).map((file) => path.resolve(file)))].map((file) => {
    if (!existsSync(file)) return { path: file, present: false };
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error(`State transaction only accepts protected files: ${file}`);
    return { path: file, present: true, contents: readFileSync(file), mode: stat.mode & 0o777 };
  });
}

function restoreProtectedFiles(snapshots) {
  for (const snapshot of snapshots || []) {
    if (!snapshot.present) {
      if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
      continue;
    }
    mkdirSync(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
    const temporary = `${snapshot.path}.rollback-${process.pid}`;
    try {
      writeFileSync(temporary, snapshot.contents, { mode: snapshot.mode });
      chmodSync(temporary, snapshot.mode);
      protectPrivateFile(temporary);
      renameSync(temporary, snapshot.path);
      chmodSync(snapshot.path, snapshot.mode);
      protectPrivateFile(snapshot.path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

/**
 * Rebuild exactly one complete generation. `alreadyLocked` is intentionally
 * internal-facing: a state transaction owns the catalog lock around mutate,
 * build, switch, and rollback and must not acquire it recursively.
 */
export async function rebuildNodeSnapshots(reason, {
  buildFiles = buildNodeSnapshotFiles,
  publish = (files) => publishCatalogGeneration({ files }),
  catalogLock = withCatalogPublicationLock,
  alreadyLocked = false,
} = {}) {
  const rebuild = async () => {
    const files = await buildFiles({ reason });
    const publication = await publish(files, { reason });
    return Object.freeze({ reason, files, publication });
  };
  return alreadyLocked ? rebuild() : catalogLock(rebuild);
}

/**
 * The only state-plus-generation commit boundary for Node routing state.
 * Lock ordering is model-overlay (outer) then catalog publication (inner).
 */
export async function transactNodeStateMutation({
  files,
  mutate,
  reason,
  capture = captureProtectedFiles,
  restore = restoreProtectedFiles,
  modelOverlayLock = withModelOverlayLock,
  catalogLock = withCatalogPublicationLock,
  rebuild = rebuildNodeSnapshots,
  buildFiles,
  publish,
} = {}) {
  if (typeof mutate !== "function") throw new Error("A Node state transaction requires mutate().");
  const commit = async () => {
    const snapshots = await capture(files || []);
    try {
      await mutate();
      return await rebuild(reason, {
        buildFiles,
        publish,
        catalogLock,
        alreadyLocked: true,
      });
    } catch (operationError) {
      try {
        await restore(snapshots);
      } catch (rollbackError) {
        throw new AggregateError(
          [operationError, rollbackError],
          "Node state transaction failed and its protected state could not be fully restored.",
          { cause: operationError },
        );
      }
      throw operationError;
    }
  };
  // Do not invert this ordering. Existing overlay callers own the outer lock;
  // callers that compose this helper can inject the already-held seam above.
  return modelOverlayLock(() => catalogLock(commit));
}
