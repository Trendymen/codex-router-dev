import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DNS_LABEL = "[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const LABEL_PATTERN = new RegExp(`^(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`);

export function setBundleIdentifier(plist, identifier) {
  if (typeof identifier !== "string" || identifier.length > 253 || !LABEL_PATTERN.test(identifier)) {
    throw new Error("Tray bundle identifier must be a strict reverse-DNS label.");
  }
  const pattern = /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/;
  if (!pattern.test(String(plist))) throw new Error("Tray Info.plist has no CFBundleIdentifier.");
  return String(plist).replace(pattern, `$1${identifier}$2`);
}
export function rewriteBundleIdentifier(plistPath, identifier) {
  const rewritten = setBundleIdentifier(readFileSync(plistPath, "utf8"), identifier);
  writeFileSync(plistPath, rewritten, "utf8");
  return plistPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== "set-identifier" || !process.argv[3] || !process.argv[4]) {
      throw new Error("Usage: tray-bundle.mjs set-identifier INFO_PLIST LABEL");
    }
    rewriteBundleIdentifier(process.argv[3], process.argv[4]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
