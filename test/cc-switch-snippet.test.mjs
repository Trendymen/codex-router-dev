import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregateSnippetStatus,
  renderAggregateSnippet,
} from "../src/cc-switch-snippet.mjs";

const capability =
  "http://127.0.0.1:46192/_codex-router/caller-capability-decoy-with-sufficient-length/v1";
const redactedCapability =
  "http://127.0.0.1:46192/_codex-router/[REDACTED]/v1";
const routedCatalogPath = "/private/router-state/routed-models.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("authenticated aggregate snippet is deterministic and usable", () => {
  const fixture = { routedCatalogPath, callerBaseUrl: capability };
  const first = renderAggregateSnippet(fixture);

  assert.equal(first, renderAggregateSnippet(fixture));
  assert.match(first, /routed-models\.json/);
  assert.match(first, /_codex-router\/[^/]+\/v1/);
  assert.match(first, /model_provider = "custom"/);
  assert.match(first, /supports_standalone_web_search = true/);
  assert.match(first, /wire_api = "responses"/);
});

test("aggregate status is redacted and contains no protected snippet", () => {
  const status = aggregateSnippetStatus({
    routedCatalogPath,
    redactedBaseUrl: redactedCapability,
  });
  const serialized = JSON.stringify(status);

  assert.deepEqual(status, {
    modelCatalogJson: routedCatalogPath,
    baseUrl: redactedCapability,
    supportsStandaloneWebSearch: true,
  });
  assert.doesNotMatch(serialized, /caller-capability-decoy-with-sufficient-length/);
  assert.doesNotMatch(serialized, /model_provider/);
});

test("aggregate status rejects an unredacted caller capability", () => {
  assert.throws(
    () => aggregateSnippetStatus({ routedCatalogPath, redactedBaseUrl: capability }),
    /redactedBaseUrl must not contain a caller capability/,
  );
});

test("pure snippet and status surfaces do not carry filesystem or configuration writers", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/cc-switch-snippet.mjs", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(source, /(?:writeFile|writeFileSync|cc-switch\.db|config-manager)/);
});

test("catalog status is redacted while the local render command alone returns the snippet", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-snippet-"));
  const stateDir = path.join(codexHome, "router-state");
  const decoyDatabase = path.join(codexHome, ".cc-switch", "cc-switch.db");
  const secret = "catalog-command-capability-decoy-with-sufficient-length";
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_STATE_DIR: stateDir,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_PORT: "46192",
  };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(decoyDatabase), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${secret}\n`, { mode: 0o600 });
  writeFileSync(path.join(codexHome, "config.toml"), "", { mode: 0o600 });
  writeFileSync(decoyDatabase, "do-not-touch", { mode: 0o600 });

  try {
    const status = spawnSync(process.execPath, ["src/control.mjs", "catalog", "status"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, new RegExp(secret));
    assert.match(status.stdout, /\[REDACTED\]/);
    assert.equal(readFileSync(decoyDatabase, "utf8"), "do-not-touch");

    const rendered = spawnSync(process.execPath, ["src/control.mjs", "catalog", "render-snippet"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, new RegExp(secret));
    assert.match(rendered.stdout, /routed-models\.json/);
    assert.equal(readFileSync(decoyDatabase, "utf8"), "do-not-touch");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
