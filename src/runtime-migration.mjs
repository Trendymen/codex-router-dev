function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function rollbackError(primary, failures) {
  if (failures.length === 0) return primary;
  return new AggregateError(
    [asError(primary), ...failures.map(asError)],
    "Runtime migration failed and automatic restoration was incomplete.",
    { cause: primary },
  );
}

async function invoke(value, ...args) {
  if (typeof value !== "function") return;
  return value(...args);
}

/**
 * Replace the installed runtime as a commit-after-verification transaction.
 *
 * Verification may be supplied as one `verifyReplacement` callback or as the
 * named bootstrap/health/browser/Swift callbacks. The named form makes the
 * failure boundary explicit and keeps each contract independently injectable
 * in unit and acceptance fixtures.
 */
export async function migrateRuntime(steps = {}) {
  const snapshot = typeof steps.snapshot === "function"
    ? await steps.snapshot()
    : steps.snapshot;
  if (snapshot === undefined) throw new Error("Runtime migration requires a snapshot.");

  try {
    await invoke(steps.installReplacement, snapshot);
    if (typeof steps.verifyReplacement === "function") {
      await steps.verifyReplacement(snapshot);
    } else {
      await invoke(steps.bootstrapReplacement, snapshot);
      await invoke(steps.verifyRouterHealth, snapshot);
      await invoke(steps.verifyBrowserContract, snapshot);
      await invoke(steps.verifySwiftContract, snapshot);
    }
    await invoke(steps.publishReplacement, snapshot);
    await invoke(steps.cleanupOld, snapshot);
    return { ok: true, cleaned: true };
  } catch (primary) {
    const rollbackFailures = [];
    try {
      if (typeof steps.restoreSnapshot !== "function") {
        throw new Error("Runtime migration has no restoreSnapshot operation.");
      }
      await steps.restoreSnapshot(snapshot);
    } catch (error) {
      rollbackFailures.push(error);
    }
    // Restart is deliberately a separate attempt. A failed restore must not
    // prevent the old service from being asked back up, and neither failure may
    // hide the operation that originally failed.
    try {
      if (typeof steps.restartOldService !== "function") {
        throw new Error("Runtime migration has no restartOldService operation.");
      }
      await steps.restartOldService(snapshot);
    } catch (error) {
      rollbackFailures.push(error);
    }
    throw rollbackError(primary, rollbackFailures);
  }
}

export async function verifyReplacementContracts({
  verifyRouterHealth,
  verifyBrowserContract,
  verifySwiftContract,
} = {}) {
  await invoke(verifyRouterHealth);
  await invoke(verifyBrowserContract);
  await invoke(verifySwiftContract);
  return true;
}
