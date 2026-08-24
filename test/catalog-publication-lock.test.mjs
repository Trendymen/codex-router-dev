import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  assertCatalogPublicationLockHeld,
  catalogPublicationLockTarget,
  withCatalogPublicationLock,
} from "../src/catalog-publication-lock.mjs";
import {
  assertModelOverlayLockHeld,
  withModelOverlayLock,
} from "../src/model-overlay-lock.mjs";

const root = path.resolve(".");
const helperUrl = pathToFileURL(
  path.join(root, "src", "catalog-publication-lock.mjs"),
).href;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForLocked(child, stderr) {
  child.stdout.setEncoding("utf8");
  let output = "";
  while (!output.includes("locked\n")) {
    const winner = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => ({ chunk })),
      once(child, "exit").then(([code, signal]) => ({ code, signal })),
    ]);
    if ("code" in winner) {
      assert.fail(
        `lock holder exited before acquiring the lock (${winner.code ?? winner.signal}): ${stderr()}`,
      );
    }
    output += winner.chunk;
  }
}

test(
  "catalog publication lock heartbeats across processes, bounds overlap, and releases",
  { timeout: 10_000 },
  async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-lock-"));
    const script = `
      import { withCatalogPublicationLock } from ${JSON.stringify(helperUrl)};
      await withCatalogPublicationLock(async () => {
        process.stdout.write("locked\\n");
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }, {
        stateDir: ${JSON.stringify(stateDir)},
        waitMs: 200,
        retryMs: 25,
        staleMs: 2000,
        heartbeatMs: 1000,
      });
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      childStderr += chunk;
    });

    try {
      await waitForLocked(child, () => childStderr);
      // Wait beyond the stale horizon. A live holder remains exclusive only
      // if proper-lockfile's heartbeat has refreshed its directory mtime.
      await delay(2_300);
      const started = Date.now();
      await assert.rejects(
        withCatalogPublicationLock(
          async () => assert.fail("overlapping publication entered its transaction"),
          {
            stateDir,
            waitMs: 150,
            retryMs: 25,
            staleMs: 2_000,
            heartbeatMs: 1_000,
          },
        ),
        (error) => {
          assert.equal(error.code, "catalog_publication_locked");
          assert.match(error.message, /Wait for that router command to finish, then retry/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 1_500, "lock wait was not bounded");

      const [code, signal] = await once(child, "exit");
      assert.equal(signal, null);
      assert.equal(code, 0, childStderr);
      assert.equal(
        await withCatalogPublicationLock(async () => "released", {
          stateDir,
          waitMs: 200,
          retryMs: 25,
          staleMs: 2_000,
          heartbeatMs: 1_000,
        }),
        "released",
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, "exit").catch(() => {});
      }
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

test("catalog publication lock recovers stale owners", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-stale-"));
  const lockDirectory = `${catalogPublicationLockTarget(stateDir)}.lock`;
  mkdirSync(lockDirectory);
  const abandonedAt = new Date(Date.now() - 10_000);
  utimesSync(lockDirectory, abandonedAt, abandonedAt);

  try {
    assert.equal(
      await withCatalogPublicationLock(async () => "recovered", {
        stateDir,
        waitMs: 200,
        retryMs: 25,
        staleMs: 2_000,
        heartbeatMs: 1_000,
      }),
      "recovered",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("catalog publication lock releases after failure without losing rollback safety", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-failure-"));
  const publicationError = new Error("publication failed after rollback");
  publicationError.catalogRollbackSafe = true;

  try {
    await assert.rejects(
      withCatalogPublicationLock(
        async () => {
          throw publicationError;
        },
        { stateDir, waitMs: 200, retryMs: 25 },
      ),
      (error) => {
        assert.equal(error, publicationError);
        assert.equal(error.catalogRollbackSafe, true);
        return true;
      },
    );
    assert.equal(
      await withCatalogPublicationLock(async () => "after failure", {
        stateDir,
        waitMs: 200,
        retryMs: 25,
      }),
      "after failure",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("catalog publication lock issues an unforgeable, state-bound reentrant context", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-catalog-context-"));
  try {
    assert.throws(() => assertCatalogPublicationLockHeld({}), /forged|alreadyLocked|context/i);
    await withCatalogPublicationLock(async (context) => {
      assert.equal(assertCatalogPublicationLockHeld(context, stateDir), context);
      assert.throws(() => assertCatalogPublicationLockHeld(context, `${stateDir}-other`), /bound|state/i);
    }, { stateDir, waitMs: 200, retryMs: 25 });
    // The capability expires with the release; an operation cannot cache it
    // and use it as an arbitrary future lock bypass.
    let expired;
    await withCatalogPublicationLock(async (context) => { expired = context; }, { stateDir, waitMs: 200, retryMs: 25 });
    assert.throws(() => assertCatalogPublicationLockHeld(expired, stateDir), /forged|alreadyLocked|context/i);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("model-overlay lock issues an unforgeable, state-bound capability that expires on release", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-overlay-context-"));
  try {
    assert.throws(() => assertModelOverlayLockHeld({}), /forged|alreadyLocked|context/i);
    let expired;
    await withModelOverlayLock(async (context) => {
      expired = context;
      assert.equal(assertModelOverlayLockHeld(context, stateDir), context);
      assert.throws(() => assertModelOverlayLockHeld(context, `${stateDir}-other`), /bound|state/i);
    }, { stateDir, waitMs: 200, retryMs: 25 });
    assert.throws(() => assertModelOverlayLockHeld(expired, stateDir), /forged|alreadyLocked|context/i);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("overlay-to-catalog callers serialize without AB/BA deadlock and permit reentrant catalog work", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-lock-order-"));
  const events = [];
  const transaction = (name) => withModelOverlayLock(
    () => withCatalogPublicationLock(async (context) => {
      events.push(`${name}:catalog`);
      assert.equal(assertCatalogPublicationLockHeld(context, stateDir), context);
      await delay(15);
    }, { stateDir, waitMs: 1_000, retryMs: 5, staleMs: 2_000, heartbeatMs: 1_000 }),
    { stateDir, waitMs: 1_000, retryMs: 5, staleMs: 2_000, heartbeatMs: 1_000 },
  );
  try {
    await Promise.race([
      Promise.all([transaction("mutation"), transaction("migration")]),
      delay(2_000).then(() => { throw new Error("AB/BA lock-order timeout"); }),
    ]);
    assert.deepEqual(events.sort(), ["migration:catalog", "mutation:catalog"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("catalog CLI entrypoint wraps main in the publication lock", () => {
  const source = readFileSync(path.join(root, "src", "catalog.mjs"), "utf8");
  assert.match(
    source,
    /import \{ withCatalogPublicationLock \} from "\.\/catalog-publication-lock\.mjs";/,
  );
  assert.match(
    source,
    /if \(process\.argv\[1\][\s\S]*?await withCatalogPublicationLock\(main\);/,
  );
});
