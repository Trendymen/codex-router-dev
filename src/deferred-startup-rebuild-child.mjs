import { rebuildAfterStartup } from "./node-snapshot-triggers.mjs";

try {
  await rebuildAfterStartup();
} catch (error) {
  process.exitCode = error?.code === "catalog_publication_locked" || error?.code === "model_overlay_locked" ? 75 : 1;
}
