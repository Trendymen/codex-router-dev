import path from "node:path";

// The only shipped companion is the Swift menu-bar application on macOS. The
// browser panel is served by the Router and therefore has no binary/install
// decision of its own.
export function trayDecision({ platform, withTray, noTray, guided }) {
  if (noTray || platform !== "darwin") return "skip";
  if (withTray) return "install";
  return guided ? "ask" : "skip";
}

export function trayBundleDir(platform, home) {
  if (platform !== "darwin") return undefined;
  return path.posix.join(home, "Applications", "Model Router.app");
}
