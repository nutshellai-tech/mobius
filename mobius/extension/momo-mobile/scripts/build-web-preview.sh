#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/../../.." && pwd)"
GRADLE="${GRADLE_BIN:-$ROOT/gradlew}"
SOURCE="$ROOT/webPreview/build/dist/wasmJs/productionExecutable"
DIST="$ROOT/frontend/dist"

if [[ ! -x "$GRADLE" ]]; then
  echo "Gradle executable not found: $GRADLE" >&2
  exit 1
fi

"$GRADLE" -p "$ROOT/webPreview" --no-daemon wasmJsBrowserDistribution

if [[ ! -f "$SOURCE/index.html" || ! -f "$SOURCE/momo-web-preview.js" ]]; then
  echo "Web preview distribution is incomplete: $SOURCE" >&2
  exit 1
fi

rm -rf "$DIST"
mkdir -p "$DIST"
cp -a "$SOURCE"/. "$DIST"/
rm -f "$DIST"/*.map
cp "$ROOT/frontend/favicon.svg" "$DIST/favicon.svg"

echo "momo-mobile shared Web preview synced to $DIST"
