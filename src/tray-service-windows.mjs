import { refuseUnsupportedPlatform } from "./platform-gate.mjs";

// The browser panel is the non-macOS read-only surface. No desktop companion
// task is installed on Windows, so this legacy entrypoint refuses before any
// scheduler or filesystem operation.
if (refuseUnsupportedPlatform("tray-service-windows")) process.exit(2);
throw new Error("The model router tray is available only on macOS.");
