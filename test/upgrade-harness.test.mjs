import assert from "node:assert/strict";
import net from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createIsolatedEnvironment, planIsolatedEnvironment } from "../scripts/verify-isolated-install.mjs";
import { privateFileIsProtected, protectPrivateFile, writePrivateFile } from "../src/file-security.mjs";
import { installReplacementPreservingProtected, preflightProductionCases, releasePlans, runUpgradeCases, settleUpgradeRun, setupReleasedRuntime, verifyUpgradeAndRollback } from "../scripts/verify-upgrade-preservation.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-upgrade-harness-"));
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return { root, sourceRoot };
}

function seed(env) {
  env.mkdir(path.dirname(env.target.routerPlistPath));
  env.write(path.relative(env.root, env.target.routerPlistPath), "old-router\n", 0o640);
  env.mkdir(env.stateRoot);
  env.write(path.relative(env.root, env.credentialsPath), "protected-caller\n", 0o600);
  protectPrivateFile(env.credentialsPath);
  chmodSync(env.target.routerPlistPath, 0o640);
}

function callbacks(env, { failurePoint = null, calls = [] } = {}) {
  return {
    failurePoint,
    snapshot: async () => calls.push("snapshot"),
    partialReplacement: async () => {
      calls.push("partial");
      env.write(path.relative(env.root, env.target.routerPlistPath), "partial-router\n", 0o600);
      env.write(path.relative(env.root, path.join(env.target.appPath, "Contents", "MacOS", "Model Router")), "partial-app\n", 0o700);
    },
    replacement: async () => {
      calls.push("replacement");
      rmSync(env.target.appPath, { recursive: true, force: true });
      env.write(path.relative(env.root, env.target.routerPlistPath), "new-router\n", 0o600);
      env.write(path.relative(env.root, path.join(env.target.appPath, "Contents", "MacOS", "Model Router")), "new-app\n", 0o755);
    },
    bootstrap: async () => calls.push("bootstrap"),
    health: async () => {
      calls.push("health");
      return { ok: true };
    },
    browser: async () => calls.push("browser"),
    swift: async () => calls.push("swift"),
    cleanup: async () => calls.push("cleanup"),
    restoreSnapshot: async (_env, saved) => {
      calls.push("restore");
      for (const item of saved) {
        if (!item.existed) {
          rmSync(item.file, { force: true });
          continue;
        }
        env.write(path.relative(env.root, item.file), item.bytes, item.mode);
        if (item.file === env.credentialsPath) protectPrivateFile(item.file);
      }
    },
    cleanupReplacementOwned: async () => {
      calls.push("owned-cleanup");
      rmSync(env.target.appPath, { recursive: true, force: true });
    },
    oldService: async () => calls.push("old:restore"),
    assertRollback: async (_env, releasedFixture) => {
      calls.push("rollback-asserted");
      return { protected: true, health: { ok: true }, oldIdentity: { release: releasedFixture.release } };
    },
  };
}

function releasedFixture(env, { release = "fixture", failurePoint = "health", calls = [], overrides = {} } = {}) {
  return { release, callbacks: { ...callbacks(env, { failurePoint, calls }), ...overrides } };
}

test("upgrade harness runs one isolated boundary and restores protected bytes/modes", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "upgrade" });
    seed(env);
    const before = { router: readFileSync(env.target.routerPlistPath), routerMode: statSync(env.target.routerPlistPath).mode & 0o777, credential: readFileSync(env.credentialsPath), credentialMode: statSync(env.credentialsPath).mode & 0o777 };
    const calls = [];
    const result = await verifyUpgradeAndRollback(env, { release: "fixture", callbacks: callbacks(env, { failurePoint: "health", calls }) });
    assert.equal(result.status, "rolled_back");
    assert.equal(result.failurePoint, "health");
    assert.deepEqual(readFileSync(env.target.routerPlistPath), before.router);
    assert.equal(statSync(env.target.routerPlistPath).mode & 0o777, before.routerMode);
    assert.deepEqual(readFileSync(env.credentialsPath), before.credential);
    assert.equal(statSync(env.credentialsPath).mode & 0o777, before.credentialMode);
    assert.equal(existsSync(env.target.appPath), false);
    assert.ok(calls.includes("old:restore"));
    assert.equal(existsSync(path.join(root, "evidence", "upgrade.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public upgrade verifier accepts exactly environment and released fixture, with a complete fixture callback bundle", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "two-arguments" });
    seed(env);
    const calls = [];
    const released = releasedFixture(env, { calls });
    assert.equal(verifyUpgradeAndRollback.length, 2);
    const result = await verifyUpgradeAndRollback(env, released);
    assert.equal(result.status, "rolled_back");
    assert.ok(calls.includes("rollback-asserted"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("released runtime installs shared secrets before start and the replacement preserves the same caller identity", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "released-install", sourceCommit: "released" });
    seed(env);
    const events = [];
    const oldRuntime = {
      callbacks: {
        install: async (oldEnv) => {
          events.push("old:install");
          writePrivateFile(path.join(oldEnv.stateRoot, "caller-secret"), "shared-caller\n", { directoryMode: 0o700 });
          writePrivateFile(path.join(oldEnv.stateRoot, "internal-secret"), "shared-internal\n", { directoryMode: 0o700 });
        },
        health: async () => {
          events.push("old:health");
          return { ok: true };
        },
      },
      start: async () => {
        events.push("old:start");
        return { pid: 4242 };
      },
    };
    const oldIdentity = await setupReleasedRuntime({ oldRuntime, oldEnv: env, oldCommit: "released" });
    assert.deepEqual(events, ["old:install", "old:start", "old:health"]);
    assert.equal(oldIdentity.sourceCommit, "released");
    assert.deepEqual(readFileSync(path.join(env.stateRoot, "caller-secret")), Buffer.from("shared-caller\n"));
    assert.equal(privateFileIsProtected(path.join(env.stateRoot, "caller-secret")), true);
    assert.equal(privateFileIsProtected(path.join(env.stateRoot, "internal-secret")), true);

    const replacement = {
      callbacks: {
        install: async (currentEnv) => {
          events.push("new:install");
          assert.deepEqual(readFileSync(path.join(currentEnv.stateRoot, "caller-secret")), Buffer.from("shared-caller\n"));
        },
      },
    };
    const proof = await installReplacementPreservingProtected(env, replacement);
    assert.deepEqual(proof, { protected: true, callerPreserved: true });
    assert.deepEqual(readFileSync(path.join(env.stateRoot, "caller-secret")), Buffer.from("shared-caller\n"));
    await assert.rejects(
      () => installReplacementPreservingProtected(env, { callbacks: { install: async (currentEnv) => currentEnv.write(path.relative(currentEnv.root, path.join(currentEnv.stateRoot, "caller-secret")), "rotated-caller\n", 0o600) } }),
      /protected bytes|caller identity/,
    );

    await assert.rejects(
      () => setupReleasedRuntime({ oldRuntime: { callbacks: {} }, oldEnv: env, oldCommit: "released" }),
      /install callback/,
    );
    const noSecrets = {
      callbacks: {
        install: async () => {},
        health: async () => ({ ok: true }),
      },
      start: async () => ({ pid: 1 }),
    };
    const noSecretEnv = createIsolatedEnvironment({ root: path.join(root, "missing-secrets"), sourceRoot, nonce: "missing-secrets", sourceCommit: "released" });
    await assert.rejects(() => setupReleasedRuntime({ oldRuntime: noSecrets, oldEnv: noSecretEnv, oldCommit: "released" }), /shared secret/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade verifier validates the complete callback bundle before beginning a transaction", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "callback-contract" });
    seed(env);
    let snapshots = 0;
    await assert.rejects(
      () => verifyUpgradeAndRollback(env, { release: "fixture", callbacks: { snapshot: async () => { snapshots += 1; } } }),
      /complete callback bundle/i,
    );
    assert.equal(snapshots, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forced failure becomes rolled_back only after an intact restore, old service, cleanup, and rollback proof", async () => {
  const scenarios = [
    ["restore", (active) => { active.restoreSnapshot = async () => { throw new Error("restore failed"); }; }, (error) => error instanceof AggregateError && /Runtime migration failed/i.test(error.message)],
    ["old-service", (active) => { active.oldService = async () => { throw new Error("old service failed"); }; }, (error) => error instanceof AggregateError && /Runtime migration failed/i.test(error.message)],
    ["owned-cleanup", (active) => { active.cleanupReplacementOwned = async () => { throw new Error("owned cleanup failed"); }; }, /owned cleanup failed/],
    ["rollback-proof", (active) => { active.assertRollback = async () => { throw new Error("rollback proof failed"); }; }, /rollback proof failed/],
    ["invalid-rollback-proof", (active) => { active.assertRollback = async () => ({ protected: true, health: { ok: true }, oldIdentity: { release: "wrong-release" } }); }, /released identity/],
  ];
  for (const [name, mutate, expected] of scenarios) {
    const { root, sourceRoot } = fixture();
    try {
      const env = createIsolatedEnvironment({ root, sourceRoot, nonce: `failure-${name}` });
      seed(env);
      const released = releasedFixture(env);
      mutate(released.callbacks);
      await assert.rejects(() => verifyUpgradeAndRollback(env, released), expected);
      assert.equal(existsSync(path.join(root, "evidence", "upgrade.json")), false, `${name} must not be recorded as rolled back`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a same-message callback error is not accepted as the forced primary failure", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "identity" });
    seed(env);
    const released = releasedFixture(env, {
      overrides: { partialReplacement: async () => { throw new Error("forced health failure"); } },
    });
    await assert.rejects(() => verifyUpgradeAndRollback(env, released), /forced health failure/);
    assert.equal(existsSync(path.join(root, "evidence", "upgrade.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production upgrade preflight reserves every planned case before creating any requested root or report", async () => {
  const { root } = fixture();
  const requestedRoot = path.join(root, "requested-root");
  const replacementRoot = path.join(requestedRoot, "cases", "replacement");
  const nonce = `upgrade-${Buffer.from(replacementRoot).toString("hex").slice(-16)}`;
  const planned = planIsolatedEnvironment({ root: replacementRoot, sourceName: "current-checkout", nonce });
  const occupied = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(planned.target.ports.router, "127.0.0.1", resolve);
    });
    await assert.rejects(() => preflightProductionCases({ root: requestedRoot }));
    assert.equal(existsSync(requestedRoot), false);
    assert.equal(existsSync(path.join(requestedRoot, "cases")), false);
    assert.equal(existsSync(path.join(requestedRoot, "evidence", "upgrade.json")), false);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("production preflight releases every acquired lease in reverse order and preserves acquire plus cleanup failures", async () => {
  const { root } = fixture();
  try {
    const requestedRoot = path.join(root, "requested-root");
    const released = [];
    let acquired = 0;
    await assert.rejects(
      () => preflightProductionCases({
        root: requestedRoot,
        failurePoints: ["replacement", "bootstrap", "health", "browser"],
        assertPorts: async () => {},
        acquireLease: () => {
          const index = acquired++;
          if (index === 3) throw new Error("acquire failed");
          return () => {
            released.push(index);
            if (index === 1) throw new Error("release failed");
          };
        },
      }),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.cause?.message, "acquire failed");
        assert.equal(error.errors[0]?.message, "acquire failed");
        assert.equal(error.errors[1]?.message, "release failed");
        return true;
      },
    );
    assert.deepEqual(released, [2, 1, 0]);
    assert.equal(existsSync(requestedRoot), false);

    const normalReleased = [];
    let normalAcquired = 0;
    const plans = await preflightProductionCases({
      root: path.join(root, "normal-root"),
      failurePoints: ["replacement", "bootstrap"],
      assertPorts: async () => {},
      acquireLease: () => {
        const index = normalAcquired++;
        return () => normalReleased.push(index);
      },
    });
    assert.deepEqual(releasePlans(plans), []);
    assert.deepEqual(normalReleased, [2, 1, 0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public upgrade settlement releases all leases before recording and preserves runner plus cleanup failures", async () => {
  const released = [];
  let records = 0;
  const primary = new Error("runner failed");
  const plans = [0, 1, 2].map((index) => ({ release: () => {
    released.push(index);
    if (index === 1) throw new Error("release failed");
  } }));
  await assert.rejects(
    () => settleUpgradeRun({
      plans,
      run: async () => { throw primary; },
      record: async () => { records += 1; },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors[1]?.message, "release failed");
      return true;
    },
  );
  assert.deepEqual(released, [2, 1, 0]);
  assert.equal(records, 0);

  let failedRecords = 0;
  await assert.rejects(
    () => settleUpgradeRun({
      plans: [{ release: () => { throw new Error("success cleanup failed"); } }],
      run: async () => ({ status: "passed" }),
      record: async () => { failedRecords += 1; },
    }),
    /success cleanup failed/,
  );
  assert.equal(failedRecords, 0);

  let cleanRecords = 0;
  const settled = await settleUpgradeRun({
    plans: [{ release: () => {} }],
    run: async () => ({ status: "passed" }),
    record: async (result) => {
      assert.equal(result.status, "passed");
      cleanRecords += 1;
    },
  });
  assert.equal(settled.status, "passed");
  assert.equal(cleanRecords, 1);
});

test("per-case factories isolate bootstrap residue from the later health case and preserve success credentials", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const seen = [];
    const result = await runUpgradeCases({
      root,
      sourceCommit: "current",
      releasedCommit: "released",
      failurePoints: ["bootstrap", "health"],
      createCase: async (state) => {
        mkdirSync(state.root, { recursive: true, mode: 0o700 });
        const env = createIsolatedEnvironment({ root: state.root, sourceRoot, nonce: state.name });
        seed(env);
        const initial = readFileSync(env.credentialsPath);
        const active = callbacks(env, { failurePoint: state.failurePoint });
        const originalPartial = active.partialReplacement;
        active.partialReplacement = async () => {
          await originalPartial();
          seen.push({ name: state.name, root: env.root, appExistsBefore: existsSync(env.target.appPath) });
        };
        active.cleanup = async () => {
          assert.deepEqual(readFileSync(env.credentialsPath), initial);
          assert.equal(privateFileIsProtected(env.credentialsPath), true);
          seen.push({ name: state.name, root: env.root, success: true });
        };
        return { env, releasedFixture: { release: "released", replacement: "current", callbacks: active } };
      },
    });
    assert.equal(result.status, "passed");
    assert.deepEqual(result.cases.map((entry) => entry.name), ["bootstrap", "health", "success"]);
    const bootstrap = seen.find((entry) => entry.name === "bootstrap");
    const health = seen.find((entry) => entry.name === "health");
    assert.notEqual(bootstrap.root, health.root);
    assert.equal(health.appExistsBefore, true);
    assert.equal(existsSync(path.join(root, "evidence", "upgrade.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("case cleanup disposes both runtimes, withholds passed aggregate on disposal failure, and releases setup leases", async () => {
  const { root } = fixture();
  try {
    const disposeCalls = [];
    let releases = 0;
    await assert.rejects(() => runUpgradeCases({
      root,
      failurePoints: ["replacement"],
      createCase: async (state) => {
        state.release = () => { releases += 1; };
        state.runtime = { dispose: async () => { disposeCalls.push("new"); throw new Error("new dispose failed"); } };
        state.oldRuntime = { dispose: async () => { disposeCalls.push("old"); } };
        throw new Error("setup failed after lease");
      },
    }), /upgrade case/i);
    assert.deepEqual(disposeCalls, ["new", "old"]);
    assert.equal(releases, 1);
    const aggregate = JSON.parse(readFileSync(path.join(root, "evidence", "upgrade.json"), "utf8"));
    assert.equal(aggregate.status, "failed");
    assert.equal(aggregate.cases[0].status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade harness aborts before a callback when environment ownership is invalid", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "invalid" });
    let calls = 0;
    await assert.rejects(() => verifyUpgradeAndRollback({ ...env, root: path.dirname(root) }, { callbacks: { snapshot: async () => { calls += 1; } } }), /isolated|root|validated/i);
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade unit harness emits only local reports and never executes CLI acceptance evidence", async () => {
  const { root, sourceRoot } = fixture();
  try {
    const env = createIsolatedEnvironment({ root, sourceRoot, nonce: "no-evidence" });
    seed(env);
    const result = await verifyUpgradeAndRollback(env, { release: "unit", callbacks: callbacks(env) });
    assert.equal(result.status, "completed");
    assert.equal(existsSync(path.join(root, "evidence", "upgrade.json")), true);
    assert.equal(existsSync(path.join(root, "acceptance-evidence.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
