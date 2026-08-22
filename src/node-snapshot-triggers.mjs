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
  if (!result?.deferred && typeof refreshTargets === "function") await refreshTargets();
  return result;
}

/** A cold service has no generation to rebuild until its base catalog exists. */
export async function rebuildAfterStartup({
  hasBaseCatalog = () => existsSync(MERGED_CATALOG_PATH),
  rebuild,
  refreshTargets,
  ...rebuildOptions
} = {}) {
  if (!hasBaseCatalog()) return undefined;
  let result;
  if (typeof rebuild !== "function") {
    const { rebuildNodeSnapshots } = await import("./catalog-rebuild.mjs");
    result = await rebuildNodeSnapshots("service-startup", rebuildOptions);
  } else {
    result = await rebuild("service-startup");
  }
  if (!result?.deferred) {
    if (typeof refreshTargets === "function") await refreshTargets();
    else {
      const { refreshTargetPickerIfInstalled } = await import("./target-integration.mjs");
      await refreshTargetPickerIfInstalled({ rebuildCodex: false });
    }
  }
  return result;
}

/**
 * Registry refresh is the only place read-time fingerprint mismatches become
 * a persisted mutation. All affected proofs are invalidated before one rebuild.
 */
export async function rebuildAfterRegistryUpdate({
  models,
  invalidate,
  rebuild,
  ...transactionOptions
} = {}) {
  const changed = Array.isArray(models) ? models : [];
  if (typeof invalidate !== "function") {
    const [{ invalidateProtocolProofsForModels }, { transactNodeStateMutation }] = await Promise.all([
      import("./protocol-proof.mjs"),
      import("./catalog-rebuild.mjs"),
    ]);
    const { transaction: injectedTransaction, ...generationOptions } = transactionOptions;
    // Proof removal and generation switch are one registry transaction. Do
    // not publish an invalidation generation and immediately publish again.
    return invalidateProtocolProofsForModels(changed, {
      ...generationOptions,
      transaction: (input) => (injectedTransaction || transactNodeStateMutation)({
        ...input,
        reason: "registry-update",
      }),
    });
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
export function createNativeSessionSnapshotObserver({ rebuild, refreshTargets } = {}) {
  if (typeof rebuild !== "function") throw new Error("A native-session observer requires rebuild().");
  let desired;
  let generationPublished;
  let published;
  let initialized = false;
  let running;
  let pending = false;
  let targetRefreshPending = false;
  let current;

  const run = async () => {
    do {
      const rebuildPending = pending;
      pending = false;
      const target = desired;
      try {
        if (generationPublished !== target || rebuildPending) {
          const result = await rebuild("native-session-usability");
          if (result?.committed === false) {
            // A cold service has no merged base to publish yet. This is a
            // deliberate defer, not a generation commit or target refresh.
            pending ||= desired !== target;
            return;
          }
          generationPublished = target;
          targetRefreshPending = true;
        }
        if ((published !== target || targetRefreshPending) && typeof refreshTargets === "function") {
          await refreshTargets();
        }
        targetRefreshPending = false;
        // A usable state is published only when Router generation and every
        // installed external picker have both accepted it. If refresh fails,
        // retain the committed generation and retry only that external step.
        published = target;
      } catch (error) {
        // This is deliberately non-sensitive: callers can retry the same
        // usability state and no credential-derived detail leaves the module.
        // Keep a state reversal that raced the failed refresh. Its next
        // observation must rebuild from the current desired state instead of
        // returning the previous rejected promise as if it were published.
        pending ||= desired !== target;
        throw error;
      }
    } while (pending || desired !== published);
  };

  return Object.freeze({
    async observe(status) {
      const usable = status?.usable === true;
      if (!initialized) {
        initialized = true;
        desired = usable;
        generationPublished = usable;
        published = usable;
        return current;
      }
      if (
        desired === usable
        && desired === published
        && generationPublished === usable
        && !targetRefreshPending
      ) return current;
      if (running && desired === usable) return current;
      desired = usable;
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
      return Object.freeze({ usable: published === true, desiredUsable: desired === true });
    },
  });
}

async function main() {
  if (process.argv[2] !== "registry-update") {
    throw new Error("Usage: node-snapshot-triggers.mjs registry-update");
  }
  const [{ nodeRegistryModels }] = await Promise.all([
    import("./model-contract.mjs"),
  ]);
  await rebuildAfterRegistryUpdate({
    models: nodeRegistryModels(),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
