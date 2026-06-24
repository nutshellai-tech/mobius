#!/usr/bin/env bash
# Prepare and start an independent sshd dedicated to local port forwarding.
set -euo pipefail

ACTION="${1:-start}"

: "${CORE_DATA_PATH:=/data/protected_data}"
: "${MOBIUS_SSH_PORT:=33318}"
: "${MOBIUS_SSH_FORWARD_USER:=mobius-forward}"

BASE_DIR="${MOBIUS_SSH_FORWARD_DIR:-$CORE_DATA_PATH/ssh-forward}"
CLIENT_KEY="${MOBIUS_SSH_PRIVATE_KEY_PATH:-${MOBIUS_SSH_KEY_PATH:-$BASE_DIR/mobius-forward-ed25519}}"
AUTHORIZED_KEYS="${MOBIUS_SSH_AUTHORIZED_KEYS_PATH:-$BASE_DIR/authorized_keys}"
HOST_KEY_DIR="$BASE_DIR/host_keys"
CONFIG_FILE="${MOBIUS_SSHD_CONFIG_PATH:-$BASE_DIR/sshd_config}"
PID_FILE="${MOBIUS_SSHD_PID_FILE:-$BASE_DIR/sshd.pid}"
LOG_FILE="${MOBIUS_SSHD_LOG_FILE:-$BASE_DIR/sshd.log}"

die() {
  echo "[mobius-ssh-forward] $*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "must run as root to create the restricted user and start sshd"
  fi
}

validate_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]{1,5}$ ]] || die "MOBIUS_SSH_PORT must be an integer port"
  (( port >= 1 && port <= 65535 )) || die "MOBIUS_SSH_PORT must be in 1-65535"
  [[ "$port" != "443" ]] || die "MOBIUS_SSH_PORT must not be 443"
}

validate_user() {
  local user="$1"
  [[ "$user" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die "invalid MOBIUS_SSH_FORWARD_USER: $user"
}

find_sshd() {
  if [[ -n "${SSHD_BIN:-}" && -x "$SSHD_BIN" ]]; then
    readlink -f "$SSHD_BIN"
    return
  fi
  local found
  found="$(command -v sshd 2>/dev/null || true)"
  if [[ -z "$found" && -x /usr/sbin/sshd ]]; then
    found=/usr/sbin/sshd
  fi
  [[ -n "$found" && -x "$found" ]] || die "sshd not found; install openssh-server first"
  readlink -f "$found"
}

find_keygen() {
  local found
  found="$(command -v ssh-keygen 2>/dev/null || true)"
  [[ -n "$found" && -x "$found" ]] || die "ssh-keygen not found; install openssh-client/openssh-server first"
  readlink -f "$found"
}

find_nologin() {
  for candidate in "${NOLOGIN_BIN:-}" /usr/sbin/nologin /sbin/nologin /bin/false; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      readlink -f "$candidate"
      return
    fi
  done
  die "nologin or /bin/false not found"
}

state_owner() {
  if [[ -n "${MOBIUS_SSH_STATE_OWNER:-}" ]]; then
    echo "$MOBIUS_SSH_STATE_OWNER"
  elif [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    echo "$SUDO_USER"
  else
    echo ""
  fi
}

create_user() {
  local user="$1"
  local nologin="$2"
  if id "$user" >/dev/null 2>&1; then
    return
  fi
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell "$nologin" "$user"
  elif command -v adduser >/dev/null 2>&1; then
    adduser --system --no-create-home --home /nonexistent --shell "$nologin" "$user"
  else
    die "useradd/adduser not found; cannot create $user"
  fi
  passwd -l "$user" >/dev/null 2>&1 || true
}

ensure_keys() {
  local keygen="$1"
  mkdir -p "$BASE_DIR" "$HOST_KEY_DIR"
  chmod 700 "$BASE_DIR"
  chmod 700 "$HOST_KEY_DIR"

  if [[ ! -f "$CLIENT_KEY" || ! -f "$CLIENT_KEY.pub" ]]; then
    rm -f "$CLIENT_KEY" "$CLIENT_KEY.pub"
    "$keygen" -t ed25519 -N "" -C "mobius-port-forward" -f "$CLIENT_KEY" >/dev/null
  fi
  chmod 600 "$CLIENT_KEY"
  chmod 644 "$CLIENT_KEY.pub"

  if [[ ! -f "$HOST_KEY_DIR/ssh_host_ed25519_key" ]]; then
    "$keygen" -t ed25519 -N "" -f "$HOST_KEY_DIR/ssh_host_ed25519_key" >/dev/null
  fi
  chmod 600 "$HOST_KEY_DIR/ssh_host_ed25519_key"
  chmod 644 "$HOST_KEY_DIR/ssh_host_ed25519_key.pub"

  local pubkey
  pubkey="$(cat "$CLIENT_KEY.pub")"
  printf 'restrict,port-forwarding %s\n' "$pubkey" > "$AUTHORIZED_KEYS"
  chmod 600 "$AUTHORIZED_KEYS"
}

write_config() {
  local user="$1"
  local nologin="$2"
  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
  if [[ -d /run ]]; then
    mkdir -p /run/sshd
    chmod 755 /run/sshd
  fi
  cat > "$CONFIG_FILE" <<EOF
Port $MOBIUS_SSH_PORT
ListenAddress 0.0.0.0
Protocol 2
HostKey $HOST_KEY_DIR/ssh_host_ed25519_key
PidFile $PID_FILE
AuthorizedKeysFile $AUTHORIZED_KEYS
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
PermitEmptyPasswords no
UsePAM no
AllowUsers $user
AllowTcpForwarding local
PermitOpen 127.0.0.1:* localhost:*
GatewayPorts no
X11Forwarding no
AllowAgentForwarding no
PermitTTY no
PermitTunnel no
PermitUserEnvironment no
ClientAliveInterval 60
ClientAliveCountMax 3
LogLevel VERBOSE

Match User $user
    ForceCommand $nologin
EOF
  chmod 600 "$CONFIG_FILE"
}

adjust_state_owner() {
  local owner
  owner="$(state_owner)"
  if [[ -n "$owner" ]] && id "$owner" >/dev/null 2>&1; then
    chown "$owner":"$owner" "$CLIENT_KEY" "$CLIENT_KEY.pub" || true
    chmod 755 "$BASE_DIR"
    chmod 700 "$HOST_KEY_DIR"
    chmod 600 "$CLIENT_KEY" "$AUTHORIZED_KEYS" "$CONFIG_FILE" "$HOST_KEY_DIR/ssh_host_ed25519_key"
    chmod 644 "$CLIENT_KEY.pub" "$HOST_KEY_DIR/ssh_host_ed25519_key.pub"
  fi
}

stop_existing() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      for _ in {1..20}; do
        kill -0 "$pid" >/dev/null 2>&1 || break
        sleep 0.1
      done
    fi
    rm -f "$PID_FILE"
  fi
}

start_sshd() {
  local sshd="$1"
  "$sshd" -t -f "$CONFIG_FILE"
  stop_existing
  "$sshd" -f "$CONFIG_FILE" -E "$LOG_FILE"
}

print_status() {
  echo "user=$MOBIUS_SSH_FORWARD_USER"
  echo "port=$MOBIUS_SSH_PORT"
  echo "config=$CONFIG_FILE"
  echo "private_key=$CLIENT_KEY"
  echo "authorized_keys=$AUTHORIZED_KEYS"
  echo "pid_file=$PID_FILE"
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "status=running pid=$pid"
      return
    fi
  fi
  echo "status=stopped"
}

main() {
  validate_port "$MOBIUS_SSH_PORT"
  validate_user "$MOBIUS_SSH_FORWARD_USER"

  case "$ACTION" in
    start)
      require_root
      local sshd keygen nologin
      sshd="$(find_sshd)"
      keygen="$(find_keygen)"
      nologin="$(find_nologin)"
      create_user "$MOBIUS_SSH_FORWARD_USER" "$nologin"
      ensure_keys "$keygen"
      write_config "$MOBIUS_SSH_FORWARD_USER" "$nologin"
      adjust_state_owner
      start_sshd "$sshd"
      print_status
      ;;
    stop)
      require_root
      stop_existing
      print_status
      ;;
    status)
      print_status
      ;;
    *)
      die "usage: $0 [start|stop|status]"
      ;;
  esac
}

main "$@"
