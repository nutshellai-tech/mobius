#!/usr/bin/env bash
set -euo pipefail

CS_BIN="${CS_BIN:-/usr/bin/code-server}"
INSTALL_URL="https://code-server.dev/install.sh"

log() {
  printf '[code-server] %s\n' "$*"
}

show_version() {
  "$CS_BIN" --version 2>/dev/null | sed -n -E '/^[0-9]+(\.[0-9]+)+([[:space:]]|$)/p' | sed -n '1p' || true
}

if [[ -x "$CS_BIN" ]]; then
  version="$(show_version)"
  if [[ -n "$version" ]]; then
    log "already installed at $CS_BIN ($version)"
  else
    log "already installed at $CS_BIN"
  fi
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  log "ERROR: curl is required to install code-server." >&2
  exit 1
fi

if ! command -v sh >/dev/null 2>&1; then
  log "ERROR: sh is required to run the official code-server installer." >&2
  exit 1
fi

log "installing code-server"
log "target binary: $CS_BIN"
log "source: $INSTALL_URL"
log "the download can take a few minutes; the installer may ask for sudo"

tmp_installer="$(mktemp)"
cleanup() {
  rm -f "$tmp_installer"
}
trap cleanup EXIT

curl -fsSL "$INSTALL_URL" -o "$tmp_installer"
sh "$tmp_installer"

if [[ ! -x "$CS_BIN" ]]; then
  log "ERROR: installer finished, but $CS_BIN is not executable." >&2
  log "If code-server was installed somewhere else, update CS_BIN in .env." >&2
  exit 1
fi

version="$(show_version)"
if [[ -n "$version" ]]; then
  log "installed at $CS_BIN ($version)"
else
  log "installed at $CS_BIN"
fi
