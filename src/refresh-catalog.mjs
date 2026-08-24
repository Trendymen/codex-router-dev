import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";

function nodeRunner(script, args) {
  return spawnSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
  });
}

function checked(run, script, args) {
  const result = run(script, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${script} exited with status ${result.status ?? "unknown"}` +
        `${result.stderr ? `: ${result.stderr.trim()}` : "."}`,
    );
  }
  return result;
}

export function refreshCatalog({ run = nodeRunner } = {}) {
  // Catalog construction is now independent of the Codex client document. It
  // reads that document when it needs a native model hint, but never disables or
  // re-enables a client transport just to refresh Router-owned state.
  const catalogResult = checked(run, "catalog.mjs", ["--refresh-native"]);
  // Catalog capture established the base merged/native template. Completing
  // refresh now invalidates stale contract proofs and republishes one unified
  // Node generation; the trigger itself makes no provider request.
  checked(run, "node-snapshot-triggers.mjs", ["registry-update"]);
  return { catalogOutput: catalogResult.stdout || "" };
}

function main() {
  const { catalogOutput } = refreshCatalog();
  if (catalogOutput) process.stdout.write(catalogOutput);
  process.stdout.write("Native and external model catalogs refreshed. Fully quit and reopen Codex.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
