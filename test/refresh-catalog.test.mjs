import assert from "node:assert/strict";
import test from "node:test";

import { refreshCatalog } from "../src/refresh-catalog.mjs";

function recordingRunner({ signed = true, failAt } = {}) {
  const calls = [];
  return {
    calls,
    run(script, args) {
      calls.push([script, args]);
      const index = calls.length;
      if (index === failAt) {
        return { status: 75, stdout: "", stderr: "forced catalog failure" };
      }
      if (script === "config-manager.mjs" && args[0] === "status") {
        return {
          status: 0,
          stdout: `${JSON.stringify({ mode: "router", signed_routing: signed })}\n`,
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: script === "catalog.mjs" ? '{"models":1}\n' : "",
        stderr: "",
      };
    },
  };
}

test("refresh orchestration leaves the client document alone and republishes the routed catalog", () => {
  const runner = recordingRunner();
  const result = refreshCatalog({ run: runner.run });
  assert.deepEqual(runner.calls, [
    ["catalog.mjs", ["--refresh-native"]],
    ["node-snapshot-triggers.mjs", ["registry-update"]],
  ]);
  assert.equal(result.catalogOutput, '{"models":1}\n');
});

test("refresh orchestration leaves the client document alone after catalog failure", () => {
  const runner = recordingRunner({ failAt: 1 });
  assert.throws(
    () => refreshCatalog({ run: runner.run }),
    /catalog\.mjs exited with status 75.*forced catalog failure/s,
  );
  assert.deepEqual(runner.calls, [
    ["catalog.mjs", ["--refresh-native"]],
  ]);
});

test("ordinary routed refresh also republishes external models", () => {
  const runner = recordingRunner({ signed: false });
  refreshCatalog({ run: runner.run });
  assert.deepEqual(runner.calls, [
    ["catalog.mjs", ["--refresh-native"]],
    ["node-snapshot-triggers.mjs", ["registry-update"]],
  ]);
});
