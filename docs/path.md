# Persistent paths and configuration

Goals:

- New deployments default to persisting everything under `/data`.
- Image build copies source to `/app_image`; at runtime, copy `/app_image` to `/app` only when `/app/mobius` does not exist.
- `.codex` and `.claude` stay bound to `$HOME`, independent of `CORE_DATA_PATH` / `MOBIUS_DATA_PATH`.

## New container defaults (`.env.default`)

| Variable | Default | Contents |
|---|---|---|
| `APP_DIR` | `/app` | Runtime code directory |
| `MOBIUS_DATA_PATH` | `/data` | DB, turn summaries, model access config, agent runtime/archive, admin settings |
| `DB_PATH` | `/data/mobuis.db` | Primary SQLite database |
| `TURNS_SUMMARY_DIR` | `/data/turn-summaries` | Turn summaries |
| `MODEL_ACCESS_PATH` | `/data/model-access.json` | Admin-imported Claude Code model config |
| `WORKSPACE_ROOT` | `/data/workspace` | Bootstrap/import user workspaces |
| `HOME_WORKSPACE_ROOT` | `/data/workspace/home` | Default parent dir for admin-created employee workspaces |
| `LOCAL_WORKSPACE_ROOT` | `/data/workspace/_employees` | Local fallback employee workspaces |
| `CORE_DATA_PATH` | `/data/protected_data` | Former `<root>/protected_data` data root |
| `SHARED_SKILL_LIBRARY_DIR` | `/data/shared-skill-library` | Shared skill library (online editable) |
| `SHARED_SKILL_BACKUP_DIR` | `/data/shared-skill-library-backups` | Shared skill library edit backups |
| `CODE_SERVER_DATA_ROOT` | `/data/code_server` | code-server data parent |
| `CS_DATA_ROOT` | `/data/code_server/cs-data` | code-server user data |
| `CS_EXT_ROOT` | `/data/code_server/cs-ext` | code-server extensions |
| `CODEX_HOME` | unset (`$HOME/.codex`) | Follows the runtime user's HOME |

## Compose deployment (`deploy/.env`)

`deploy/docker-compose.yml` mounts host data; `deploy/.env` pins paths to those mount points:

| host path | container path | env |
|---|---|---|
| `host-data/data` | `/data` | `MOBIUS_DATA_PATH=/data`, `DB_PATH=/data/mobuis.db`, `MODEL_ACCESS_PATH=/data/model-access.json` |
| `host-data/workspace` | `/workspace` | `WORKSPACE_ROOT=/workspace` |
| `host-data/protected_data` | `/app/protected_data` | `CORE_DATA_PATH=/app/protected_data` |
| `host-data/imac` | `/root/.imac` | `CODE_SERVER_DATA_ROOT=/root/.imac`, `CS_DATA_ROOT=/root/.imac/cs-data`, `CS_EXT_ROOT=/root/.imac/cs-ext` |
| `host-data/codex` | `/root/.codex` | `$HOME/.codex` / `CODEX_HOME` |
| `host-data/claude` | `/root/.claude` | `$HOME/.claude` |

For a fresh deployment without legacy data, use `.env.default` `/data/*` defaults and mount only `/data`, `$HOME/.codex`, `$HOME/.claude`, etc.

## Derived paths under `CORE_DATA_PATH`

| Path | Contents |
|---|---|
| `${CORE_DATA_PATH}/extension` | Extension handler data, schedules, build/handler logs |
| `${CORE_DATA_PATH}/skills` | User/project skill file tree |
| `${CORE_DATA_PATH}/memories` | User/project memory file tree |
| `${CORE_DATA_PATH}/backend_worker_log` | Forgotten flag, blackboard delivery, tmux cleanup, version switch logs |

## Derived files under `MOBIUS_DATA_PATH`

| Path | Contents |
|---|---|
| `${MOBIUS_DATA_PATH}/mobuis.db` | Default SQLite primary DB |
| `${MOBIUS_DATA_PATH}/turn-summaries` | Turn summary directory |
| `${MOBIUS_DATA_PATH}/model-access.json` | Default model access config |
| `${MOBIUS_DATA_PATH}/admin-settings.json` | Admin panel settings |
| `${MOBIUS_DATA_PATH}/hub-runtime.json` | Claude Code live session mapping |
| `${MOBIUS_DATA_PATH}/hub-archive.json` | Claude Code session history mapping |
| `${MOBIUS_DATA_PATH}/codex-hub-runtime.json` | Codex live session mapping |
| `${MOBIUS_DATA_PATH}/codex-hub-archive.json` | Codex session history mapping |

## `$HOME`-bound items

- Codex: `$HOME/.codex` (`config.toml` machine-level base + trust sections, `auth.json` API key, `state_5.sqlite` thread index, `sessions/`, per-model `<key>.config.toml`, legacy `secrets/rightcode.env` auth path is deprecated).
- Claude: `$HOME/.claude` (`settings.api.json`, `projects/<cwd>/<sid>.jsonl`).
- Claude global trust file: `$HOME/.claude.json` — Claude CLI HOME state, not under `CORE_DATA_PATH`.

## Build / runtime code paths

- Dockerfile: `COPY . /app_image`, dependencies installed under `/app_image/mobius` and `/app_image/mobius/frontend`.
- entrypoint: if `/app/mobius` is missing, run `cp -a /app_image/. /app/`.
- Runtime: start `product.py` from `/app`.

`.dockerignore` excludes root `.env` so local secrets are not baked into the image; `.env.default` is included for container defaults.
