#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec node "$repo_dir/scripts/package-release.mjs" "$@"
