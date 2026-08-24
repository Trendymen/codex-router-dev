import assert from "node:assert/strict";
import test from "node:test";

import { trayBundleDir, trayDecision } from "../src/tray-install.mjs";

test("trayDecision offers the Swift tray only on macOS", () => {
  assert.equal(trayDecision({ platform: "darwin", withTray: true, noTray: false, guided: true }), "install");
  assert.equal(trayDecision({ platform: "darwin", withTray: false, noTray: false, guided: true }), "ask");
  assert.equal(trayDecision({ platform: "linux", withTray: true, noTray: false, guided: true }), "skip");
  assert.equal(trayDecision({ platform: "win32", withTray: true, noTray: false, guided: true }), "skip");
});

test("--no-tray always wins", () => {
  assert.equal(trayDecision({ platform: "darwin", withTray: true, noTray: true, guided: true }), "skip");
});

test("the macOS bundle path is stable and POSIX-shaped on every host", () => {
  assert.equal(trayBundleDir("darwin", "/Users/example"), "/Users/example/Applications/Model Router.app");
  assert.equal(trayBundleDir("linux", "/home/example"), undefined);
});
