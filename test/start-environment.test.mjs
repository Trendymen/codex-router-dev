import assert from "node:assert/strict";
import test from "node:test";

import { routerCatalogPath } from "../src/start-environment.mjs";

test("startup catalog selection preserves an explicit isolated override", () => {
  assert.equal(routerCatalogPath({ CODEX_ROUTER_CATALOG: "/private/acceptance-catalog.json" }, "/private/merged-models.json"), "/private/acceptance-catalog.json");
});

test("startup catalog selection defaults production to the merged catalog", () => {
  assert.equal(routerCatalogPath({}, "/private/merged-models.json"), "/private/merged-models.json");
});
