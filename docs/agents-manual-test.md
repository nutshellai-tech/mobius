# Agent manual test — final command lines

Each `createNewSession` has two layers:

1. **tmux invocation**: Node `_spawnWindow` builds tmux argv and passes the payload as a single argument to `bash -lc`.
2. **`bash -lc` payload**: The command chain run in the new tmux window; shown below without outer quoting.

Replace placeholders: `<sid>` `<cwd>` `<uuid>` `<model>`.

# Claude Code (`mobius/backend/agents/tmux-claude-code.js`)

## `createNewSession` final command line

tmux invocation:

```bash
tmux new-window -d -t imac_claude_code_agent_hub -n <sid> -c <cwd> bash -lc "<payload>"
```

### No proxy (`useProxy=false`) payload

```bash
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN &&
export IS_SANDBOX=1 &&
exec claude --dangerously-skip-permissions --disallowedTools AskUserQuestion --session-id <uuid> [--model '<model>']
```

### Proxy (`useProxy=true`) payload

```bash
source "$HOME/proxy_envs.bash" &&
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN &&
export IS_SANDBOX=1 &&
exec proxychains -q -f "$HOME/proxy_claude.conf" claude --dangerously-skip-permissions --disallowedTools AskUserQuestion --session-id <uuid> [--model '<model>']
```

> On resume, replace `--session-id <uuid>` with `--resume <uuid>` (`tmux-claude-code.js:526`). If proxy deps (`~/proxy_envs.bash`, `~/proxy_claude.conf`, `proxychains`) are missing, `assertProxyAvailable()` at `_spawnWindow:512` throws and tmux does not start.

## `listSessions` final command line

Proxy-independent:

```bash
tmux list-windows -t imac_claude_code_agent_hub -F '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}'
```

# Codex (`mobius/backend/agents/tmux-codex.js`)

## `createNewSession` final command line

tmux invocation:

```bash
tmux new-window -d -t imac_codex_agent_hub -n <sid> -c <cwd> bash -lc "<payload>"
```

Codex argv is shell-quoted per argument in Node; when args have no spaces/special chars, quoting is a no-op. `HOME` is resolved to an absolute path in Node (e.g. `$HOME`).

`<key>` is the model registry key for that model (e.g. `gpt-5.5`), resolved by `model-registry.launchOptionsForSession` and passed to `_spawnWindow`. **Fully decoupled from `useProxy`.**

### No proxy (`useProxy=false`) payload

```bash
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN &&
export IS_SANDBOX=1 &&
export <env_key>='<secret>' &&
exec codex --profile <channel> [resume] -m <model> -C <cwd> --dangerously-bypass-approvals-and-sandbox [<uuid>]
```

### Proxy (`useProxy=true`) payload

```bash
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN &&
export IS_SANDBOX=1 &&
export <env_key>='<secret>' &&
source $HOME/proxy_envs.bash &&
exec proxychains -q -f $HOME/proxy_claude.conf codex --profile <channel> [resume] -m <model> -C <cwd> --dangerously-bypass-approvals-and-sandbox [<uuid>]
```

> `--profile <channel>` loads `$CODEX_HOME/<channel>.config.toml` (per-channel TOML written by `model-access.js`); provider/base_url/model/env_key live in per-channel files; base `~/.codex/config.toml` no longer has a `model_provider` section. API key is exported via the TOML `env_key` at launch, not `auth.json`. `proxy_envs.bash` is hard-required when `useProxy=true`; missing files are caught by `assertProxyAvailable()` in `_spawnWindow`.

## `listSessions` final command line

Proxy-independent:

```bash
tmux list-windows -t imac_codex_agent_hub -F '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}'
```
