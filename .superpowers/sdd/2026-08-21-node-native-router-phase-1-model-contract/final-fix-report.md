# Phase 1 final fix wave report

Base `b003c60`; work completed directly on `main`, with no worktree or branch
switch. No live API, DeepSeek/Ali configuration, CC Switch, or non-Router
`CODEX_HOME` was accessed.

## Findings and RED/GREEN evidence

1. **Native routed catalog and snippet default**
   - Files: `src/catalog-generation.mjs`, `src/catalog-rebuild.mjs`,
     `src/cc-switch-snippet.mjs`, `test/catalog.test.mjs`,
     `test/catalog-rebuild.test.mjs`, `test/cc-switch-snippet.test.mjs`.
   - RED: a native-plus-routed regression initially omitted `gpt-native` from
     `buildRoutedCatalog()`.
   - GREEN: stable native models are normalized first, Node models append in
     deterministic priority/slug order, duplicates are removed, booleans and
     instruction contracts are normalized. Rebuild publishes this complete
     catalog without duplicating native models. The aggregate snippet omits an
     unprovable hard-coded default model.

2. **Six-artifact validation and pointer authority**
   - Files: `src/catalog-generation.mjs`, `test/catalog-generation.test.mjs`.
   - RED: malformed route/UI bytes were accepted; regular-file, directory,
     outside-link and incomplete-generation `current` states were not all
     rejected.
   - GREEN: strict versioned route/UI schemas validate before staging writes;
     malformed each-kind publications retain the old complete bytes. Only
     `ENOENT` is treated as absent `current`; every existing authority must be
     an in-tree symlink to a complete six-file generation.

3. **Registry proof invalidation**
   - Files: `src/model-contract.mjs`, `src/node-snapshot-triggers.mjs`,
     `src/protocol-proof.mjs`, `test/protocol-proof.test.mjs`.
   - RED: registry invalidation examined only supplied/routable slugs, leaving
     removed entries and verifier-version-stale proofs behind.
   - GREEN: real registry-update consumes the full normative Node set. One
     transaction removes deleted, fingerprint-mismatched, and stale-verifier
     proofs; regression asserts exactly one transaction.

4. **External refresh boundary**
   - Files: `src/node-snapshot-triggers.mjs`,
     `test/node-snapshot-triggers.test.mjs`.
   - RED: deferred mutation refreshed external targets; startup did not refresh
     after a successful generation.
   - GREEN: deferred results never refresh. Startup commits first, refreshes
     with `rebuildCodex:false`, and propagates refresh errors so the next
     startup/observer attempt can retry.

5. **Bootstrap rollback and durability**
   - Files: `src/catalog-generation.mjs`,
     `test/catalog-generation.test.mjs`.
   - GREEN: rollback restores the bootstrap-old `current` pointer and syncs its
     parent before restoring stable legacy paths. Legacy restores use temporary
     private files, file fsync, atomic rename, and parent fsync; all pointer,
     staging, generation and temporary removals fsync the affected parent.
     Cleanup failures aggregate with the operation failure rather than claiming
     success. Existing ordinal fault matrices remain green.

## Verification

- RED command: `node --test test/catalog.test.mjs test/catalog-generation.test.mjs test/node-snapshot-triggers.test.mjs` produced the expected native omission, malformed snapshot acceptance, incomplete-current acceptance, and deferred-refresh failures before the corresponding fixes.
- Focused GREEN: `node --test test/protocol-proof.test.mjs test/catalog-rebuild.test.mjs test/cc-switch-snippet.test.mjs` — 34 pass, 0 fail.
- Phase focused: `node --test test/model-contract.test.mjs test/protocol-proof.test.mjs test/protocol-proof-verifier.test.mjs test/catalog.test.mjs test/catalog-generation.test.mjs test/catalog-rebuild.test.mjs test/catalog-publication-lock.test.mjs test/refresh-catalog.test.mjs test/node-snapshot-triggers.test.mjs test/node-snapshot-mutation-wiring.test.mjs test/cc-switch-snippet.test.mjs test/standalone-search-doctor.test.mjs` — 177 pass, 0 fail.
- `npm run check` — `syntax checks passed`.
- Full: `npm test` — 2051 tests, 2020 pass, 0 fail, 31 skip; exit 0.
- `git diff --check` — exit 0.

## Self-review and residual risk

- The intentionally deferred exact protocol-proof argv and snapshot-shaping/
  static-cycle Minors were not expanded.
- Production still fails closed on Windows without symbolic-link authority;
  test-only filesystem seams retain the ordered publication coverage.
