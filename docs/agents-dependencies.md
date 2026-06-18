# Agent backend external dependencies

Both backends (`tmux-claude-code.js` / `tmux-codex.js`) depend on external programs and files when starting agent processes.

Preflight legend: **hard** = missing → throw / `process.exit(1)`; **soft** = warn-only, only when `useProxy=true`; **runtime** = not checked at module load, required when actually used.

## External programs (PATH or absolute path)

| Program | claudecode | codex | Notes |
|---|---|---|---|
| `tmux` | hard | hard | All agent processes run in tmux windows |
| `claude` (CLI) | hard | — | `which claude`; TUI mode |
| `codex` (CLI) | — | hard | `which codex`; from global `@openai/codex` (`npm i -g @openai/codex`) |
| `proxychains` | soft | soft | Hard-checked by `assertProxyAvailable()` when `useProxy=true` |
| `bash` | implicit | implicit | `tmux new-window … bash -lc <cmd>` |
| `which` | implicit | implicit | Used by preflight |
| node module `better-sqlite3` | — | hard | Reads codex thread state DB; preflight checks require |

> **PATH order**: Node inherits the parent shell PATH; `bash -lc` uses login-shell PATH — they may differ. Preflight uses the former (`spawnSync('which', ['codex'])`); actual launch uses the latter. `--profile <channel>` replaced legacy `-p rightcode|plus` wrappers.

## External files

### Credentials / config

| File | claudecode | codex | Purpose |
|---|---|---|---|
| `~/.claude.json` | read+write (preset `projects.<cwd>.hasTrustDialogAccepted=true`) | — | Skip TUI trust dialog; optional, screenshot fallback exists |
| `~/.codex/config.toml` | — | read+write (append `[projects."<cwd>"] trust_level="trusted"`) | Machine-level base (network_access / disable_response_storage); **no** `model_provider` section — that lives in per-model `.config.toml` |
| `~/.codex/<channel>.config.toml` | — | read (`--profile <channel>`) | Per-channel TOML: `model_provider` / `base_url` / `wire_api` / `env_key`, materialized by `model-access.js`; channel must match `^[A-Za-z]+$` |
| Claude CLI auth | managed by `claude` CLI | — | `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY`; backend does not manage explicitly |
| `~/proxy_envs.bash` | useProxy=true: source | useProxy=true: source (hard) | Export `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` |
| `~/proxy_claude.conf` | useProxy=true: proxychains `-f` | useProxy=true: proxychains `-f` | proxychains chain definition |

### Agent-produced runtime data (backend read-only)

| File | claudecode | codex | Purpose |
|---|---|---|---|
| `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` | tail | — | Live stream; `encodeCwd` replaces non-alphanumeric with `-` |
| `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` | — | tail | Live stream; path written by codex |
| `~/.codex/state_5.sqlite` | — | better-sqlite3 read-only | Map sessionId → thread via `threads` table |

### Backend-managed (not external, listed for clarity)

| File | claudecode | codex |
|---|---|---|
| `data/hub-runtime.json` | ✓ | — |
| `data/codex-hub-runtime.json` | — | ✓ |
| `<flagRoot>/.imac/flags/<sessionId>/{running,failed}.flag` | ✓ | ✓ |

## Environment variables (injected or cleared)

| Variable | claudecode | codex | Handling |
|---|---|---|---|
| `IS_SANDBOX` | `export IS_SANDBOX=1` | same | Tell agent it runs in restricted sandbox |
| 4× `VSCODE_*` IPC vars | `unset` | `unset` | Prevent agents from using code-server IPC handles |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | useProxy=true via `proxy_envs.bash` | same | Proxy routing |
| `<env_key>` | — | `export <env_key>=<secret>` | From channel TOML, e.g. `RIGHTCODE_API_KEY`; value from admin model access config |
| `CODEX_HOME` | — | read (override, default `~/.codex`) | Anchor for config/sessions/state DB |
| `PATH` | read | read | `bash -lc` login shell resolves `claude` / `codex` / `proxychains` |

## Final launch shape (`bash -lc` inline)

**claudecode** (`_spawnWindow` line 530-538):

```bash
[source ~/proxy_envs.bash &&]    # only when useProxy=true
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN &&
export IS_SANDBOX=1 &&
exec [proxychains -q -f ~/proxy_claude.conf] claude \
  --dangerously-skip-permissions --disallowedTools AskUserQuestion \
  {--session-id <uuid> | --resume <uuid>} [--model <m>]
```

**codex** (`_spawnWindow` line 851-885):

```bash
unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN &&
export IS_SANDBOX=1 &&
[export <env_key>='<secret>' &&]
[source ~/proxy_envs.bash &&]   # useProxy=true only (hard dep; assertProxyAvailable)
exec [proxychains -q -f ~/proxy_claude.conf] codex \
  --profile <channel> [resume] -m <model> -C <cwd> --dangerously-bypass-approvals-and-sandbox [<thread-id>]
```

`<channel>` comes from the codexModels registry (e.g. `mobiusdefault`). `--profile <channel>` loads `$CODEX_HOME/<channel>.config.toml`. Export the TOML `env_key` secret before launch; `auth.json` is not used. `useProxy` is fully decoupled from channel selection.

## Preflight failure cheat sheet

- `bin (PATH): tmux` → install tmux
- `bin (PATH): claude` (claudecode only) → install Claude CLI
- `bin (PATH): codex` (codex only) → `npm i -g @openai/codex` (ensure global bin is on PATH)
- `node module: better-sqlite3` (codex only) → `npm i better-sqlite3` (backend dir)
- proxychains warnings (soft) → only affects `useProxy=true` sessions, not backend startup
