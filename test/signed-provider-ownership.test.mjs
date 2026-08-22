import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  managedSignedProviderBlock,
  managedSignedProviderBlockLegacy,
  signedProviderSlot,
  signedProviderStateIsOwned,
} from "../src/signed-provider-ownership.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provider = "codex-router-signed";
const baseUrl = "http://127.0.0.1:46192/_codex-router/test-caller-capability/v1";
const context = {
  activeProvider: provider,
  baseUrl,
  signedProviderId: provider,
  isManagedRouterBaseUrl: (value) => value === baseUrl,
};
const ownershipId = "0123456789abcdef0123456789abcdef";

function state(version, mode, previousProviderSections = []) {
  return { version, mode, managedProvider: provider, managedBaseUrl: baseUrl, ownershipId, previousProviderSections };
}

test("signed ownership accepts the positive V1/V2/V3 root-openai and provider-table matrix", () => {
  assert.equal(signedProviderStateIsOwned("model_provider = \"codex-router-signed\"\n", { version: 1, managedProvider: provider }, context), true);

  assert.equal(signedProviderStateIsOwned('model_provider = "codex-router-signed"\nopenai_base_url = "' + baseUrl + '"\n', state(2, "root-openai"), context), true);
  assert.equal(signedProviderStateIsOwned(`model_provider = "${provider}"\n${managedSignedProviderBlock(provider, baseUrl)}\n`, state(2, "provider-table"), context), true);

  assert.equal(signedProviderStateIsOwned(`model_provider = "${provider}"\nopenai_base_url = "${baseUrl}"\n`, state(3, "root-openai"), context), true);
  assert.equal(signedProviderStateIsOwned(`model_provider = "${provider}"\n${signedProviderSlot(state(3, "provider-table", ["foreign"]), 0)}\n${managedSignedProviderBlock(provider, baseUrl)}\n`, state(3, "provider-table", ["foreign"]), context), true);
});

test("signed ownership handles V2 current and legacy blocks but fails modified blocks", () => {
  const current = managedSignedProviderBlock(provider, baseUrl);
  const legacy = managedSignedProviderBlockLegacy(provider, baseUrl);
  const signedState = state(2, "provider-table");
  for (const block of [current, legacy]) {
    assert.equal(signedProviderStateIsOwned(`model_provider = "${provider}"\n${block}\n`, signedState, context), true);
  }
  assert.equal(signedProviderStateIsOwned(`model_provider = "${provider}"\n${current.replace('wire_api = "responses"', 'wire_api = "chat"')}\n`, signedState, context), false);
});

test("signed V3 ownership fails closed on slots, provider-tree drift, duplicate ranges, and non-adjacent placement", () => {
  const signedState = state(3, "provider-table", ["foreign"]);
  const slot = signedProviderSlot(signedState, 0);
  const block = managedSignedProviderBlock(provider, baseUrl);
  const cases = [
    `${slot.replace(/ 0$/, " 9")}\n${block}`,
    `${slot}\n${block}\n[model_providers.${provider}.drift]\nname = "foreign"`,
    `${slot}\n${block}\n[model_providers.${provider}]\nname = "duplicate"`,
    `${slot}\n# drifted between slot and managed block\n${block}`,
  ];
  for (const contents of cases) {
    assert.equal(signedProviderStateIsOwned(`model_provider = "${provider}"\n${contents}\n`, signedState, context), false, contents);
  }
});

test("doctor status and config-manager defer ownership decisions to the same shared implementation", () => {
  const statusSource = readFileSync(path.join(root, "src", "codex-config-status.mjs"), "utf8");
  const managerSource = readFileSync(path.join(root, "src", "config-manager.mjs"), "utf8");
  assert.match(statusSource, /import \{ signedProviderStateIsOwned \} from "\.\/signed-provider-ownership\.mjs"/);
  assert.match(statusSource, /signedProviderStateIsOwned\(contents, signedState,/);
  assert.match(managerSource, /from "\.\/signed-provider-ownership\.mjs"/);
  assert.match(managerSource, /sharedSignedProviderStateIsOwned\(contents, state,/);
  assert.doesNotMatch(managerSource, /legacy implementation retained below/);
});
