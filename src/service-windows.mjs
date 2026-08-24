import { refuseUnsupportedPlatform } from "./platform-gate.mjs";

// Windows is intentionally outside the shipped runtime. Keep this entrypoint
// as a deterministic compatibility shim; it must not create Task Scheduler
// entries or launch a Windows executable.
if (refuseUnsupportedPlatform("service-windows")) process.exit(2);
throw new Error("The model router service is available only on macOS.");
