#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TOOLS="$ROOT/.tmp/tools"
JDK="$TOOLS/jdk-deb/usr/lib/jvm/java-17-openjdk-amd64"
GRADLE="$TOOLS/gradle/gradle-8.8/bin/gradle"
XVFB_ROOT="$TOOLS/xvfb-deb"
VNC_ROOT="$TOOLS/vnc-deb"
TIGER_ROOT="$TOOLS/tigervnc-deb"
PROOT_ROOT="$TOOLS/proot-deb"
DISPLAY_ID="${MOMO_PREVIEW_DISPLAY:-89}"
VNC_PORT="${MOMO_PREVIEW_VNC_PORT:-5989}"
NOVNC_PORT="${MOMO_PREVIEW_NOVNC_PORT:-6088}"
LOG_DIR="$ROOT/.tmp/momo-mobile-preview"
TOKEN_FILE="$LOG_DIR/access-token"

require_path() {
  if [[ ! -e "$1" ]]; then
    echo "[preview] missing $1" >&2
    echo "[preview] local preview tools are expected under $TOOLS" >&2
    exit 1
  fi
}

require_path "$JDK/bin/java"
require_path "$GRADLE"
require_path "$XVFB_ROOT/usr/bin/xkbcomp"
require_path "$VNC_ROOT/usr/share/novnc/vnc.html"
require_path "$TIGER_ROOT/usr/bin/Xtigervnc"
require_path "$PROOT_ROOT/usr/bin/proot"

export PYTHONPATH="$VNC_ROOT/usr/lib/python3/dist-packages:${PYTHONPATH:-}"
export PATH="$PROOT_ROOT/usr/bin:$TIGER_ROOT/usr/bin:$XVFB_ROOT/usr/bin:$VNC_ROOT/usr/bin:$PATH"
export JAVA_HOME="$JDK"
export GRADLE_OPTS="-Djavax.net.ssl.trustStore=$JDK/lib/security/cacerts -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12"
export JAVA_TOOL_OPTIONS="-Djavax.net.ssl.trustStore=$JDK/lib/security/cacerts -Djavax.net.ssl.trustStorePassword=changeit -Djavax.net.ssl.trustStoreType=PKCS12 ${JAVA_TOOL_OPTIONS:-}"
export DISPLAY=":$DISPLAY_ID"

mkdir -p "$LOG_DIR"
if [[ ! -s "$TOKEN_FILE" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24 > "$TOKEN_FILE"
  else
    tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48 > "$TOKEN_FILE"
    printf '\n' >> "$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE"
fi
PREVIEW_TOKEN="$(tr -d '\n\r\t ' < "$TOKEN_FILE")"
cd "$ROOT"

echo "[preview] start $(date -Is)"
LD_LIBRARY_PATH="$PROOT_ROOT/usr/lib/x86_64-linux-gnu" \
  "$PROOT_ROOT/usr/bin/proot" \
    -b "$XVFB_ROOT/usr/bin/xkbcomp:/usr/bin/xkbcomp" \
    -b "$XVFB_ROOT/usr/share/X11/xkb:/usr/share/X11/xkb" \
    /usr/bin/env LD_LIBRARY_PATH="$TIGER_ROOT/usr/lib/x86_64-linux-gnu:$XVFB_ROOT/usr/lib/x86_64-linux-gnu:$VNC_ROOT/usr/lib/x86_64-linux-gnu" \
    "$TIGER_ROOT/usr/bin/Xtigervnc" ":$DISPLAY_ID" -geometry 430x900 -depth 24 -rfbport "$VNC_PORT" -localhost -SecurityTypes None -RawKeyboard=1 > "$LOG_DIR/xtigervnc.log" 2>&1 &
XVNC_PID=$!

sleep 2
python3 -m websockify --web "$VNC_ROOT/usr/share/novnc" "0.0.0.0:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" > "$LOG_DIR/novnc.log" 2>&1 &
NOVNC_PID=$!

sleep 1
cd "$ROOT/mobius/extension/momo-mobile/desktopPreview"
"$GRADLE" --no-daemon runDesktop > "$LOG_DIR/app.log" 2>&1 &
APP_PID=$!

cleanup() {
  kill "$APP_PID" "$NOVNC_PID" "$XVNC_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[preview] Xtigervnc pid=$XVNC_PID novnc pid=$NOVNC_PID app pid=$APP_PID"
echo "[preview] open http://127.0.0.1:$NOVNC_PORT/vnc.html?host=127.0.0.1&port=$NOVNC_PORT&autoconnect=true&resize=scale"
echo "[preview] via mobius local http://127.0.0.1:45616/momo_mobile_preview/vnc.html?host=127.0.0.1&port=45616&path=momo_mobile_preview/websockify&autoconnect=true&resize=scale&preview_token=$PREVIEW_TOKEN"
echo "[preview] via cloud https://cloud-17.agent-matrix.com/momo_mobile_preview/vnc.html?host=cloud-17.agent-matrix.com&port=443&encrypt=1&path=momo_mobile_preview/websockify&autoconnect=true&resize=scale&preview_token=$PREVIEW_TOKEN"
wait "$APP_PID"
