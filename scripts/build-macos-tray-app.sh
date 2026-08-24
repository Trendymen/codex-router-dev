#!/bin/sh
set -eu

# Mock build/signing tools are selected only after the real host passes this
# fixed platform gate.
uname_bin=/usr/bin/uname
if [ "$($uname_bin -s 2>/dev/null || printf unknown)" != "Darwin" ]; then
  printf 'codex-router: unsupported_platform\n' >&2
  exit 2
fi

bundle_dir=
fixture_context=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fixture-context)
      [ "$#" -ge 2 ] || { printf 'codex-router: --fixture-context requires a path.\n' >&2; exit 2; }
      fixture_context=$2
      shift 2
      ;;
    *)
      if [ -n "$bundle_dir" ]; then
        printf 'codex-router: tray build accepts one bundle path.\n' >&2
        exit 2
      fi
      bundle_dir=$1
      shift
      ;;
  esac
done

# Production uses the platform tools shipped by macOS. MODEL_ROUTER_* tool,
# platform, and build-only variables are intentionally ignored here. Fixture
# tools can be selected only by an explicit context emitted for a validated
# acceptance/test ServiceTarget.
if [ -z "$fixture_context" ]; then
  codesign_bin=/usr/bin/codesign
  plistbuddy_bin=/usr/libexec/PlistBuddy
  swift_bin=swift
  repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
  context_mode=production
else
  repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
  context_field() {
    node "$repo_dir/src/tray-build-plan.mjs" --fixture-field "$fixture_context" "$1"
  }
  context_mode=$(context_field mode)
  case "$context_mode" in
    acceptance|test) ;;
    *) printf 'codex-router: invalid Tray fixture mode.\n' >&2; exit 2 ;;
  esac
  swift_bin=$(context_field tools.swift)
  codesign_bin=$(context_field tools.codesign)
  plistbuddy_bin=$(context_field tools.plistBuddy)
fi
cd "$repo_dir"

target_field() {
  if [ -n "$fixture_context" ]; then
    node "$repo_dir/src/tray-build-plan.mjs" --fixture-field "$fixture_context" "$1"
  else
    node "$repo_dir/src/tray-build-plan.mjs" --production-field "$1"
  fi
}

if [ -z "$bundle_dir" ]; then
  bundle_dir=$(target_field appPath)
fi
if [ -n "$fixture_context" ]; then
  context_source_root=$(context_field sourceRoot)
  if ! canonical_context_source_root=$(CDPATH= cd -- "$context_source_root" 2>/dev/null && pwd -P); then
    printf 'codex-router: fixture sourceRoot invalid or does not match this checkout.\n' >&2
    exit 2
  fi
  [ -n "$canonical_context_source_root" ] || {
    printf 'codex-router: fixture sourceRoot invalid or does not match this checkout.\n' >&2
    exit 2
  }
  [ "$repo_dir" = "$canonical_context_source_root" ] || {
    printf 'codex-router: fixture sourceRoot does not match this checkout.\n' >&2
    exit 2
  }
  node "$repo_dir/src/tray-build-plan.mjs" --fixture-validate-output "$fixture_context" "$bundle_dir" >/dev/null
else
  target_parent=$(dirname "$(target_field appPath)")
  bundle_dir=$(node "$repo_dir/src/tray-build-plan.mjs" --production-validate-output "$target_parent" "$bundle_dir")
fi

tray_label=$(target_field trayLabel)
if [ -n "$fixture_context" ] && [ "$(context_field dryRun)" = "1" ]; then
  printf '%s\n' "$bundle_dir"
  exit 0
fi
if [ -n "$fixture_context" ]; then
  configuration=$(context_field configuration)
else
  configuration=release
fi
case "$configuration" in
  debug|release) ;;
  *)
    printf 'codex-router: tray configuration must be debug or release.\n' >&2
    exit 2
    ;;
esac
tray_dir="$repo_dir/apps/macos/ModelRouterTray"
binary_dir="$tray_dir/.build/$configuration"

# Callers capture this script's stdout as the bundle path, so compiler
# progress must not land there.
"$swift_bin" build -c "$configuration" --package-path "$tray_dir" 1>&2
[ -x "$binary_dir/ModelRouterTray" ] || {
  printf 'codex-router: Swift tray build did not produce ModelRouterTray.\n' >&2
  exit 1
}
[ -f "$tray_dir/Resources/Info.plist" ] || {
  printf 'codex-router: Swift tray Info.plist is missing.\n' >&2
  exit 1
}
mkdir -p "$bundle_dir/Contents/MacOS" "$bundle_dir/Contents/Resources"
cp "$binary_dir/ModelRouterTray" "$bundle_dir/Contents/MacOS/ModelRouterTray"
cp "$tray_dir/Resources/Info.plist" "$bundle_dir/Contents/Info.plist"
node "$repo_dir/src/tray-bundle.mjs" set-identifier "$bundle_dir/Contents/Info.plist" "$tray_label"
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
"$plistbuddy_bin" -c "Add :ModelRouterSourceRoot string $repo_dir" \
  "$bundle_dir/Contents/Info.plist"
"$codesign_bin" --force --deep --sign - "$bundle_dir"
"$codesign_bin" --verify --deep --strict "$bundle_dir"

printf '%s\n' "$bundle_dir"
