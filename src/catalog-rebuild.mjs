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
import {
  MERGED_CATALOG_PATH,
  NATIVE_CATALOG_PATH,
  NODE_ROUTES_PATH,
  ROUTED_CATALOG_PATH,
} from "./paths.mjs";

let activeRebuild;
let queuedRebuild;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
export async function buildNodeSnapshotFiles({ nodeModels: injectedNodeModels } = {}) {
  const [{ nodeRoutableModels }, { configuredProviderIds }, { readHiddenModels }] =
    await Promise.all([
      import("./model-contract.mjs"),
      import("./provider-selection.mjs"),
      import("./model-picker-state.mjs"),
    ]);
  const previous = readJson(MERGED_CATALOG_PATH, "merged catalog");
  if (!Array.isArray(previous.models) || previous.models.length === 0) {
    throw new Error("Cannot rebuild Node snapshots: merged catalog has no native template.");
  }
  const hiddenModels = readHiddenModels();
  const nodeModels = injectedNodeModels || nodeRoutableModels({
    enabledProviders: new Set(configuredProviderIds()),
    hiddenModels,
  });
  // A current routed catalog contains both native and Node entries, so it
  // cannot itself establish Node provenance. Prefer the prior route snapshot;
  // only a genuinely pre-snapshot generation uses the old routed-artifact
  // compatibility interpretation.
  let nativeModels;
  if (existsSync(NATIVE_CATALOG_PATH)) {
    const native = readJson(NATIVE_CATALOG_PATH, "native catalog");
    if (!Array.isArray(native.models) || native.models.length === 0) {
      throw new Error("Cannot rebuild Node snapshots: native catalog has no models.");
    }
    nativeModels = native.models;
  } else {
    let routedSlugs;
    if (existsSync(NODE_ROUTES_PATH)) {
      const priorRoutes = readJson(NODE_ROUTES_PATH, "prior Node route snapshot");
      if (!Array.isArray(priorRoutes.routes)) {
        throw new Error("Cannot rebuild Node snapshots: prior Node route snapshot has no routes.");
      }
      routedSlugs = new Set(priorRoutes.routes.map((route) => String(route?.slug || "")));
    } else {
      const priorRouted = existsSync(ROUTED_CATALOG_PATH)
        ? readJson(ROUTED_CATALOG_PATH, "legacy prior routed catalog")
        : { models: [] };
      if (!Array.isArray(priorRouted.models)) {
        throw new Error("Cannot rebuild Node snapshots: legacy prior routed catalog has no models.");
      }
      routedSlugs = new Set(priorRouted.models.map((model) => String(model?.slug || "")));
    }
    nativeModels = previous.models.filter((model) => !routedSlugs.has(String(model?.slug)));
  }
  nativeModels = nativeModels.map((model) => ({
    ...model,
    supports_parallel_tool_calls: model?.supports_parallel_tool_calls === true,
    ...(hiddenModels.has(String(model?.slug)) ? { visibility: "hide" } : {}),
  }));
  // A legacy generation can lack an authoritative native capture. Its prior
  // catalog is a behavior template only when no actual native models remain;
  // it must never be copied into the next routed/merged output.
  const routed = buildRoutedCatalog({
    nativeModels,
    templateModels: nativeModels.length ? nativeModels : previous.models,
    routedModels: nodeModels,
  });
  const merged = {
    models: routed.models,
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
  if (alreadyLocked) return rebuild();
  // One shared rebuild drains a concurrent burst, then performs at most one
  // follow-up pass for changes observed while its files were being built.
  const waiter = deferred();
  const request = { reason, buildFiles, publish, catalogLock, waiters: [waiter] };
  if (activeRebuild) {
    // The latest trigger supplies the next build inputs, while every caller
    // that arrived during the active pass receives that follow-up's result.
    if (queuedRebuild) {
      queuedRebuild.reason = reason;
      queuedRebuild.buildFiles = buildFiles;
      queuedRebuild.publish = publish;
      queuedRebuild.catalogLock = catalogLock;
      queuedRebuild.waiters.push(waiter);
    } else {
      queuedRebuild = request;
    }
    return waiter.promise;
  }
  activeRebuild = (async () => {
    let next = request;
    try {
      while (next) {
        try {
          const result = await next.catalogLock(async () => {
            const files = await next.buildFiles({ reason: next.reason });
            const publication = await next.publish(files, { reason: next.reason });
            return Object.freeze({ reason: next.reason, files, publication });
          });
          for (const pending of next.waiters) pending.resolve(result);
        } catch (error) {
          for (const pending of next.waiters) pending.reject(error);
        }
        next = queuedRebuild;
        queuedRebuild = undefined;
      }
    } finally {
      activeRebuild = undefined;
    }
  })();
  // `activeRebuild` deliberately absorbs per-request failures after delivering
  // them to their callers, so a dirty follow-up always drains.
  return waiter.promise;
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
