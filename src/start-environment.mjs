/** Keep the acceptance-only catalog override explicit without changing the production default. */
export function routerCatalogPath(environment, mergedCatalogPath) {
  return environment?.CODEX_ROUTER_CATALOG || mergedCatalogPath;
}
