# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-06-04

### Added
- Initial public release.
- `TmuxClaudeCodeBackend` — drives the `claude` TUI through tmux.
- `TmuxCodexBackend` — drives the `codex` TUI through tmux (with
  read-only SQLite lookup against `~/.codex/state_5.sqlite`).
- `AgentBackend` base class with per-session async lock, event bus, and
  two-tier (runtime + archive) JSON persistence.
- JSONL tail watcher (`aimax.services.jsonl_watcher`) with
  configurable poll interval and history snapshot helper.
- Pluggable prompt-paste recorder
  (`aimax.services.agent_prompt_events`) — no-op by default,
  hookable via `set_recorder`.
- Persistent admin defaults
  (`aimax.services.admin_settings.set_agent_backend_default`).
- Friendly CLI under the `aimax` console script:
  `create`, `send`, `pause`, `stop`, `list`, `status`, `history`,
  `stream`, `config show`, `admin show`, `admin set-proxy`, `version`.
- Centralised configuration (`aimax.config.TmuxAgentsConfig`)
  with full environment-variable override map
  (`AIMAX_DATA_DIR`, `AIMAX_CODEX_HOME`, …).

[0.1.0]: https://pypi.org/project/aimax/0.1.0/
