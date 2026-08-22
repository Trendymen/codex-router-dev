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

test("standalone search honors decoded quoted root and features table keys", () => {
  const status = standaloneSearchStatus(`"web_search" = "live"
"suppress_unstable_features_warning" = true

["features"]
"standalone_web_search" = true
`);

  assert.equal(status.ok, true);
  assert.deepEqual(status.missing, []);
});

test("standalone search fails closed on duplicate or multiline TOML structures", () => {
  const invalidDocuments = [
    `web_search = "live"
web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
`,
    `notes = """
web_search = "live"
suppress_unstable_features_warning = true
[features]
standalone_web_search = true
"""
`,
    `web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true

[features]
`,
    `web_search = "live"
suppress_unstable_features_warning = true
features.standalone_web_search = true

[features]
standalone_web_search = true
`,
  ];

  for (const document of invalidDocuments) {
    const status = standaloneSearchStatus(document);
    assert.equal(status.ok, false);
    assert.match(status.invalid || "", /duplicate|multiline/i);
  }
});

test("standalone search treats a dotted features key as the same configuration path", () => {
  const status = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true
features.standalone_web_search = true
`);

  assert.equal(status.ok, true);
  assert.deepEqual(status.missing, []);
});

test("standalone search fails closed on an unrecognized active TOML line", () => {
  const status = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true

[features]
standalone_web_search = true
this is not TOML
`);

  assert.equal(status.ok, false);
  assert.match(status.invalid || "", /unrecognized active TOML content/i);
});

test("standalone search validates unrelated TOML other values without rejecting legal scalar and container forms", () => {
  const valid = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true
integer = 1_000
float = -3.14_15
exponent = 6.02e+2_3
infinity = +inf
not_a_number = -nan
hex = 0xdead_beef
octal = 0o7_5_5
binary = 0b1010_0101
offset_date_time = 1979-05-27T07:32:00.999999-07:00
local_date_time = 1979-05-27 07:32:00
local_date = 1979-05-27
local_time = 07:32:00.123
array = [1, "quoted, # value", { nested = [true, 0x10] },]
multiline_array = [
  1,
  { nested = ["quoted] value", 0x10] },
]
inline = { quoted = { "nested.key" = [1, 2] }, enabled = false }

[features]
standalone_web_search = true
`);
  assert.equal(valid.ok, true, valid.invalid);

  for (const value of ["@@@", "???", "1__0", "0x", "2025-13-40", "[1,", "{ answer = 42", "{ answer 42 }"]) {
    const status = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true
unrelated = ${value}

[features]
standalone_web_search = true
`);
    assert.equal(status.ok, false, value);
    assert.match(status.invalid || "", /untrusted TOML value|ambiguous/i, value);
  }
});

test("standalone search rejects duplicate and colliding decoded inline-table paths", () => {
  for (const value of [
    "{ a = 1, a = 2 }",
    "{ a.b = 1, a = { b = 2 } }",
    "{ a = { b = 1 }, a.b = 2 }",
  ]) {
    const status = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true
unrelated = ${value}

[features]
standalone_web_search = true
`);
    assert.equal(status.ok, false, value);
    assert.match(status.invalid || "", /untrusted TOML value|ambiguous/i, value);
  }
});

test("standalone search rejects colliding document assignment paths like inline tables", () => {
  const status = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true
unrelated = 1
unrelated.child = 2

[features]
standalone_web_search = true
`);

  assert.equal(status.ok, false);
  assert.match(status.invalid || "", /colliding TOML assignment paths/i);
});

test("standalone search enforces TOML integer bounds and forbids signs on base integers", () => {
  const valid = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true
decimal_max = +9_223_372_036_854_775_807
decimal_min = -9_223_372_036_854_775_808
hex_max = 0x7fff_ffff_ffff_ffff
octal_max = 0o777_777_777_777_777_777_777
binary_max = 0b111_111_111_111_111_111_111_111_111_111_111_111_111_111_111_111_111_111_111_111_111

[features]
standalone_web_search = true
`);
  assert.equal(valid.ok, true, valid.invalid);

  for (const value of [
    "+9_223_372_036_854_775_808",
    "-9_223_372_036_854_775_809",
    "0x8000_0000_0000_0000",
    "0o1_000_000_000_000_000_000_000",
    "0b1_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000_000",
    "+0x1",
    "-0x1",
    "+0o1",
    "-0o1",
    "+0b1",
    "-0b1",
  ]) {
    const status = standaloneSearchStatus(`web_search = "live"
suppress_unstable_features_warning = true
unrelated = ${value}

[features]
standalone_web_search = true
`);
    assert.equal(status.ok, false, value);
    assert.match(status.invalid || "", /untrusted TOML value|ambiguous/i, value);
  }
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
