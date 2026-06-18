#!/usr/bin/env bash
# imac-import.sh — 在目标机把 export 包还原: UPSERT users/preferences + 还原 skill/memory FS
#
# 推荐在容器内运行 (避免装宿主 node):
#   podman cp imac-user-bundle-xxx.zip imac:/tmp/bundle.zip
#   podman exec imac bash /app/imac-import.sh --bundle /tmp/bundle.zip
#
# 宿主跑也行 (要 node + mobius/node_modules + python3):
#   bash imac-import.sh --bundle /path/to/bundle.zip
#
# 选项:
#   --bundle <zip>                必填
#   --workspace-root <path>       默认 $WORKSPACE_ROOT 或 /data/workspace
#   --skip-password               即使包里有 hash 也不导入 (开源场景, 让用户重设)
#   --reset-prompt                清空 personal_prompt
#   --db / --protected <path>     默认优先读 DB_PATH / CORE_DATA_PATH
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUNDLE=""
DATA_ROOT="${MOBIUS_DATA_PATH:-$ROOT/data}"
DB="${DB_PATH:-$DATA_ROOT/mobuis.db}"
PROTECTED="${CORE_DATA_PATH:-$ROOT/protected_data}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-/data/workspace}"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) BUNDLE="$2"; shift 2;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2;;
    --db) DB="$2"; shift 2;;
    --protected) PROTECTED="$2"; shift 2;;
    --skip-password) EXTRA_ARGS+=(--skip-password); shift;;
    --reset-prompt)  EXTRA_ARGS+=(--reset-prompt); shift;;
    -h|--help) sed -n '1,18p' "$0"; exit 0;;
    *) echo "unknown arg: $1"; exit 2;;
  esac
done
[[ -z "$BUNDLE" ]] && { echo "需要 --bundle <zip>"; exit 2; }
[[ -f "$BUNDLE" ]] || { echo "bundle not found: $BUNDLE"; exit 2; }

STAGING="$(mktemp -d -t imac-bundle-XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT

python3 -m zipfile -e "$BUNDLE" "$STAGING"
echo "[unzip] -> $STAGING"

mkdir -p "$(dirname "$DB")" "$PROTECTED"

cd "$ROOT/mobius"
node scripts/imac-import.js \
  --staging "$STAGING" \
  --db "$DB" \
  --protected "$PROTECTED" \
  --workspace-root "$WORKSPACE_ROOT" \
  "${EXTRA_ARGS[@]}"

echo "[import] DONE"
