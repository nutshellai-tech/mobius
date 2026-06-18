# aimax

[![PyPI](https://img.shields.io/pypi/v/aimax.svg)](https://pypi.org/project/aimax/)
[![Python](https://img.shields.io/pypi/pyversions/aimax.svg)](https://pypi.org/project/aimax/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`aimax` 是一个 Python agent driver，用 `tmux` 驱动真实的 Claude Code / Codex TUI，并把 agent 写出的 JSONL 事件流转换成可在 Python 或 CLI 中消费的会话接口。

它来自 `imac` 项目的 `mobius/backend/agents` JavaScript 后端，并在 Python 侧提供同等的 session 管理、prompt 投递、历史读取、流式订阅、代理配置和运行标记能力。

## 适用场景

- 需要从 Python 服务里启动、恢复、暂停或终止 Claude Code / Codex 会话。
- 需要保留真实 TUI 的长期上下文，而不是每次调用一次性命令。
- 需要把 agent 原生 JSONL 和 Mobius 捕获的用户 prompt 合并成一个历史流。
- 需要通过 `running.flag` / `failed.flag` 让外部系统判断任务完成状态。
- 需要 CLI 脚本化操作 agent session，并用 `--json` 对接其他服务。

## 核心能力

- **两个后端，一个接口**：`tmux-claude-code` 和 `tmux-codex` 都实现 `AgentBackend` 接口。
- **真实 TUI 会话**：每个 session 对应一个 tmux window；Python 进程重启后仍可恢复已经存在的 window。
- **合并 JSONL 历史**：读取 agent 原生 JSONL，同时合并 sibling `*.mobius.jsonl` 中由 driver 捕获的用户 prompt。
- **无重复流式续接**：`get_history()` 返回 sentinel，`get_agent_raw_thought_stream(..., {"fromSentinel": sentinel})` 可从该位置继续 tail。
- **Prompt 捕获**：通过 `mobiusJsonl` 或默认 sibling 文件记录 driver 投递的 prompt，刷新页面后仍能看到用户输入。
- **代理配置**：支持按后端保存 `useProxy` 默认值，也支持每次调用覆盖。
- **Per-session 配置文件**：Codex 后端支持按 session 指定基础 `config.toml`；Claude 后端支持按 session 指定 settings JSON。
- **Codex pending recovery**：Codex 后端支持 pending thread 绑定和已有 window 的 thread fallback。
- **包名兼容**：新包名是 `aimax`；旧 `tmux_agents` import 和 `tmux-agents` CLI 仍保留兼容。

## 安装

从 PyPI 安装：

```bash
pip install aimax
```

从源码开发安装：

```bash
cd mobius/backend/agents_py
pip install -e .
```

运行要求：

- Python `>= 3.9`
- `tmux` 在 `PATH` 中
- 使用 Claude 后端时，`claude` 在 `PATH` 中
- 使用 Codex 后端时，`codex` 在 `PATH` 中
- 如果启用代理路径，需要本机存在可用的 `proxychains`、代理环境文件和代理配置文件

## 快速开始：CLI

创建 Codex session：

```bash
aimax create \
  --backend tmux-codex \
  --session demo \
  --cwd /tmp/demo \
  --codex-config-path ~/.codex/config.toml \
  --prompt "在当前目录创建 hello.py，输出 hi"
```

创建 Claude Code session，并指定 settings JSON：

```bash
aimax create \
  --backend tmux-claude-code \
  --session claude-demo \
  --cwd /tmp/demo \
  --settings-path ~/.claude/settings.json \
  --prompt "检查这个目录"
```

追加一个不打断当前 turn 的 follow-up：

```bash
aimax send \
  --backend tmux-codex \
  --session demo \
  --prompt "再补一个 README"
```

中断当前 turn，并可选地提交新 prompt：

```bash
aimax pause \
  --backend tmux-codex \
  --session demo \
  --prompt "停止当前实现，改用更小的方案"
```

查看状态：

```bash
aimax status --backend tmux-codex --session demo
```

查看历史：

```bash
aimax history --backend tmux-codex --session demo --json
```

从历史 sentinel 继续看实时流：

```bash
aimax history --backend tmux-codex --session demo --json > history.json
SENTINEL="$(jq -c .sentinel history.json)"

aimax stream \
  --backend tmux-codex \
  --session demo \
  --from-sentinel "$SENTINEL"
```

列出 session：

```bash
aimax list
aimax list --backend tmux-claude-code --json
```

停止 session：

```bash
aimax stop --backend tmux-codex --session demo
```

旧命令名仍可用：

```bash
tmux-agents list
```

## CLI 命令

| 命令 | 作用 |
| --- | --- |
| `aimax create` | 创建新 session 并发送首个 prompt |
| `aimax send` | 向已有 session 排队发送 prompt，不主动中断当前 turn |
| `aimax pause` | 发送 Ctrl-C 中断当前 turn，可选提交新 prompt |
| `aimax stop` | kill 对应 tmux window |
| `aimax list` | 列出一个或所有后端的 live session |
| `aimax status` | 查看单个 session 的 alive / working / flag / proxy 状态 |
| `aimax history` | 输出合并后的 JSONL 历史 |
| `aimax stream` | 输出实时 JSONL 事件流 |
| `aimax config show` | 查看当前配置和 env override 映射 |
| `aimax admin show` | 查看持久化 admin 默认值 |
| `aimax admin set-proxy` | 设置某个后端默认 `useProxy` |
| `aimax version` | 输出包版本 |

所有需要选择后端的命令使用：

```bash
--backend tmux-codex
--backend tmux-claude-code
```

所有 session 命令使用：

```bash
--session <session-id>
```

所有支持结构化输出的命令都可以加：

```bash
--json
```

Prompt 可以来自三种位置，优先级从高到低：

```bash
aimax send -b tmux-codex -s demo --prompt "inline prompt"
aimax send -b tmux-codex -s demo --prompt-file ./prompt.md
cat prompt.md | aimax send -b tmux-codex -s demo
```

`create` 和 `send` 还支持后端配置文件参数：

```bash
# Codex: 为本 session 指定基础 config.toml
aimax create -b tmux-codex -s demo --cwd /tmp/demo \
  --codex-config-path ~/.codex/config.toml \
  -p "start"

# Claude Code: 为本 session 指定 settings JSON
aimax create -b tmux-claude-code -s demo --cwd /tmp/demo \
  --settings-path ~/.claude/settings.json \
  --force-no-proxy \
  -p "start"
```

## 快速开始：Python

```python
import asyncio
import aimax


async def main():
    backend = aimax.get("tmux-codex")

    handle = await backend.create_new_session({
        "sessionId": "demo",
        "cwd": "/tmp/demo",
        "initialPrompt": "在当前目录创建 hello.py，输出 hi",
        "configPath": "/home/me/.codex/config.toml",
    })

    print(handle["agentSessionId"])
    print(handle["jsonlPath"])

    history = backend.get_history("demo", {"tailCount": 100})

    def on_event(raw):
        print(raw)

    unsubscribe = backend.get_agent_raw_thought_stream(
        "demo",
        on_event,
        {"fromSentinel": history["sentinel"]},
    )

    await backend.no_pause_current_and_queue_query_at_session({
        "sessionId": "demo",
        "prompt": "补一个 README，并保持实现简单",
    })

    await asyncio.sleep(5)
    unsubscribe()


asyncio.run(main())
```

Claude Code 后端只需要换后端名：

```python
backend = aimax.get("tmux-claude-code")
```

并可传入 settings JSON：

```python
await backend.create_new_session({
    "sessionId": "claude-demo",
    "cwd": "/tmp/demo",
    "initialPrompt": "检查这个目录",
    "settingsPath": "/home/me/.claude/settings.json",
    "forceNoProxy": True,
})
```

## Python API

包入口：

```python
import aimax

backend = aimax.get("tmux-codex")
```

可用后端：

```python
aimax.SUPPORTED_BACKENDS
# ("tmux-claude-code", "tmux-codex")
```

主要方法：

| 方法 | 说明 |
| --- | --- |
| `await create_new_session(opts)` | 创建 session 并发送 `initialPrompt` |
| `await no_pause_current_and_queue_query_at_session(opts)` | 不中断当前 turn，排队发送 `prompt` |
| `await pause_current_and_resume_from_session(opts)` | 中断当前 turn，可选发送 `prompt` |
| `await terminate_session(session_id)` | 终止 tmux window |
| `is_alive(session_id)` | tmux window 是否存在 |
| `is_working(session_id)` | 当前是否还在工作 |
| `is_job_goal_accomplished(session_id)` | `running.flag` 是否已经消失 |
| `is_failed(session_id)` | `failed.flag` 是否存在 |
| `list_sessions()` | 列出 live session |
| `get_history(session_id, opts=None)` | 读取合并 JSONL 历史 |
| `get_agent_raw_thought_stream(session_id, listener, opts=None)` | 订阅实时 raw event，返回 unsubscribe 函数 |

### `create_new_session(opts)`

通用字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 逻辑 session id，也是 tmux window 名 |
| `cwd` | 是 | agent 工作目录，必须存在 |
| `initialPrompt` | 是 | 首个 prompt |
| `flagRoot` | 否 | `.imac/flags/<sessionId>/` 的根目录，默认等于 `cwd` |
| `model` | 否 | 透传给 agent 的模型名 |
| `useProxy` | 否 | 覆盖本次会话是否使用代理 |
| `displayName` | 否 | 持久化到 runtime entry 的展示名 |
| `agentSessionId` | 否 | 恢复已有 agent 线程，Claude 为 uuid，Codex 为 thread id |

Codex 后端额外字段：

| 字段 | 说明 |
| --- | --- |
| `configPath` | 指定本 session 使用的 Codex `config.toml`。别名：`codexConfigPath`、`codexConfig` |

当传入 `configPath` 时，driver 会在 `<AIMAX_DATA_DIR>/codex-profiles/<sessionId>/` 下创建一个 session 专属 `CODEX_HOME`。`config.toml` 会复制到该目录，因为 driver 需要写入项目 trust stanza。Codex 的 `state_5.sqlite` 和 `sessions/` 也会位于这个 session 专属 `CODEX_HOME`，因此进程重启后的 thread bind / history lookup 仍然能找到正确文件。Provider 秘钥不写 `auth.json`，而是在 tmux 启动时按 channel TOML 的 `env_key` export 环境变量。

Claude 后端额外字段：

| 字段 | 说明 |
| --- | --- |
| `settingsPath` | 覆盖 Claude settings JSON 路径。别名：`claudeSettingsPath`、`settingsJsonPath` |
| `forceNoProxy` | 强制不走代理，优先级高于 `useProxy` |

返回示例：

```json
{
  "sessionId": "demo",
  "agentSessionId": "thread-or-uuid",
  "jsonlPath": "/path/to/agent.jsonl",
  "startedAt": 1781179200000
}
```

### `send` / `pause` opts

`no_pause_current_and_queue_query_at_session()` 和 `pause_current_and_resume_from_session()` 接收：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `sessionId` | 是 | 目标 session |
| `prompt` | send 必填，pause 可选 | 要投递的新 prompt |
| `cwd` | 否 | session 不存在、需要重建 window 时使用 |
| `flagRoot` | 否 | 覆盖 flag 根目录 |
| `model` | 否 | 透传模型名 |
| `useProxy` | 否 | 覆盖代理 |
| `agentSessionId` | 否 | 指定已有 agent thread |
| `mobiusJsonl` | 否 | 指定 Mobius prompt 捕获 JSONL 路径 |
| `configPath` | Codex 可选 | session 不存在并需要重建 window 时，指定 Codex `config.toml` |
| `settingsPath` | Claude 可选 | session 不存在并需要重建 window 时，指定 Claude settings JSON |

Claude 后端同样支持 `settingsPath` 和 `forceNoProxy`。

注意：这些文件参数只在新建或重建 agent window 时生效。对已经活着的 Codex / Claude TUI，driver 不会热替换配置文件；需要先 `stop` 再用新参数 `create`。

## 历史与实时流

两个后端都会把历史读取为一个合并流：

- primary：agent 自己写出的 JSONL
- mobius：driver 捕获 prompt 后写出的 sibling `*.mobius.jsonl`

读取历史：

```python
h = backend.get_history("demo", {
    "maxLines": 10000,
    "tailCount": 200,
})

entries = h["entries"]
sentinel = h["sentinel"]
```

返回结构：

```json
{
  "entries": [],
  "total": 0,
  "totalApproximate": false,
  "truncated": false,
  "sentinel": {
    "primary": 1234,
    "mobius": 567
  }
}
```

继续订阅实时流：

```python
unsubscribe = backend.get_agent_raw_thought_stream(
    "demo",
    lambda raw: print(raw),
    {"fromSentinel": sentinel},
)
```

`fromSentinel` 支持两种格式：

- 数字 byte offset：旧格式，仅定位 primary JSONL。
- JSON object：新格式，形如 `{"primary": 1234, "mobius": 567}`，可同时定位 primary 和 Mobius prompt JSONL。

CLI 的 `aimax stream --from-sentinel` 同样接受数字或 JSON object 字符串。

## 任务完成标记

每次投递 prompt 时，driver 会写入：

```text
<flagRoot>/.imac/flags/<sessionId>/running.flag
```

约定如下：

- agent 完成任务后删除 `running.flag`
- agent 判断失败时写入 `failed.flag`
- `is_job_goal_accomplished(sessionId)` 在 `running.flag` 不存在时返回 true
- `is_failed(sessionId)` 在 `failed.flag` 存在时返回 true

这让外部进程不需要连接 Python driver，也可以直接通过文件系统判断状态。

## 配置

默认配置来自 `aimax.config.TmuxAgentsConfig`。最常用的是设置 `AIMAX_DATA_DIR`，把 runtime / archive / admin settings 放到指定目录。

查看当前配置：

```bash
aimax config show
aimax config show --json
```

主要环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `AIMAX_DATA_DIR` | runtime、archive、admin settings 所在目录 |
| `AIMAX_HOME` | 默认 home 根目录 |
| `AIMAX_CODEX_HOME` | Codex home，默认 `$CODEX_HOME` 或 `~/.codex` |
| `AIMAX_CLAUDE_HUB` | Claude tmux hub session 名 |
| `AIMAX_CODEX_HUB` | Codex tmux hub session 名 |
| `AIMAX_CLAUDE_CONFIG` | Claude config 文件 |
| `AIMAX_CLAUDE_SETTINGS` | Claude settings 文件 |
| `AIMAX_CLAUDE_PROJECTS_DIR` | Claude JSONL projects 目录 |
| `AIMAX_CODEX_CONFIG` | Codex config 文件 |
| `AIMAX_CODEX_AUTH` | Codex auth 文件 |
| `AIMAX_CODEX_STATE_DB` | Codex state sqlite |
| `AIMAX_CODEX_SESSIONS_DIR` | Codex sessions 目录 |
| `AIMAX_CODEX_DEFAULT_MODEL` | Codex 默认模型 |
| `AIMAX_RIGHTCODE_ENV_FILE` | rightcode 环境文件 |
| `AIMAX_PROXY_ENVS_BASH` | 代理环境 shell 文件 |
| `AIMAX_PROXY_CHAINS_CONF` | proxychains 配置 |
| `AIMAX_RUN_PREFLIGHT` | 是否执行启动前 binary 检查，`0` 可关闭 |

旧的 `TMUX_AGENTS_*` 环境变量仍然兼容。如果 `AIMAX_*` 和 `TMUX_AGENTS_*` 同时存在，优先使用 `AIMAX_*`。

在代码中覆盖配置：

```python
from pathlib import Path

import aimax
from aimax.config import AimaxConfig, set_config


set_config(AimaxConfig(
    data_dir=Path("/var/lib/aimax"),
    run_preflight=False,
))

backend = aimax.get("tmux-codex")
```

配置必须在第一次 `aimax.get(...)` 之前设置，因为 backend 构造时会读取并缓存路径。

## Admin 默认值

后端级默认代理配置保存在：

```text
<AIMAX_DATA_DIR>/admin-settings.json
```

查看：

```bash
aimax admin show
aimax admin show --json
```

设置：

```bash
aimax admin set-proxy --backend tmux-codex --value false
aimax admin set-proxy --backend tmux-claude-code --value true
```

单次调用里的 `useProxy` 会覆盖 admin 默认值。

## 兼容旧包名

推荐新代码使用：

```python
import aimax
from aimax.config import AimaxConfig
```

兼容层仍支持：

```python
import tmux_agents
```

旧 CLI 入口仍支持：

```bash
tmux-agents --help
```

但新文档、PyPI 包和环境变量都以 `aimax` / `AIMAX_*` 为准。

## 工作原理

`aimax` 不实现 headless agent，也不 screen scrape TUI 主输出。它做的事情更窄：

1. 为每个后端维护一个 tmux hub session。
2. 每个 agent session 对应 hub 中的一个 tmux window。
3. prompt 通过 `tmux load-buffer` 和 `tmux paste-buffer -p` 进入真实 TUI。
4. agent 自己持续写 JSONL，driver tail 这些 JSONL 并 fan out 到订阅者。
5. driver 额外写 `*.mobius.jsonl`，记录从 Mobius / Python / CLI 投递的 prompt。
6. Codex 如传入 `configPath`，会使用 session 专属 `CODEX_HOME`，保证配置、state DB、sessions 路径互相匹配；provider 秘钥由启动时 export 的 `env_key` 环境变量提供。
7. runtime 和 archive JSON 保存 session 到 JSONL 路径以及配置路径的映射，用于进程重启后恢复。

## 开发

安装开发依赖：

```bash
cd mobius/backend/agents_py
pip install -e '.[dev]'
```

构建：

```bash
python -m build
```

检查发布包：

```bash
python -m twine check dist/*
```

本包运行时没有第三方 Python 依赖；真正的外部依赖是本机的 `tmux`、`claude`、`codex` 和可选代理工具。

## License

MIT. See [LICENSE](LICENSE).
