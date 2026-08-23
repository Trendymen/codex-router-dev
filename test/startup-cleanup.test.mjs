import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startNodeRuntime } from "../src/node-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class Child extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.exitCode = null;
    this.signalCode = null;
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    this.exitCode = 0;
    this.emit("exit", 0, signal);
    return true;
  }
}

function topology() {
  return {
    forwarders: [
      { name: "oauth", label: "OAuth forwarder", command: "node", args: ["oauth.mjs"] },
      { name: "api", label: "API forwarder", command: "node", args: ["api.mjs"] },
    ],
    router: { name: "router", label: "Router", command: "node", args: ["router.mjs"] },
  };
}

test("startup failure cleans up healthy forwarders and preserves the startup error", async () => {
  const children = [];
  await assert.rejects(
    () => startNodeRuntime({
      ...topology(),
      childFactory: async (spec) => {
        if (spec.name === "router") throw new Error("router cannot bind");
        const child = new Child(spec.name);
        children.push(child);
        return child;
      },
      waitForHealth: async () => {},
    }),
    (error) => error.message === "router cannot bind",
  );
  assert.deepEqual(children.map((child) => child.kills), [["SIGTERM"], ["SIGTERM"]]);
});

test("runtime shutdown stops only its owned children and is idempotent", async () => {
  const children = [];
  const runtime = await startNodeRuntime({
    ...topology(),
    childFactory: async (spec) => {
      const child = new Child(spec.name);
      children.push(child);
      return child;
    },
    waitForHealth: async () => {},
  });
  await runtime.stop("SIGTERM");
  await runtime.stop("SIGKILL");
  assert.deepEqual(children.map((child) => child.kills), [
    ["SIGTERM"],
    ["SIGTERM"],
    ["SIGTERM"],
  ]);
});

test("startup entrypoint has no removed runtime import or port dependency", () => {
  const source = readFileSync(path.join(root, "src", "start.mjs"), "utf8");
  assert.doesNotMatch(source, /gateway-supervisor\.mjs|litellm-config\.mjs|venv-runtime\.mjs/);
  assert.doesNotMatch(source, /LITELLM_CONFIG_PATH|MODEL_ROUTER_GATEWAY_|CODEX_ROUTER_GATEWAY_/);
  assert.doesNotMatch(source, /\.venv|4200|PYTHONIOENCODING|PYTHONUTF8/);
});
