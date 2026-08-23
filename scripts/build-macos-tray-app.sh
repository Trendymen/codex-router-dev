#!/bin/sh
set -eu

if [ "$(/usr/bin/uname -s 2>/dev/null || printf unknown)" != "Darwin" ]; then
  printf 'codex-router: unsupported_platform\n' >&2
  exit 2
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
tray_dir="$repo_dir/apps/macos/ModelRouterTray"
# One companion per user, not one per checkout. A default inside the
# repository built a separate bundle for every clone and left launchd pointing
# at whichever one installed last; ~/Applications is also a LaunchServices
# location, so the app resolves by name and can be found and quit normally.
# The Node target owns the default bundle path. An explicit argument is used by
# the staged replacement path; a no-argument invocation resolves the same
# validated ServiceTarget instead of rebuilding a production path locally.
if [ "$#" -gt 0 ]; then
  bundle_dir=$1
else
  bundle_dir=$(node --input-type=module -e '
    import { currentServiceTarget } from "./src/paths.mjs";
    process.stdout.write(currentServiceTarget().appPath);
  ')
fi
target_parent=$(dirname "$(node --input-type=module -e '
  import { currentServiceTarget } from "./src/paths.mjs";
  process.stdout.write(currentServiceTarget().appPath);
')")
case "$bundle_dir" in
  "$target_parent"/*) ;;
  *)
    printf 'codex-router: tray bundle staging path is outside the resolved ServiceTarget.\n' >&2
    exit 2
    ;;
esac
tray_label=$(node --input-type=module -e '
  import { currentServiceTarget } from "./src/paths.mjs";
  process.stdout.write(currentServiceTarget().trayLabel);
')
if [ "${MODEL_ROUTER_TRAY_DRY_RUN:-0}" = "1" ] && [ "${MODEL_ROUTER_SERVICE_MODE:-${CODEX_ROUTER_SERVICE_MODE:-production}}" != "production" ]; then
  printf '%s|%s\n' "$bundle_dir" "$tray_label"
  exit 0
fi
configuration=${MODEL_ROUTER_TRAY_CONFIGURATION:-release}
binary_dir="$tray_dir/.build/$configuration"

# Callers capture this script's stdout as the bundle path, so compiler
# progress must not land there.
swift build -c "$configuration" --package-path "$tray_dir" 1>&2
mkdir -p "$bundle_dir/Contents/MacOS" "$bundle_dir/Contents/Resources"
cp "$binary_dir/ModelRouterTray" "$bundle_dir/Contents/MacOS/ModelRouterTray"
cp "$tray_dir/Resources/Info.plist" "$bundle_dir/Contents/Info.plist"
node "$repo_dir/src/tray-bundle.mjs" set-identifier "$bundle_dir/Contents/Info.plist" "$tray_label"
# The icon is committed as a built .icns, not rasterized here: scripts/build-app-icon.sh
# needs sips and iconutil, and a tray build must not start depending on them.
# Without this file the bundle falls back to the generic macOS app icon, which
# is what made Model Router unfindable in Finder, Launchpad, and Spotlight.
if [ -f "$tray_dir/Resources/AppIcon.icns" ]; then
  cp "$tray_dir/Resources/AppIcon.icns" "$bundle_dir/Contents/Resources/AppIcon.icns"
else
  printf 'codex-router: AppIcon.icns is missing; run scripts/build-app-icon.sh.\n' >&2
fi
if [ -d "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" ]; then
  rm -rf "$bundle_dir/Contents/Resources/ModelRouterTray_ModelRouterTray.bundle" \
    "$bundle_dir/ModelRouterTray_ModelRouterTray.bundle"
  cp -R "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" "$bundle_dir/Contents/Resources/"
fi
# Seal the checkout relationship into Info.plist itself. An external symlink is
# invalid inside a strict macOS code-signed bundle; a loose text resource would
# be executable-path input. This value is covered by the final signature, so
# changing the selected checkout also invalidates verification.
/usr/libexec/PlistBuddy -c "Add :ModelRouterSourceRoot string $repo_dir" \
  "$bundle_dir/Contents/Info.plist"

# The copied SwiftPM executable carries an ad-hoc signature. Sign only after
# every executable, resource, and link is in its final location; mutating the
# live signed bundle is what produced taskgated "Invalid Page" terminations.
/usr/bin/codesign --force --deep --sign - "$bundle_dir"
/usr/bin/codesign --verify --deep --strict "$bundle_dir"

printf '%s\n' "$bundle_dir"
