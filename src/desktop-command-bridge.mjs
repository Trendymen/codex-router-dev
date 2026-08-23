#!/usr/bin/env node

// Thin stdin/stdout bridge for native companions. The companion sends one JSON
// envelope and receives the same {ok,value}|{ok:false,error} envelope exposed
// to the browser and Electron surfaces. Credential bytes are a separate,
// one-shot field and never become command arguments or router state.
import { sourceRoot, runDesktopCommand, trustedProtectedContext } from "./desktop-commands.mjs";

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
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
  const protectedInput = request && typeof request === "object" && typeof request.protectedInput === "string"
    ? request.protectedInput
    : undefined;
  const context = trustedProtectedContext({
    root: sourceRoot(),
    ...(protectedInput ? { protectedInput: async () => protectedInput } : {}),
  });
  try {
    const result = await runDesktopCommand(command, args, context);
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stdout.write(JSON.stringify(failure("invalid_command_arguments", "The desktop command arguments are invalid.")));
    process.exitCode = 2;
  }
}
