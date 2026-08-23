// Thin stdin/stdout bridge for native companions. The companion sends one JSON
// envelope and receives the same {ok,value}|{ok:false,error} envelope exposed
// to the browser and Electron surfaces. Credential bytes are a separate,
// one-shot field and never become command arguments or router state.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceRoot, runDesktopCommand, trustedProtectedContext } from "./desktop-commands.mjs";

const MAX_STDIN_BYTES = 256 * 1024;
const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_STDIN_BYTES) {
        process.stdin.destroy(new Error("input limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function failure(code, message) {
  return {
    ok: false,
    error: {
      type: "router_error",
      code,
      message,
      param: null,
    },
  };
}

const command = process.argv[2];
let request;
try {
  request = JSON.parse((await readStdin()) || "{}");
} catch {
  process.stdout.write(JSON.stringify(failure("invalid_command_arguments", "The desktop command arguments are invalid.")));
  process.exitCode = 2;
}

if (process.exitCode !== 2) {
  const args = request && typeof request === "object" && request.args && typeof request.args === "object"
    ? request.args
    : {};
  let protectedInput = request && typeof request === "object" && typeof request.protectedInput === "string"
    ? request.protectedInput
    : undefined;
  const suppliedVersion = request && typeof request === "object" && Object.hasOwn(request, "capabilitySchemaVersion")
    ? request.capabilitySchemaVersion
    : undefined;
  const hasVersion = Boolean(request && typeof request === "object" && Object.hasOwn(request, "capabilitySchemaVersion"));
  const context = trustedProtectedContext({
    // Ignore all environment/source-root redirects. The native app seals the
    // checkout in its bundle; this helper resolves its own root from import.meta.
    root: sourceRoot(Object.create(null), BRIDGE_ROOT),
    ...(hasVersion
      ? { manifest: { capabilitySchemaVersion: suppliedVersion } }
      : {}),
    ...(protectedInput ? { protectedInput: async () => protectedInput } : {}),
  });
  try {
    const result = await runDesktopCommand(command, args, context);
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write(JSON.stringify(failure("invalid_command_arguments", "The desktop command arguments are invalid.")));
    process.exitCode = 2;
  } finally {
    if (request && typeof request === "object") request.protectedInput = undefined;
    protectedInput = undefined;
    request = undefined;
  }
}
