import { ERROR_DEFINITIONS } from "./public-error.mjs";

const UNSUPPORTED_PLATFORM = "unsupported_platform";

/**
 * Error raised before a non-macOS public entry can inspect or mutate runtime
 * state.  Keep the public body on the error so both direct callers and CLI
 * boundaries expose the same stable code without leaking platform details.
 */
export class UnsupportedPlatformError extends Error {
  constructor(operation, platform) {
    const definition = ERROR_DEFINITIONS[UNSUPPORTED_PLATFORM];
    super(definition.message);
    this.name = "UnsupportedPlatformError";
    this.code = UNSUPPORTED_PLATFORM;
    this.exitCode = 2;
    this.status = definition.status;
    this.platform = platform;
    Object.defineProperty(this, "body", {
      value: {
        error: {
          type: "router_error",
          code: UNSUPPORTED_PLATFORM,
          message: definition.message,
          param: null,
        },
      },
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(this, "privateDetails", {
      value: Object.freeze({ operation: String(operation || "operation"), platform }),
      enumerable: false,
      writable: false,
    });
  }
}
export function isUnsupportedPlatformError(error) {
  return Boolean(error) && error.code === UNSUPPORTED_PLATFORM && error.exitCode === 2;
}

export function requireMacOS(operation, platform = process.platform) {
  if (platform !== "darwin") throw new UnsupportedPlatformError(operation, platform);
}

/**
 * Injectable production boundary used by mutation owners that need to prove
 * refusal ordering without starting their real service or installer.
 */
export function runMacOSMutation(operation, mutate, { platform = process.platform } = {}) {
  requireMacOS(operation, platform);
  if (typeof mutate !== "function") throw new TypeError("A macOS mutation callback is required.");
  return mutate();
}

export function formatPlatformError(error, prefix = "codex-router") {
  if (isUnsupportedPlatformError(error)) return `${prefix}: ${error.code}`;
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * CLI helper for synchronous entry points. It returns false when execution
 * may continue and writes the one public error plus its required exit code
 * when the host is unsupported.
 */
export function refuseUnsupportedPlatform(operation, platform = process.platform, {
  write = (message) => process.stderr.write(`${message}\n`),
  setExitCode = (code) => { process.exitCode = code; },
} = {}) {
  try {
    requireMacOS(operation, platform);
    return false;
  } catch (error) {
    if (!isUnsupportedPlatformError(error)) throw error;
    write(formatPlatformError(error));
    setExitCode(error.exitCode);
    return true;
  }
}
