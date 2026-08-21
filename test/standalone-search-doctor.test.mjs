import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_CONFIG_SNIPPET,
  standaloneSearchStatus,
} from "../src/standalone-search-doctor.mjs";

test("standalone search requires every explicit Codex gate", () => {
  const status = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
`);

  assert.deepEqual(status, { ok: true, missing: [], snippet: SEARCH_CONFIG_SNIPPET });
});

test("standalone search recognizes commented TOML assignments", () => {
  const status = standaloneSearchStatus(`web_search = "live" # Codex search executor
suppress_unstable_features_warning = true# keep startup quiet

[features]
standalone_web_search = true # required for routed search
`);

  assert.equal(status.ok, true);
  assert.deepEqual(status.missing, []);
});

test("missing standalone search gates return the exact copyable snippet", () => {
  const status = standaloneSearchStatus(`web_search = "live"

[features]
standalone_web_search = false
`);

  assert.deepEqual(status, {
    ok: false,
    missing: ["suppress_unstable_features_warning", "features.standalone_web_search"],
    snippet: `web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
`,
  });
});

test("search status does not write Codex or CC Switch configuration", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/standalone-search-doctor.mjs", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(source, /(?:writeFile|writeFileSync|cc-switch\.db|config-manager)/);
  standaloneSearchStatus("");
});
