# 智谱 API Key 配置教程

本文说明如何用智谱 AI 的 API Key 驱动 Mobius 的全部功能。

---

## 核心概念：两类功能，三个端点

Mobius 内部有两个角色各自独立调用大模型：

| 角色 | 说明 | 所用端点类型 |
|------|------|-------------|
| **Agent Session（小莫执行会话）** | 右侧执行面板，自动写代码/操作文件 | **Anthropic 兼容** |
| **小莫助手对话（chat UI）** | 浮动聊天窗，轻量问答助理 | **OpenAI 兼容** |

> 关键限制：**只有 GLM-5.2 通过 Z.AI 平台才同时支持这两个端点**。其他 GLM 模型（glm-4、glm-4-flash 等）只支持 OpenAI 兼容端点，无法驱动 Agent Session。

---

## 方案一：GLM-5.2（推荐，完整功能）

### 前提条件

- 需要在 [https://z.ai](https://z.ai) 注册并开通 **GLM Coding 套餐**
- 从控制台 → API Keys 获取一个 Key，格式类似 `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.xxxxxxx`

### 端点说明

GLM-5.2 通过 Z.AI 提供**两个端点**，同一个 Key 均可访问：

| 用途 | 端点 | 说明 |
|------|------|------|
| Agent Session | `https://api.z.ai/api/anthropic` | Anthropic API 兼容格式，供 Claude Code CLI 使用 |
| 小莫助手 Chat | `https://api.z.ai/api/paas/v4` | OpenAI Chat Completions 兼容格式 |
| 小莫助手 Chat（国内备用）| `https://open.bigmodel.cn/api/paas/v4` | 同上，国内直连更稳定 |

> ⚠️ 注意：`/api/coding/paas/v4` 是 Coding 专用工具端点，**不能用于通用聊天**，请勿填入 `ASSISTANT_API_BASE`。

### 第一步：配置 `.env`

编辑项目根目录的 `.env` 文件，填入以下内容（替换 `YOUR_KEY`）：

```env
# ── Agent Session 驱动（Claude Code CLI → Z.AI GLM-5.2）──────────────
ANTHROPIC_AUTH_TOKEN=YOUR_KEY
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic

# ── 小莫助手 Chat（OpenAI 兼容 → Z.AI GLM-5.2）────────────────────────
ASSISTANT_API_BASE=https://api.z.ai/api/paas/v4
ASSISTANT_API_KEY=YOUR_KEY
BEST_API_KEY=YOUR_KEY
ASSISTANT_MODEL=glm-5.2
```

> 国内网络如连接 `api.z.ai` 不稳定，可把 `ASSISTANT_API_BASE` 换成 `https://open.bigmodel.cn/api/paas/v4`（仅影响助手聊天，Agent 端点暂无国内备用地址）。

### 第二步：配置 Claude Code CLI 认证文件

Agent Session 通过 Claude Code CLI（`claude` 命令）启动，CLI 需要单独配置认证。

#### 2a. 创建 `~/.claude/mobiusdefault.settings.json`

```bash
mkdir -p ~/.claude
cat > ~/.claude/mobiusdefault.settings.json << 'EOF'
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "YOUR_KEY",
    "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"
  }
}
EOF
chmod 600 ~/.claude/mobiusdefault.settings.json
```

> 这个文件为每个 Agent Session 注入请求端点和认证 Token，让 claude CLI 把请求发到 Z.AI 而不是官方 Anthropic。

#### 2b. 更新 `~/.claude.json`（跳过首次启动对话框）

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

d["primaryApiKey"] = "YOUR_KEY"     # 让 claude CLI 跳过 OAuth 登录弹窗
d.setdefault("theme", "dark")        # 跳过首次启动主题选择对话框
d.setdefault("hasCompletedOnboarding", True)
d.setdefault("onboardingComplete", True)

tmp = path + ".setup-tmp"
with open(tmp, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, path)
print("✓ ~/.claude.json 已更新")
PY
```

> **为什么需要这一步？** claude CLI 首次运行会弹出三个对话框：登录验证、主题选择、Bypass 模式确认。任何一个阻塞都会导致 25 秒超时错误。预置这些字段可以跳过前两个，第三个由 Mobius 代码自动处理。

### 第三步：重启服务

```bash
# 如果服务已在运行，重启后端使 .env 生效
cd ~/PycharmProjects/mobius
python3 mobius/start_debug.py
```

---

## 方案二：其他 GLM 模型（仅助手 Chat，Agent 不可用）

glm-4、glm-4-flash、glm-z1 等模型通过智谱官方 API 访问，**只能用于小莫助手聊天，无法驱动 Agent Session**。

### 获取 Key

前往 [https://open.bigmodel.cn](https://open.bigmodel.cn) → 控制台 → API Keys。

### 配置 `.env`

```env
# ── 小莫助手 Chat 仅（Agent Session 不可用）────────────────────────────
ASSISTANT_API_BASE=https://open.bigmodel.cn/api/paas/v4
ASSISTANT_API_KEY=YOUR_ZHIPU_KEY
BEST_API_KEY=YOUR_ZHIPU_KEY
ASSISTANT_MODEL=glm-4-flash        # 或 glm-4、glm-z1-flash 等

# ── Agent Session 留空或填 Anthropic 官方 Key ──────────────────────────
# ANTHROPIC_AUTH_TOKEN=sk-ant-...
# ANTHROPIC_BASE_URL=https://api.anthropic.com
```

> 如果不填 `ANTHROPIC_AUTH_TOKEN`，新建 Agent Session 时会提示"没有可用的模型"，但小莫助手聊天正常工作。

---

## 方案对比

| 功能 | GLM-5.2（Z.AI） | 其他 GLM（官方 API）|
|------|:-:|:-:|
| 小莫助手聊天 | ✅ | ✅ |
| Agent Session 启动（Claude Code） | ✅ | ❌ |
| Codex Agent 启动 | ❌ 见下方说明 | ❌ |
| 同一个 Key 全功能覆盖 | ✅（Claude Code 功能） | ❌ |
| 国内直连（助手聊天） | ✅ 备用地址 | ✅ |
| 国内直连（Agent） | ⚠️ 可能需代理 | ❌ 不支持 |

---

## 关于 Codex Backend

Mobius 支持两种 Agent 执行后端：**Claude Code**（默认）和 **Codex**。Z.AI 的 GLM-5.2 只能驱动 Claude Code，**不能驱动 Codex**，原因如下：

### Z.AI 提供的端点

| 端点 | 协议格式 |
|------|---------|
| `https://api.z.ai/api/anthropic` | Anthropic API 兼容 → ✅ Claude Code |
| `https://api.z.ai/api/paas/v4` | OpenAI **Chat Completions** 兼容 → ✅ 助手对话 |
| `https://api.z.ai/api/paas/v4/responses` | OpenAI **Responses API** → ❌ 404，不支持 |

### Codex 的要求

Codex CLI（`@openai/codex`）自 2026 年 2 月起已**完全移除** Chat Completions 支持，只支持 `wire_api = "responses"`（OpenAI Responses API）。由于 Z.AI 不提供 Responses API 端点，用 Z.AI key 配置 Codex 会失败。

### 如何使用 Codex

若需启用 Codex backend，需要一个支持 OpenAI Responses API 的服务商，例如：

- **OpenAI 官方 API** — `https://api.openai.com/v1`，需 `OPENAI_API_KEY`（`sk-...`）
- **Azure OpenAI**（需单独部署）
- **OpenRouter**（`https://openrouter.ai/api/v1`，支持 Responses API，可代理多种模型）

配置好服务商后，在 Mobius 管理后台 → **模型管理 → Codex** 面板中填入 TOML 配置即可，示例：

```toml
model_provider = "openrouter"
model = "openai/gpt-5.3-codex"
network_access = "enabled"
disable_response_storage = true
windows_wsl_setup_acknowledged = true

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
api_key = "sk-or-..."
```

> 暂时只用 Z.AI key 的用户：使用 Claude Code（默认 Agent backend）即可获得完整 Agent Session 功能，无需配置 Codex。

---

## 常见问题

### `claude TUI 未在 25000ms 内 ready`

**原因**：claude CLI 启动时弹出了一个或多个对话框，超时前没有到达就绪状态。

**排查步骤**：
1. 检查 `~/.claude.json` 是否有 `primaryApiKey`：
   ```bash
   python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude.json'))); print('primaryApiKey:', bool(d.get('primaryApiKey')))"
   ```
2. 检查 `~/.claude/mobiusdefault.settings.json` 是否存在：
   ```bash
   cat ~/.claude/mobiusdefault.settings.json
   ```
3. 如两项均正常，说明是网络问题（Z.AI 端点响应慢）；尝试检查网络连通性：
   ```bash
   curl -s -o /dev/null -w "%{http_code} %{time_total}s" https://api.z.ai/api/anthropic
   ```

---

### `Cannot read properties of null (reading 'key')`

**原因**：系统找不到任何可用模型配置（`~/.claude/mobiusdefault.settings.json` 不存在）。

**修复**：按本教程第二步创建该文件，重启服务即可。

---

### 助手聊天正常但 Agent Session 报错

确认以下两点：
1. 使用的是 **GLM-5.2 + Z.AI**（其他模型不支持 Agent）
2. `ANTHROPIC_BASE_URL` 填的是 `https://api.z.ai/api/anthropic`，而非 paas 端点

---

### 如何验证配置是否正确

```bash
# 验证助手 Chat 端点
curl -s -X POST https://api.z.ai/api/paas/v4/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('✅ OK:', d['choices'][0]['message']['content'] if 'choices' in d else '❌ ' + str(d))"

# 验证 Agent 端点
curl -s -X POST https://api.z.ai/api/anthropic/v1/messages \
  -H "x-api-key: YOUR_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.2","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('✅ OK:', d['content'][0]['text'] if 'content' in d else '❌ ' + str(d))"
```
