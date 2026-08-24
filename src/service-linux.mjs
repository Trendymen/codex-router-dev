import { refuseUnsupportedPlatform } from "./platform-gate.mjs";

// Linux is intentionally outside the shipped runtime. Keep this entrypoint as
// a deterministic compatibility shim so an old command fails before it can
// write a unit, spawn a process, or touch a user service.
if (refuseUnsupportedPlatform("service-linux")) process.exit(2);
throw new Error("The model router service is available only on macOS.");
