---
name: mobius-local-setup
description: First-time setup and launch of the Mobius development environment on macOS (non-Docker). Use when the user says "help me start the project", "install dependencies", "run it locally", or "setup mobius".
---

# Mobius Local Development Environment Setup

## Overview

The Mobius local dev stack consists of three parts:

- **Backend** (Node.js): `http://localhost:45614`
- **Frontend** (Vite dev): `http://localhost:45616`
- **aimux bridge** (Python): `http://localhost:45615`

Default login: username `admin`, password `admin` (controlled by `IMAC_BOOTSTRAP_USERS`).

---

## Installation Steps (execute in order)

Check whether each step is already satisfied before executing to avoid redundant operations.

### Step 1: Check and install system dependencies

```bash
# Check tmux (tmux manages backend/frontend processes)
which tmux || brew install tmux

# Check Node.js (requires v18+)
node --version || brew install node

# Check Python3
python3 --version
```

### Step 2: Install Claude Code CLI

```bash
# Check first
which claude && claude --version

# If not installed, install via mirror (official source may time out)
npm install -g @anthropic-ai/claude-code --registry https://registry.npmmirror.com
```

### Step 3: Configure Claude Code API Key

This step creates the two files that Claude Code needs to start without showing login dialogs. **Both files must exist before the first session is launched.**

#### 3a. Create `~/.claude/mobiusdefault.settings.json`

This file passes the API key and base URL into every Claude Code session.

**Z.AI / GLM-5.2（推荐）**:
```bash
mkdir -p ~/.claude
cat > ~/.claude/mobiusdefault.settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_API_KEY": "<your-zai-api-key>",
    "ANTHROPIC_AUTH_TOKEN": "<your-zai-api-key>",
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"
  }
}
EOF
chmod 600 ~/.claude/mobiusdefault.settings.json
```

**Official Anthropic**:
```bash
mkdir -p ~/.claude
cat > ~/.claude/mobiusdefault.settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_API_KEY": "<sk-ant-...>",
    "ANTHROPIC_AUTH_TOKEN": "<sk-ant-...>",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
EOF
chmod 600 ~/.claude/mobiusdefault.settings.json
```

#### 3b. Patch `~/.claude.json` — skip first-launch dialogs

Claude shows a **theme selection dialog** on its very first startup. Without patching, the TUI ready-wait will always time out (25s). Pre-set the theme and onboarding flags to bypass these one-time screens:

```bash
python3 - << 'PY'
import json, os

path = os.path.expanduser("~/.claude.json")
d = {}
if os.path.exists(path):
    try:
        d = json.load(open(path))
    except Exception:
        d = {}

d["primaryApiKey"] = "<your-api-key>"   # same key as above
d.setdefault("theme", "dark")
d.setdefault("hasCompletedOnboarding", True)
d.setdefault("onboardingComplete", True)

tmp = path + ".setup-tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, path)
print("✓ ~/.claude.json updated")
PY
```

> **Why both?** `primaryApiKey` lets claude authenticate without OAuth login. `theme` + onboarding flags skip the one-time UI setup dialogs that otherwise block the TUI ready sentinel.

---

### Step 4: Create the local `.env` file

Create `.env` in the project root. Replace `/Users/boyin.liu` with your actual `$HOME` and fill in your API key:

```bash
cat > /Users/boyin.liu/PycharmProjects/mobius/.env << 'EOF'
# ── Local paths (replace /Users/boyin.liu with your actual $HOME) ──────────
APP_DIR=/Users/boyin.liu/PycharmProjects/mobius
MOBIUS_DATA_PATH=/Users/boyin.liu/PycharmProjects/mobius/local_data
CORE_DATA_PATH=/Users/boyin.liu/PycharmProjects/mobius/local_data/protected_data
MODEL_ACCESS_PATH=/Users/boyin.liu/PycharmProjects/mobius/local_data/model-access.json
SHARED_SKILL_LIBRARY_DIR=/Users/boyin.liu/PycharmProjects/mobius/local_data/shared-skill-library
SHARED_SKILL_BACKUP_DIR=/Users/boyin.liu/PycharmProjects/mobius/local_data/shared-skill-library-backups

MOBIUS_PORT=45614
VITE_PORT=45616
CODE_SERVER_PORT=45617

DB_PATH=/Users/boyin.liu/PycharmProjects/mobius/local_data/mobius.db
WORKSPACE_ROOT=/Users/boyin.liu/PycharmProjects/mobius/local_data/workspace
HOME_WORKSPACE_ROOT=/Users/boyin.liu/PycharmProjects/mobius/local_data/workspace/home
LOCAL_WORKSPACE_ROOT=/Users/boyin.liu/PycharmProjects/mobius/local_data/workspace/_employees
TURNS_SUMMARY_DIR=/Users/boyin.liu/PycharmProjects/mobius/local_data/turn-summaries
IMAC_DEBUG_ENV_FILE=/Users/boyin.liu/PycharmProjects/mobius/.imac/debug-env.json

CODE_SERVER_CWD=/Users/boyin.liu
CS_BIN=/usr/local/bin/code-server
CODE_SERVER_DATA_ROOT=/Users/boyin.liu/PycharmProjects/mobius/local_data/code_server
CS_DATA_ROOT=/Users/boyin.liu/PycharmProjects/mobius/local_data/code_server/cs-data
CS_EXT_ROOT=/Users/boyin.liu/PycharmProjects/mobius/local_data/code_server/cs-ext

VITE_HOST=0.0.0.0
VITE_ALLOWED_HOSTS=localhost,127.0.0.1
VITE_HMR_PROTOCOL=ws
VITE_HMR_CLIENT_PORT=45616

# ── Claude Code Agent Key (Z.AI GLM-5.2 / Anthropic) ──────────────────────
ANTHROPIC_AUTH_TOKEN=your-api-key-here
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic

# ── Built-in assistant & chat UI model (same key) ──────────────────────────
ASSISTANT_API_BASE=https://api.z.ai/api/paas/v4
ASSISTANT_API_KEY=your-api-key-here
BEST_API_KEY=your-api-key-here
ASSISTANT_MODEL=glm-5.2
EOF
```

> **Note**:
> - Replace `/Users/boyin.liu` with your actual home directory (`echo $HOME`).
> - All API key fields are required. The service will fail silently if left as placeholders.
> - `.env` is listed in `.gitignore` and will not be committed to the repository.

### Step 5: Create local data directories and the .imac directory

```bash
mkdir -p ~/PycharmProjects/mobius/local_data/{protected_data,workspace/{home,_employees},turn-summaries}
mkdir -p ~/PycharmProjects/mobius/local_data/code_server/{cs-data,cs-ext}
mkdir -p ~/PycharmProjects/mobius/.imac
```

### Step 6: Install npm dependencies

**Backend**:
```bash
cd ~/PycharmProjects/mobius/mobius
npm install
```

**Frontend** (remove old `node_modules` to avoid native package architecture mismatch with rollup):
```bash
cd ~/PycharmProjects/mobius/mobius/frontend
rm -rf node_modules package-lock.json
npm install --registry https://registry.npmmirror.com
```

> The frontend `node_modules` must be deleted and reinstalled; otherwise `@rollup/rollup-darwin-arm64` native packages may be missing.

### Step 7: Apply compatibility patches (required on first install)

**Patch A**: Change `tmux-codex.js` preflight to a warning/degraded mode (prevents crash when Codex CLI is not installed)

Find the `preflight` function in `mobius/backend/agents/tmux-codex.js` and replace `process.exit(1)` with `return`:

```javascript
// Before
if (missing.length) {
  console.error('[tmux-codex] ❌ preflight failed, refusing to start:')
  for (const m of missing) console.error('   - ' + m)
  process.exit(1)
}

// After
if (missing.length) {
  console.warn('[tmux-codex] ⚠️  preflight dependencies incomplete, codex sessions unavailable (claude-code unaffected):')
  for (const m of missing) console.warn('   - ' + m)
  return
}
```

**Patch B**: `start_debug.py` aimux-bridge tmux window creation (tmux 3.x compatibility)

Find the `start_aimux_bridge` function in `mobius/start_debug.py` and change `-t imac-mobius:mobius` to `-t imac-mobius`:

```python
# Before
argv = ["tmux", "new-window", "-t", f"{SESSION}:mobius", "-n", "aimux-bridge", ...]

# After
argv = ["tmux", "new-window", "-t", SESSION, "-n", "aimux-bridge", ...]
```

### Step 8: Start the project

```bash
cd ~/PycharmProjects/mobius
python3 mobius/start_debug.py
```

Expected output:
```
✅ tmux session: imac-mobius
✅ backend:       http://0.0.0.0:45614/api/v2/health
✅ frontend:      http://0.0.0.0:45616
✅ aimux bridge:  http://127.0.0.1:45615
```

### Step 9: Bootstrap the default user (required after first start)

After the project starts, the database tables are created but no users exist. Run the bootstrap script once to seed the initial account:

```bash
cd ~/PycharmProjects/mobius/mobius
# ⚠️  Replace the password below with your own strong password (min 8 chars, letters + numbers)
IMAC_BOOTSTRAP_USERS="admin:your-strong-password:admin:Administrator" \
  DB_PATH=~/PycharmProjects/mobius/local_data/mobius.db \
  WORKSPACE_ROOT=~/PycharmProjects/mobius/local_data/workspace \
  node scripts/bootstrap-users.js
```

Expected output: `[bootstrap-users] seeded=1 skipped(already exists)=0 total=1`

> **Note**:
> - Use a strong password — **do not use admin/admin**.
> - In container deployments this step is handled automatically by `docker-entrypoint.sh`. For local first-time setup, run it manually once. Subsequent restarts do not require re-running it (`INSERT OR IGNORE` logic skips existing records).

### Step 10: Verify services

```bash
curl http://localhost:45614/api/v2/health
curl -o /dev/null -w "%{http_code}" http://localhost:45616
```

---

## Daily Operations

| Action | Command |
|--------|---------|
| Restart all services | `cd ~/PycharmProjects/mobius && python3 mobius/start_debug.py` |
| View backend logs (interactive) | `tmux attach -t imac-mobius` |
| View backend logs (read-only) | `tail -f /tmp/mobius-server.log` |
| View frontend logs | `tail -f /tmp/mobius-vite.log` |
| Stop all services | `tmux kill-session -t imac-mobius` |

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| Login — incorrect username or password | Bootstrap user script was not run | Step 9 |
| `bin (PATH): claude` preflight failed | Claude Code CLI not installed | Step 2 |
| `claude TUI 未在 25000ms 内 ready` | `~/.claude.json` 缺少 `primaryApiKey`，或首次启动主题对话框阻塞 TUI | Step 3b |
| `Cannot read properties of null (reading 'key')` | 模型配置文件不存在（`mobiusdefault.settings.json` 未创建） | Step 3a |
| `ENOENT: /data/code_server/cs-data` | `.env` has not overridden Docker paths | Steps 4 & 5 |
| `Cannot find module @rollup/rollup-darwin-arm64` | npm did not download arm64 native package | Step 6 (delete and reinstall) |
| `create window failed: index 0 in use` | tmux 3.x window command incompatibility | Step 7 Patch B |
| `bin (PATH): codex` preflight failed | tmux-codex preflight forces exit | Step 7 Patch A |

## Quick Install Script

See [scripts/setup.sh](scripts/setup.sh). Run from the project root:

```bash
bash .cursor/skills/mobius-local-setup/scripts/setup.sh
```
