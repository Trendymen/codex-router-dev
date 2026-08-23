import assert from "node:assert/strict";
import test from "node:test";

const { resolveRoutedClientVisionEngine } = await import("../src/routed-client-models.mjs");

test("routed-client publication with a lost native session publishes no reader", () => {
  const native = {
    slug: "gpt-5.6-luna",
    native: true,
    inputModalities: ["text", "image"],
  };
  const settings = { version: 1, enabled: true, engine: native.slug, effort: null, local: null };
  const result = resolveRoutedClientVisionEngine({
    candidates: [native],
    settings,
    context: {
      strict: true,
      callerSession: { usable: false },
      enabledProviders: new Set(),
      credentialedProviders: new Set(),
    },
  });
  assert.equal(result.rejected, true);
  assert.equal(result.engine, undefined);
  assert.equal(result.selection, native.slug);
});

test("routed-client publication treats login-free native state as no reader", () => {
  const result = resolveRoutedClientVisionEngine({
    candidates: [{ slug: "gpt-5.6-luna", native: true, inputModalities: ["text", "image"] }],
    settings: { version: 1, enabled: true, engine: "gpt-5.6-luna", effort: null, local: null },
    context: {
      strict: true,
      callerSession: { usable: false },
      enabledProviders: new Set(),
      credentialedProviders: new Set(),
    },
  });
  assert.deepEqual(
    { rejected: result.rejected, engine: result.engine, code: result.code },
    { rejected: true, engine: undefined, code: "vision_engine_not_supported" },
  );
});
