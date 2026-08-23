import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Set before the imports below: user-models and provider-selection bind their
// paths at module load, and these tests must never touch the real state.
const stateDir = mkdtempSync(path.join(os.tmpdir(), "lmstudio-panel-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_USER_MODELS = path.join(stateDir, "user-models.json");

const {
  isLmstudioModelEnabled,
  lmstudioServedModels,
  lmstudioSnapshot,
  setLmstudioModelEnabled,
} = await import("../src/lmstudio-models.mjs");
const { readUserModels, writeUserModels, userModelEntry } = await import(
  "../src/user-models.mjs"
);
const { readProviderSelection } = await import("../src/provider-selection.mjs");

function fetchOk(ids) {
  return async () => ({
    ok: true,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
}

const fetchDown = async () => {
  throw new Error("connection refused");
};

test("served models come from the /models endpoint, deduplicated and sorted", async () => {
  const served = await lmstudioServedModels({
    fetchImpl: fetchOk(["zeta", "alpha", "alpha", ""]),
  });
  assert.equal(served.reachable, true);
  assert.match(String(served.baseUrl), /^http:\/\/127\.0\.0\.1:1234/);
  assert.deepEqual(served.models, ["alpha", "zeta"]);
});

test("a server that is off reads as unreachable, not as an error", async () => {
  const served = await lmstudioServedModels({ fetchImpl: fetchDown });
  assert.equal(served.reachable, false);
  assert.deepEqual(served.models, []);
});

test("the snapshot reports served models as Vision-only inventory without chat curation", async () => {
  const userModels = [
    userModelEntry({ providerId: "lmstudio", upstreamId: "alpha", priority: 950 }),
    userModelEntry({ providerId: "lmstudio", upstreamId: "gone-model", priority: 951 }),
    userModelEntry({ providerId: "kimi-api", upstreamId: "other", priority: 100 }),
  ];
  const snapshot = await lmstudioSnapshot({
    fetchImpl: fetchOk(["alpha", "beta"]),
    userModels,
  });
  assert.equal(snapshot.reachable, true);
  assert.equal(snapshot.enabled, 0);
  assert.equal(snapshot.visionOnly, true);
  assert.equal(snapshot.chatEnabled, false);
  assert.deepEqual(snapshot.models, [
    { id: "alpha", enabled: false, served: true },
    { id: "beta", enabled: false, served: true },
  ]);
});

test("an unreachable server reports no chat-curated LM Studio models", async () => {
  const userModels = [
    userModelEntry({ providerId: "lmstudio", upstreamId: "alpha", priority: 950 }),
  ];
  const snapshot = await lmstudioSnapshot({ fetchImpl: fetchDown, userModels });
  assert.equal(snapshot.reachable, false);
  assert.deepEqual(snapshot.models, []);
});

test("checking a model withdraws stale chat overlay without touching other providers", () => {
  writeUserModels([
    userModelEntry({ providerId: "kimi-api", upstreamId: "other", priority: 100 }),
  ]);
  setLmstudioModelEnabled("qwen/qwen3-4b", true);

  const stored = readUserModels();
  const mine = stored.filter((model) => model.provider === "lmstudio");
  assert.deepEqual(mine, []);
  // Other providers' curated entries survive untouched.
  assert.ok(stored.some((model) => model.provider === "kimi-api"));
  assert.equal(isLmstudioModelEnabled("qwen/qwen3-4b"), false);

  setLmstudioModelEnabled("qwen/qwen3-4b", false);
  assert.equal(isLmstudioModelEnabled("qwen/qwen3-4b"), false);
  assert.ok(readUserModels().some((model) => model.provider === "kimi-api"));
  assert.ok(!readProviderSelection().includes("lmstudio"));
  const raw = JSON.parse(readFileSync(process.env.MODEL_ROUTER_USER_MODELS, "utf8"));
  assert.ok(Array.isArray(raw.models));
});

test("a disable/re-enable cycle never creates a chat overlay", () => {
  writeUserModels([]);
  setLmstudioModelEnabled("alpha", true);
  setLmstudioModelEnabled("beta", true);
  setLmstudioModelEnabled("gamma", true);
  setLmstudioModelEnabled("beta", false);
  setLmstudioModelEnabled("beta", true);
  const mine = readUserModels().filter((model) => model.provider === "lmstudio");
  assert.deepEqual(mine, []);
});

test("toggling one model leaves no LM Studio chat entries", () => {
  writeUserModels([]);
  setLmstudioModelEnabled("alpha", true);
  setLmstudioModelEnabled("beta", true);
  setLmstudioModelEnabled("alpha", false);
  const mine = readUserModels().filter((model) => model.provider === "lmstudio");
  assert.deepEqual(mine, []);
  assert.ok(!readProviderSelection().includes("lmstudio"));
});
