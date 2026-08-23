import assert from "node:assert/strict";
import test from "node:test";

import * as desktopCommands from "../src/desktop-commands.mjs";

test("canonical desktop definitions are read-only and credential scoped", () => {
  const definitions = desktopCommands.desktopCommandDefinitions();
  assert.ok(definitions.has("credential.set"));
  assert.equal(definitions.get("credential.set").protectedInput, true);
  assert.throws(() => definitions.set("unexpected", {}), /read-only/);
  assert.equal(definitions.has("signed-routing.enable"), false);
  assert.equal(definitions.has("local-chat.enable"), false);
});

test("the retired legacy command table is absent instead of offering setup and local chat aliases", () => {
  assert.equal(Object.hasOwn(desktopCommands, "COMMANDS"), false);
  for (const name of ["provider_setup", "local_models", "set_signed_routing", "set_login_free"]) {
    assert.equal(desktopCommands.desktopCommandDefinitions().has(name), false, name);
  }
});

test("canonical mappings preserve the control CLI contract", () => {
  const definitions = desktopCommands.desktopCommandDefinitions();
  assert.deepEqual(definitions.get("provider.enable").execute({ provider: "deepseek", enabled: true }), [
    "set-apply", "deepseek", "on", "--targets", "codex", "--activate",
  ]);
  assert.deepEqual(definitions.get("presence.mode").execute({ mode: "follow-codex" }), [
    "presence", "set", "follow-codex",
  ]);
  assert.deepEqual(definitions.get("vision.engine").execute({ engine: "gpt-5.6-luna", effort: "low" }), [
    "vision-bridge", "engine", "gpt-5.6-luna", "low",
  ]);
  assert.deepEqual(definitions.get("doctor.fix").execute({}), ["doctor", "--fix", "--json"]);
});
