import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { transactNodeStateMutation } from "./catalog-rebuild.mjs";
import { MERGED_CATALOG_PATH } from "./paths.mjs";

/**
 * State mutations are Router-owned and atomic with their generation. Target
 * pickers are somebody else's documents, so refresh them only after commit.
 */
export async function transactNodeMutationAndRefreshTargets({
  files,
  mutate,
  reason,
  transaction = transactNodeStateMutation,
  refreshTargets,
  hasBaseCatalog = () => existsSync(MERGED_CATALOG_PATH),
  ...transactionOptions
} = {}) {
  // Initial credential/setup flows can happen before a native catalog exists.
  // Still retain the protected-file rollback boundary, but defer publication
  // until startup/catalog refresh creates the base template. A fabricated
  // generation here would either fail startup or violate the one-pointer rule.
  const hasInjectedRebuild = Boolean(
    transactionOptions.rebuild || transactionOptions.buildFiles || transactionOptions.publish,
  );
  const rebuild = !hasInjectedRebuild && !hasBaseCatalog()
    ? async (deferredReason) => Object.freeze({ reason: deferredReason, deferred: true })
    : undefined;
  const result = await transaction({
    files,
    mutate,
    reason,
    ...transactionOptions,
    ...(rebuild ? { rebuild } : {}),
  });
  if (typeof refreshTargets === "function") await refreshTargets();
  return result;
}

/** A cold service has no generation to rebuild until its base catalog exists. */
export async function rebuildAfterStartup({
  hasBaseCatalog = () => existsSync(MERGED_CATALOG_PATH),
  rebuild,
} = {}) {
  if (!hasBaseCatalog()) return undefined;
  if (typeof rebuild !== "function") {
    const { rebuildNodeSnapshots } = await import("./catalog-rebuild.mjs");
    return rebuildNodeSnapshots("service-startup");
  }
  return rebuild("service-startup");
}

/**
 * Registry refresh is the only place read-time fingerprint mismatches become
 * a persisted mutation. All affected proofs are invalidated before one rebuild.
 */
export async function rebuildAfterRegistryUpdate({
  models,
  invalidate,
  rebuild,
} = {}) {
  const changed = Array.isArray(models) ? models : [];
  if (typeof invalidate !== "function") {
    const { invalidateProtocolProofsForModels } = await import("./protocol-proof.mjs");
    await invalidateProtocolProofsForModels(changed);
  } else {
    await invalidate(changed);
  }
  if (typeof rebuild !== "function") {
    const { rebuildNodeSnapshots } = await import("./catalog-rebuild.mjs");
    return rebuildNodeSnapshots("registry-update");
  }
  return rebuild("registry-update");
}

/**
 * In-process native-session observer. It keeps only the spendability bit;
 * credentials, account ids, mtimes and token fingerprints never leave the
 * session module. Changes racing an active build request one later build.
 */
export function createNativeSessionSnapshotObserver({ rebuild } = {}) {
  if (typeof rebuild !== "function") throw new Error("A native-session observer requires rebuild().");
  let known;
  let initialized = false;
  let running;
  let pending = false;
  let current;

  const run = async () => {
    do {
      pending = false;
      await rebuild("native-session-usability");
    } while (pending);
  };

  return Object.freeze({
    async observe(status) {
      const usable = status?.usable === true;
      if (!initialized) {
        initialized = true;
        known = usable;
        return current;
      }
      if (known === usable) return current;
      known = usable;
      if (running) {
        pending = true;
        return current;
      }
      running = true;
      current = run().finally(() => {
        running = false;
      });
      return current;
    },
    snapshot() {
      return Object.freeze({ usable: known === true });
    },
  });
}

async function main() {
  if (process.argv[2] !== "registry-update") {
    throw new Error("Usage: node-snapshot-triggers.mjs registry-update");
  }
  const [{ nodeRoutableModels }, { configuredProviderIds }, { readHiddenModels }] = await Promise.all([
    import("./model-contract.mjs"),
    import("./provider-selection.mjs"),
    import("./model-picker-state.mjs"),
  ]);
  await rebuildAfterRegistryUpdate({
    models: nodeRoutableModels({
      enabledProviders: new Set(configuredProviderIds()),
      hiddenModels: readHiddenModels(),
    }),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
