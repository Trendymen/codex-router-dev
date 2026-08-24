import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactSensitive } from "../src/sensitive-redactor.mjs";
import { privateFileIsProtected, writePrivateFile } from "../src/file-security.mjs";
import { migrateRuntime } from "../src/runtime-migration.mjs";
import { recordAcceptanceEvidence } from "./verify-acceptance.mjs";
import { acquireIsolationLease, assertCliPreflight, assertIsolatedEnvironment, assertPortsAvailable, assertPushedHarness, createIsolatedEnvironment, createLocalRuntime, planIsolatedEnvironment } from "./verify-isolated-install.mjs";

const FAILURE_POINTS = Object.freeze(["replacement", "bootstrap", "health", "browser", "swift"]);
const REQUIRED_CALLBACKS = Object.freeze([
  "snapshot",
  "partialReplacement",
  "replacement",
  "bootstrap",
  "health",
  "browser",
  "swift",
  "cleanup",
  "restoreSnapshot",
  "oldService",
  "cleanupReplacementOwned",
  "assertRollback",
]);

function snapshot(env) {
  return [env.target.routerPlistPath, env.target.trayPlistPath, env.credentialsPath, path.join(env.stateRoot, "caller-secret"), path.join(env.stateRoot, "internal-secret")]
    .map((file) => ({ file, existed: existsSync(file), bytes: existsSync(file) ? readFileSync(file) : null, mode: existsSync(file) ? statSync(file).mode & 0o777 : null }));
}

function restore(items) {
  for (const item of items) {
    if (!item.existed) {
      rmSync(item.file, { force: true });
      continue;
    }
    if (existsSync(item.file) && lstatSync(item.file).isSymbolicLink()) throw new Error("refusing rollback through a symbolic link");
    mkdirSync(path.dirname(item.file), { recursive: true, mode: 0o700 });
    const temporary = `${item.file}.${process.pid}.rollback`;
    writeFileSync(temporary, item.bytes, { mode: item.mode });
    renameSync(temporary, item.file);
    chmodSync(item.file, item.mode);
  }
}

function equal(items) {
  return items.every((item) => existsSync(item.file) === item.existed
    && (!item.existed || (readFileSync(item.file).equals(item.bytes) && (statSync(item.file).mode & 0o777) === item.mode)));
}

function equalProtected(items, env) {
  const owned = new Set([env.target.routerPlistPath, env.target.trayPlistPath]);
  const protectedItems = items.filter((item) => !owned.has(item.file));
  return equal(protectedItems) && protectedItems.every((item) => !item.existed || privateFileIsProtected(item.file));
}

function requireCallbacks(releasedFixture) {
  const callbacks = releasedFixture?.callbacks;
  if (!callbacks || typeof callbacks !== "object") throw new Error("upgrade harness requires releasedFixture.callbacks");
  const missing = REQUIRED_CALLBACKS.filter((name) => typeof callbacks[name] !== "function");
  if (missing.length) throw new Error(`upgrade harness requires complete callback bundle: ${missing.join(", ")}`);
  return callbacks;
}

function rollbackProof(proof, releasedFixture) {
  if (!proof || typeof proof !== "object") throw new Error("rollback assertion did not return a proof");
  if (proof.protected !== true) throw new Error("rollback assertion did not prove protected state");
  if (proof.health?.ok !== true) throw new Error("rollback assertion did not prove old service health");
  if (!proof.oldIdentity || proof.oldIdentity.release !== releasedFixture.release) throw new Error("rollback assertion did not prove released identity");
}

function writeReport(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return file;
}

function scenarioReport(env, value) {
  return writeReport(path.join(env.evidenceRoot, "upgrade.json"), value);
}

function forcedFailure(point) {
  return new Error(`forced ${point} failure`);
}

/** One isolated migration transaction; `failurePoint` intentionally selects one boundary only. */
export async function verifyUpgradeAndRollback(environment, releasedFixture) {
  const env = assertIsolatedEnvironment(environment);
  if (!releasedFixture || typeof releasedFixture !== "object") throw new Error("released fixture is required");
  const callbacks = requireCallbacks(releasedFixture);
  const failureAt = callbacks.failurePoint ?? releasedFixture.failurePoint ?? null;
  if (failureAt !== null && !FAILURE_POINTS.includes(failureAt)) throw new Error(`unknown upgrade failure point: ${failureAt}`);
  const original = snapshot(env);
  const reached = [];
  let expectedFailure;
  const force = (point) => {
    if (failureAt === point) {
      reached.push(point);
      expectedFailure = forcedFailure(point);
      throw expectedFailure;
    }
  };
  const transaction = {
    snapshot: original,
    preflight: async () => callbacks.snapshot(env, releasedFixture),
    installReplacement: async () => {
      await callbacks.partialReplacement(env, releasedFixture);
      force("replacement");
      await callbacks.replacement(env, releasedFixture);
    },
    verifyReplacement: async () => {
      force("bootstrap");
      await callbacks.bootstrap(env, releasedFixture);
      force("health");
      const health = await callbacks.health(env, releasedFixture);
      if (health?.ok !== true) throw new Error("replacement router health is not OK");
      force("browser");
      await callbacks.browser(env, releasedFixture);
      force("swift");
      await callbacks.swift(env, releasedFixture);
    },
    publishReplacement: async () => {},
    cleanupOld: async () => callbacks.cleanup(env, releasedFixture),
    restoreSnapshot: async () => callbacks.restoreSnapshot(env, original, releasedFixture),
    restartOldService: async () => callbacks.oldService(env, "restore", releasedFixture),
  };
  try {
    const migration = await migrateRuntime(transaction);
    if (failureAt) throw new Error(`forced ${failureAt} failure unexpectedly succeeded`);
    if (!equalProtected(original, env)) throw new Error("successful replacement did not preserve protected bytes and modes");
    const artifact = scenarioReport(env, { schemaVersion: 3, status: "completed", fixture: releasedFixture.release || "released", replacement: releasedFixture.replacement || null, failurePoint: null, migration, preserved: original.map(({ file, existed, mode }) => ({ file: path.relative(env.root, file), existed, mode })) });
    return { status: "completed", artifact, failurePoint: null };
  } catch (error) {
    // `migrateRuntime` emits AggregateError whenever either restoration step
    // failed. A rollback report is permitted only for our exact forced primary,
    // not for an error that merely contains the same text somewhere in a chain.
    if (!failureAt || error !== expectedFailure || error?.constructor !== Error || error instanceof AggregateError || error.message !== `forced ${failureAt} failure`) throw error;
    if (reached.length !== 1 || reached[0] !== failureAt) throw new Error(`upgrade did not reach forced ${failureAt} boundary`);
    await callbacks.cleanupReplacementOwned(env, releasedFixture);
    if (!equal(original)) throw new Error(`rollback did not preserve ${failureAt} fixture bytes and modes`);
    const proof = await callbacks.assertRollback(env, releasedFixture, original);
    rollbackProof(proof, releasedFixture);
    const artifact = scenarioReport(env, { schemaVersion: 3, status: "rolled_back", fixture: releasedFixture.release || "released", replacement: releasedFixture.replacement || null, failurePoint: failureAt, reached, preserved: original.map(({ file, existed, mode }) => ({ file: path.relative(env.root, file), existed, mode })) });
    return { status: "rolled_back", artifact, failurePoint: failureAt };
  }
}

function aggregateError(errors, message) {
  const present = errors.filter(Boolean);
  if (present.length === 0) return null;
  return present.length === 1 ? present[0] : new AggregateError(present, message, { cause: present[0] });
}

async function disposeCase(state) {
  const errors = [];
  const dispose = await Promise.allSettled([state.runtime?.dispose(), state.oldRuntime?.dispose()]);
  for (const result of dispose) if (result.status === "rejected") errors.push(result.reason);
  try {
    if (state.ports) await assertPortsAvailable(state.ports);
  } catch (error) {
    errors.push(error);
  }
  try {
    state.release?.();
  } catch (error) {
    errors.push(error);
  }
  state.release = undefined;
  return aggregateError(errors, "upgrade case cleanup failed");
}

/**
 * Resource-owning runner used by the real CLI and injected unit fixtures. The
 * factory receives state before setup so a failed setup still releases a lease
 * and disposes both runtime handles.
 */
export async function runUpgradeCases({ root, sourceCommit, releasedCommit, createCase, failurePoints = FAILURE_POINTS, deferReport = false } = {}) {
  if (!path.isAbsolute(root)) throw new Error("upgrade cases require an absolute root");
  if (typeof createCase !== "function") throw new Error("upgrade cases require a case factory");
  const cases = [];
  let primary;
  for (const failurePoint of [...failurePoints, null]) {
    const name = failurePoint || "success";
    const state = { name, root: path.join(root, "cases", name), failurePoint };
    let result;
    let caseError;
    try {
      const configured = await createCase(state);
      if (configured && configured !== state) Object.assign(state, configured);
      result = await verifyUpgradeAndRollback(state.env, state.releasedFixture);
      const expected = failurePoint ? "rolled_back" : "completed";
      if (result.status !== expected) throw new Error(`upgrade ${name} returned ${result.status}, expected ${expected}`);
    } catch (error) {
      caseError = error;
    }
    const cleanupError = await disposeCase(state);
    const combined = aggregateError([caseError, cleanupError], `upgrade case ${name} failed`);
    cases.push({ name, failurePoint, status: combined ? "failed" : "passed", failureReached: result?.failurePoint || null, artifact: result?.artifact || null, oldRuntime: state.oldIdentity || null, cleanup: cleanupError ? "failed" : "completed", error: combined ? redactSensitive(combined.message, { profile: "log" }) : null });
    if (combined) {
      primary = combined;
      break;
    }
  }
  const aggregate = { schemaVersion: 3, status: primary ? "failed" : "passed", sourceCommit, releasedCommit, cases };
  const result = {
    status: "passed",
    artifact: null,
    cases,
    aggregate,
    finalize: () => {
      result.artifact ||= writeReport(path.join(root, "evidence", "upgrade.json"), aggregate);
      return result.artifact;
    },
  };
  if (primary) {
    if (!deferReport) result.finalize();
    throw primary;
  }
  if (!deferReport) result.finalize();
  return result;
}

function productionCasePlan(root, name) {
  const caseRoot = path.join(root, "cases", name);
  const nonce = `upgrade-${Buffer.from(caseRoot).toString("hex").slice(-16)}`;
  const planned = planIsolatedEnvironment({ root: caseRoot, sourceName: "current-checkout", nonce });
  return { name, root: caseRoot, nonce, target: planned.target };
}

export function releasePlans(plans) {
  const errors = [];
  for (const plan of [...plans].reverse()) {
    const release = plan.release;
    plan.release = undefined;
    try {
      release?.();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwWithLeaseCleanup(primary, cleanupErrors, message) {
  if (!cleanupErrors.length) {
    if (primary) throw primary;
    return;
  }
  if (primary) throw new AggregateError([primary, ...cleanupErrors], message, { cause: primary });
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, message, { cause: cleanupErrors[0] });
}

/** Settle the public CLI after all case resources have had one release attempt. */
export async function settleUpgradeRun({ run, plans, record } = {}) {
  if (typeof run !== "function") throw new Error("upgrade settlement requires a runner");
  if (!Array.isArray(plans)) throw new Error("upgrade settlement requires planned leases");
  if (typeof record !== "function") throw new Error("upgrade settlement requires an evidence recorder");
  let result;
  let primary;
  try {
    result = await run();
  } catch (error) {
    primary = error;
  }
  throwWithLeaseCleanup(primary, releasePlans(plans), "production upgrade failed and lease cleanup was incomplete");
  await record(result);
  return result;
}

/**
 * Pure-plan every production case, then reserve every port set before any
 * case root or aggregate report may be written. Leases deliberately live
 * through the runner so another process cannot win a later case's ports.
 */
export async function preflightProductionCases({ root, failurePoints = FAILURE_POINTS, assertPorts = assertPortsAvailable, acquireLease = acquireIsolationLease } = {}) {
  if (!path.isAbsolute(root)) throw new Error("production upgrade preflight requires an absolute root");
  const plans = [...failurePoints, null].map((failurePoint) => {
    const name = failurePoint || "success";
    return { ...productionCasePlan(root, name), failurePoint };
  });
  try {
    for (const plan of plans) {
      await assertPorts(plan.target.ports);
      plan.release = acquireLease(plan.root, plan.target.ports);
      await assertPorts(plan.target.ports);
    }
    return plans;
  } catch (error) {
    throwWithLeaseCleanup(error, releasePlans(plans), "production upgrade preflight failed and lease cleanup was incomplete");
  }
}

function writePartialReplacement(env) {
  mkdirSync(path.dirname(env.target.routerPlistPath), { recursive: true, mode: 0o700 });
  writeFileSync(env.target.routerPlistPath, "partial-owned-replacement\n", { mode: 0o600 });
  mkdirSync(path.dirname(env.target.appBinary), { recursive: true, mode: 0o700 });
  writeFileSync(env.target.appBinary, "partial-owned-app-marker\n", { mode: 0o700 });
  chmodSync(env.target.appBinary, 0o700);
}

function removeReplacementResidue(env) {
  rmSync(env.target.appPath, { recursive: true, force: true });
}

function sharedSecretFiles(env) {
  return [path.join(env.stateRoot, "caller-secret"), path.join(env.stateRoot, "internal-secret")];
}

function captureSharedSecrets(env) {
  return sharedSecretFiles(env).map((file) => {
    if (!existsSync(file)) throw new Error(`runtime installer did not provision shared secret: ${file}`);
    if (!privateFileIsProtected(file)) throw new Error(`runtime installer did not protect shared secret: ${file}`);
    return { file, bytes: readFileSync(file), mode: statSync(file).mode & 0o777 };
  });
}

function sameSnapshots(left, right) {
  return left.length === right.length && left.every((item, index) => item.file === right[index]?.file
    && item.mode === right[index]?.mode && item.bytes.equals(right[index]?.bytes));
}

/** Prepare the released runtime through its installer before it may start. */
export async function setupReleasedRuntime({ oldRuntime, oldEnv, oldCommit } = {}) {
  if (typeof oldRuntime?.callbacks?.install !== "function") throw new Error("released runtime requires an install callback");
  if (typeof oldRuntime?.callbacks?.health !== "function") throw new Error("released runtime requires a health callback");
  if (typeof oldRuntime?.start !== "function") throw new Error("released runtime requires a start callback");
  await oldRuntime.callbacks.install(oldEnv);
  captureSharedSecrets(oldEnv);
  const started = await oldRuntime.start();
  const health = await oldRuntime.callbacks.health(oldEnv);
  if (health?.ok !== true || !Number.isInteger(started?.pid) || oldEnv.sourceCommit !== oldCommit) throw new Error("released runtime did not start with the expected identity and health");
  return { sourceRoot: oldEnv.sourceRoot, sourceCommit: oldCommit, pid: started.pid };
}

/** The new installer shares the released state root and may not rotate secrets. */
export async function installReplacementPreservingProtected(environment, runtime) {
  if (typeof runtime?.callbacks?.install !== "function") throw new Error("replacement runtime requires an install callback");
  const protectedBefore = snapshot(environment);
  const sharedBefore = captureSharedSecrets(environment);
  await runtime.callbacks.install(environment);
  if (!equalProtected(protectedBefore, environment)) throw new Error("replacement installer changed protected bytes or modes");
  const sharedAfter = captureSharedSecrets(environment);
  if (!sameSnapshots(sharedBefore, sharedAfter)) throw new Error("replacement installer changed the shared caller identity");
  return { protected: true, callerPreserved: true };
}

async function productionCase(state, { sourceCommit, oldCommit, plan }) {
  const root = state.root;
  if (!plan || plan.name !== state.name || plan.root !== root || typeof plan.release !== "function") throw new Error(`missing preflight lease for upgrade ${state.name}`);
  state.ports = plan.target.ports;
  state.release = plan.release;
  plan.release = undefined;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const nonce = plan.nonce;
  state.env = createIsolatedEnvironment({ root, sourceName: "current-checkout", nonce, sourceCommit });
  if (JSON.stringify(state.env.target.ports) !== JSON.stringify(plan.target.ports)) throw new Error("upgrade case target drifted after preflight");
  state.oldEnv = createIsolatedEnvironment({ root, sourceName: "released-checkout", nonce, sourceCommit: oldCommit });
  mkdirSync(path.dirname(state.env.credentialsPath), { recursive: true, mode: 0o700 });
  writePrivateFile(state.env.credentialsPath, "protected-caller\n", { directoryMode: 0o700 });
  state.runtime = await createLocalRuntime(state.env, { sourceCommit });
  state.oldRuntime = await createLocalRuntime(state.oldEnv, { sourceCommit: oldCommit, allowReleased: true, requireSwift: false });
  state.oldIdentity = await setupReleasedRuntime({ oldRuntime: state.oldRuntime, oldEnv: state.oldEnv, oldCommit });
  const replace = async () => {
    // Remove the deliberately partial bundle before invoking the real installer.
    // The final public app path is installed through rename, leaving no partial
    // directory reachable by bootstrap, health, browser, or Swift checks.
    const residue = `${state.env.target.appPath}.partial-${process.pid}`;
    if (existsSync(state.env.target.appPath)) renameSync(state.env.target.appPath, residue);
    try {
      await installReplacementPreservingProtected(state.env, state.runtime);
      const installed = `${state.env.target.appPath}.installed-${process.pid}`;
      renameSync(state.env.target.appPath, installed);
      renameSync(installed, state.env.target.appPath);
    } finally {
      rmSync(residue, { recursive: true, force: true });
    }
    await state.oldRuntime.stop();
    await state.runtime.start();
  };
  state.releasedFixture = { release: oldCommit, replacement: sourceCommit, callbacks: {
    failurePoint: state.failurePoint,
    snapshot: async () => {},
    partialReplacement: async () => writePartialReplacement(state.env),
    replacement: replace,
    bootstrap: async () => {},
    health: async () => state.runtime.callbacks.health(state.env),
    browser: async () => state.runtime.callbacks.browser(state.env),
    swift: async () => state.runtime.callbacks.swift(state.env),
    cleanup: async () => {
      await state.oldRuntime.stop();
      rmSync(state.oldEnv.sourceRoot, { recursive: true, force: true });
      if (existsSync(state.oldEnv.sourceRoot)) throw new Error("successful upgrade did not remove released source");
      const health = await state.runtime.callbacks.health(state.env);
      if (health?.ok !== true) throw new Error("successful replacement router health is not OK");
    },
    restoreSnapshot: async (_env, saved) => restore(saved),
    cleanupReplacementOwned: async () => removeReplacementResidue(state.env),
    oldService: async () => {
      await state.runtime.stop();
      const started = await state.oldRuntime.start();
      const health = await state.oldRuntime.callbacks.health(state.oldEnv);
      if (health?.ok !== true || !Number.isInteger(started?.pid) || state.oldEnv.sourceCommit !== oldCommit) throw new Error("rollback did not restore the released runtime identity");
      state.oldIdentity = { sourceRoot: state.oldEnv.sourceRoot, sourceCommit: oldCommit, pid: started.pid };
    },
    assertRollback: async (_env, _fixture, original) => {
      if (existsSync(state.env.target.appPath)) throw new Error("rollback left replacement-owned app residue");
      const health = await state.oldRuntime.callbacks.health(state.oldEnv);
      if (health?.ok !== true || state.oldIdentity?.sourceRoot !== state.oldEnv.sourceRoot || state.oldIdentity?.sourceCommit !== oldCommit || !Number.isInteger(state.oldIdentity?.pid)) throw new Error("rollback identity assertion failed");
      return { protected: equalProtected(original, state.env), health, oldIdentity: { ...state.oldIdentity, release: oldCommit } };
    },
  } };
  return state;
}

async function cli() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
    return args[index + 1];
  };
  if (args.includes("--dry-run")) throw new Error("--dry-run is retired: the upgrade CLI always runs real local runtime");
  const requestedRoot = path.resolve(value("--root"));
  const evidence = path.resolve(value("--evidence"));
  const sourceCommit = value("--source-commit");
  const oldCommit = execFileSync("git", ["rev-parse", `${sourceCommit}^`], { encoding: "utf8" }).trim();
  const root = assertCliPreflight(requestedRoot);
  assertPushedHarness(sourceCommit);
  const plans = await preflightProductionCases({ root });
  await settleUpgradeRun({
    plans,
    run: () => runUpgradeCases({ root, sourceCommit, releasedCommit: oldCommit, deferReport: true, createCase: (state) => productionCase(state, { sourceCommit, oldCommit, plan: plans.find((plan) => plan.name === state.name) }) }),
    // Passed aggregate and acceptance evidence are deliberately last: every
    // case's two runtime disposals and every preflight lease release completed.
    record: async (result) => {
      const artifact = result.finalize();
      recordAcceptanceEvidence({ themeId: "success-upgrade", kind: "isolated-install", requirementId: "r53", profile: "task2-isolated-install", provider: null, state: "passed", reason: "isolated upgrade and rollback completed", artifact, sourceCommit }, evidence);
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli().catch((error) => {
  process.stderr.write(`${redactSensitive(error.message, { profile: "log" })}\n`);
  process.exitCode = 2;
});
