#!/usr/bin/env bash
# Mobius local development one-shot setup script
# Usage: bash .cursor/skills/mobius-local-setup/scripts/setup.sh
# Must run from project root (parent of mobius/server.js)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[setup]${NC} $*"; }
error()   { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }
step()    { echo; echo -e "${GREEN}=== $* ===${NC}"; }

# ── 1. System tools ────────────────────────────────────────────
step "1/8 检查系统依赖"

if ! command -v brew &>/dev/null; then
  error "未找到 Homebrew。请先安装: https://brew.sh"
fi

if ! command -v tmux &>/dev/null; then
  info "安装 tmux..."
  brew install tmux
else
  info "tmux 已安装: $(tmux -V)"
fi

if ! command -v node &>/dev/null; then
  error "未找到 Node.js，请先安装: brew install node"
fi
info "Node.js: $(node --version)"

if ! command -v python3 &>/dev/null; then
  error "未找到 Python3"
fi
info "Python3: $(python3 --version)"

# ── 2. Claude Code CLI ─────────────────────────────────────
step "2/8 检查 Claude Code CLI"

if ! command -v claude &>/dev/null; then
  info "安装 Claude Code CLI（使用国内镜像）..."
  npm install -g @anthropic-ai/claude-code --registry https://registry.npmmirror.com
else
  info "claude 已安装: $(claude --version 2>/dev/null | head -1)"
fi

# ── 3. Claude Code API Key 配置 ────────────────────────────────
step "3/8 配置 Claude Code API Key（Z.AI / GLM-5.2）"

CLAUDE_SETTINGS_FILE="$HOME/.claude/mobiusdefault.settings.json"
CLAUDE_JSON="$HOME/.claude.json"

# 提示用户输入 API Key（如已存在则跳过）
EXISTING_KEY=""
if [[ -f "$CLAUDE_JSON" ]]; then
  EXISTING_KEY=$(python3 -c "
import json, sys
try:
    d = json.load(open('$CLAUDE_JSON'))
    k = d.get('primaryApiKey', '')
    if k and not k.startswith('your-'):
        print(k)
except: pass
" 2>/dev/null || true)
fi

if [[ -n "$EXISTING_KEY" ]]; then
  info "~/.claude.json 中已有 primaryApiKey，跳过 API Key 配置"
  API_KEY="$EXISTING_KEY"
else
  echo
  echo "  请输入你的 API Key（支持 Z.AI GLM-5.2 或 Anthropic 官方 Key）："
  echo "  Z.AI 获取地址：https://z.ai → Console → API Keys"
  read -rp "  API Key: " API_KEY
  if [[ -z "$API_KEY" ]]; then
    warn "未输入 API Key，跳过 Claude Code 配置（之后可手动配置）"
    API_KEY=""
  fi
fi

if [[ -n "$API_KEY" ]]; then
  # 询问 API Base URL（默认 Z.AI）
  if [[ -z "${API_BASE_URL:-}" ]]; then
    echo
    echo "  API Base URL（直接回车使用 Z.AI 默认值）："
    echo "  Z.AI:      https://api.z.ai/api/anthropic  (默认)"
    echo "  Anthropic: https://api.anthropic.com"
    read -rp "  Base URL [https://api.z.ai/api/anthropic]: " API_BASE_URL
    API_BASE_URL="${API_BASE_URL:-https://api.z.ai/api/anthropic}"
  fi

  # 创建 ~/.claude/mobiusdefault.settings.json
  mkdir -p "$HOME/.claude"
  cat > "$CLAUDE_SETTINGS_FILE" << SETTINGS_EOF
{
  "env": {
    "ANTHROPIC_API_KEY": "$API_KEY",
    "ANTHROPIC_AUTH_TOKEN": "$API_KEY",
    "ANTHROPIC_BASE_URL": "$API_BASE_URL"
  }
}
SETTINGS_EOF
  chmod 600 "$CLAUDE_SETTINGS_FILE"
  info "已创建 ~/.claude/mobiusdefault.settings.json"

  # 更新 ~/.claude.json：写入 primaryApiKey + 预置 theme / onboarding（避免首次启动卡在 UI 对话框）
  python3 - "$CLAUDE_JSON" "$API_KEY" << 'PYEOF'
import json, os, sys
path, key = sys.argv[1], sys.argv[2]
d = {}
if os.path.exists(path):
    try:
        d = json.load(open(path))
    except Exception:
        d = {}
d["primaryApiKey"] = key
# Pre-set theme and onboarding flags so claude TUI skips first-launch setup dialogs.
d.setdefault("theme", "dark")
d.setdefault("hasCompletedOnboarding", True)
d.setdefault("onboardingComplete", True)
tmp = path + ".mobius-setup-tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, path)
print(f"✓ ~/.claude.json 已更新 (primaryApiKey + theme + onboarding 标记)")
PYEOF
fi

# ── 4. Local .env ────────────────────────────────────────────
step "4/8 创建本地 .env 配置"

if [[ -f "$REPO_ROOT/.env" ]]; then
  warn ".env 已存在，跳过（如需重置请手动删除后重跑）"
else
  # 确定 API Base URL for assistant (paas endpoint, not anthropic endpoint)
  if [[ "${API_BASE_URL:-}" == *"z.ai"* ]]; then
    ASSISTANT_API_BASE="https://api.z.ai/api/paas/v4"
  else
    ASSISTANT_API_BASE="${API_BASE_URL:-https://api.openai.com/v1}"
  fi
  ASSISTANT_MODEL="glm-5.2"

  cat > "$REPO_ROOT/.env" << EOF
# ── 本地路径（由 setup.sh 自动生成） ───────────────────────────
APP_DIR=$REPO_ROOT
MOBIUS_DATA_PATH=$REPO_ROOT/local_data
CORE_DATA_PATH=$REPO_ROOT/local_data/protected_data
MODEL_ACCESS_PATH=$REPO_ROOT/local_data/model-access.json
SHARED_SKILL_LIBRARY_DIR=$REPO_ROOT/local_data/shared-skill-library
SHARED_SKILL_BACKUP_DIR=$REPO_ROOT/local_data/shared-skill-library-backups

MOBIUS_PORT=45614
VITE_PORT=45616
CODE_SERVER_PORT=45617

DB_PATH=$REPO_ROOT/local_data/mobius.db
WORKSPACE_ROOT=$REPO_ROOT/local_data/workspace
HOME_WORKSPACE_ROOT=$REPO_ROOT/local_data/workspace/home
LOCAL_WORKSPACE_ROOT=$REPO_ROOT/local_data/workspace/_employees
TURNS_SUMMARY_DIR=$REPO_ROOT/local_data/turn-summaries
IMAC_DEBUG_ENV_FILE=$REPO_ROOT/.imac/debug-env.json

CODE_SERVER_CWD=$HOME
CS_BIN=/usr/local/bin/code-server
CODE_SERVER_DATA_ROOT=$REPO_ROOT/local_data/code_server
CS_DATA_ROOT=$REPO_ROOT/local_data/code_server/cs-data
CS_EXT_ROOT=$REPO_ROOT/local_data/code_server/cs-ext

VITE_HOST=0.0.0.0
VITE_ALLOWED_HOSTS=localhost,127.0.0.1
VITE_HMR_PROTOCOL=ws
VITE_HMR_CLIENT_PORT=45616

# ── Claude Code Agent Key（驱动右侧 Agent 对话，Z.AI GLM-5.2 填这里）──
ANTHROPIC_AUTH_TOKEN=${API_KEY:-your-api-key-here}
ANTHROPIC_BASE_URL=${API_BASE_URL:-https://api.z.ai/api/anthropic}

# ── 内置助手 & 聊天 UI 模型（同一个 Key）──────────────────────
ASSISTANT_API_BASE=$ASSISTANT_API_BASE
ASSISTANT_API_KEY=${API_KEY:-your-api-key-here}
BEST_API_KEY=${API_KEY:-your-api-key-here}
ASSISTANT_MODEL=$ASSISTANT_MODEL
EOF
  info ".env 已创建（含 API Key 配置）"
fi

# ── 5. Data directories ─────────────────────────────────────────────
step "5/8 创建本地数据目录"

mkdir -p "$REPO_ROOT/local_data"/{protected_data,workspace/{home,_employees},turn-summaries}
mkdir -p "$REPO_ROOT/local_data/code_server"/{cs-data,cs-ext}
mkdir -p "$REPO_ROOT/.imac"
info "数据目录已就位"

# ── 6. npm dependencies ─────────────────────────────────────────────
step "6/8 安装 npm 依赖"

info "后端依赖..."
cd "$REPO_ROOT/mobius"
npm install

info "前端依赖（清除旧 node_modules 以修复 rollup arm64 问题）..."
cd "$REPO_ROOT/mobius/frontend"
rm -rf node_modules package-lock.json
npm install --registry https://registry.npmmirror.com

cd "$REPO_ROOT"

# ── 7. Compatibility patches ─────────────────────────────────────────
step "7/8 应用兼容补丁"

# Patch A: tmux-codex.js — downgrade preflight failure to warning
CODEX_FILE="$REPO_ROOT/mobius/backend/agents/tmux-codex.js"
if grep -q 'process.exit(1)' "$CODEX_FILE" 2>/dev/null; then
  python3 - "$CODEX_FILE" << 'PYEOF'
import sys, re
path = sys.argv[1]
content = open(path).read()
old = """\
  if (missing.length) {
    console.error('[tmux-codex] ❌ preflight 失败, 拒绝启动:')
    for (const m of missing) console.error('   - ' + m)
    process.exit(1)
  }"""
new = """\
  if (missing.length) {
    console.warn('[tmux-codex] ⚠️  preflight 依赖不完整, codex 会话不可用 (不影响 claude-code):')
    for (const m of missing) console.warn('   - ' + m)
    return
  }"""
if old in content:
    open(path, 'w').write(content.replace(old, new))
    print("补丁 A 已应用: tmux-codex.js preflight 改为警告")
else:
    print("补丁 A 已跳过（已修改或结构不匹配）")
PYEOF
else
  info "补丁 A 已跳过（tmux-codex.js 无需修改）"
fi

# Patch B: start_debug.py — tmux new-window target set to SESSION (tmux 3.x compatible)
START_FILE="$REPO_ROOT/mobius/start_debug.py"
if python3 -c "
import sys
src = open('$START_FILE').read()
print('needs_patch' if 'SESSION}:mobius' in src else 'ok')
" 2>/dev/null | grep -q needs_patch; then
  python3 - "$START_FILE" << 'PYEOF'
import sys
path = sys.argv[1]
content = open(path).read()
old = '        f"{SESSION}:mobius",'
new = '        SESSION,'
if old in content:
    open(path, 'w').write(content.replace(old, new, 1))
    print("补丁 B 已应用: start_debug.py tmux new-window 目标修正")
else:
    print("补丁 B 已跳过（已修改或结构不匹配）")
PYEOF
else
  info "补丁 B 已跳过（start_debug.py 无需修改）"
fi

# ── 8. Start Mobius ─────────────────────────────────────────────────
step "8/8 启动 Mobius"

python3 "$REPO_ROOT/mobius/start_debug.py"

echo
info "安装完成！"
info "前端: http://localhost:45616   (用户名: admin  密码: admin)"
info "后端: http://localhost:45614/api/v2/health"
info "查看日志: tmux attach -t imac-mobius"
info "停止服务: tmux kill-session -t imac-mobius"
