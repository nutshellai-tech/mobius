"""Centralized configuration for the ``aimax`` package.

Every path or behavioural knob that was hardcoded in the original Node.js
backends lives here as a single ``TmuxAgentsConfig`` dataclass with sane
defaults and environment-variable overrides. The two backends call
:func:`get_config` once during construction (and re-read it on demand for
admin-settings) so end users can point the package at their own data
directory or proxy setup without monkey-patching.

Defaults
========

==========================  =========================================================
Knob                        Default
==========================  =========================================================
``data_dir``                ``$XDG_DATA_HOME/aimax`` (or ``~/.local/share/...``)
``home``                    ``~`` (``os.path.expanduser``)
``codex_home``              ``$CODEX_HOME`` or ``~/.codex``
``claude_config``           ``~/.claude.json``
``claude_settings``         ``~/.claude/mobiusdefault.settings.json``
``proxy_envs_bash``         ``~/proxy_envs.bash``
``proxy_chains_conf``       ``~/proxy_claude.conf``
``claude_hub``              ``imac_claude_code_agent_hub``
``codex_hub``               ``imac_codex_agent_hub``
==========================  =========================================================

All of the above can be overridden via environment variables. The full list
is in ``ENV_VAR_MAP`` at the bottom of this module. The most useful for
distribution use is ``AIMAX_DATA_DIR`` — set it to keep the runtime/
archive JSON files outside the project tree.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional


# ---------------------------------------------------------------------------
# XDG-style default data directory
# ---------------------------------------------------------------------------
def _xdg_data_home() -> Path:
    """Resolve the user's XDG data dir (``$XDG_DATA_HOME`` or fallback)."""
    raw = os.environ.get("XDG_DATA_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".local" / "share"


def _default_data_dir() -> Path:
    return _xdg_data_home() / "aimax"


def _expand(p: str | os.PathLike[str]) -> Path:
    """Expand ``~`` and environment variables, then return a Path."""
    return Path(os.path.expandvars(os.path.expanduser(str(p))))


# ---------------------------------------------------------------------------
# Config dataclass
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class TmuxAgentsConfig:
    """Immutable configuration object consumed by the backends.

    All filesystem paths are absolute :class:`pathlib.Path` instances. The
    dataclass is *frozen* so the backends can keep a reference around safely
    without worrying about mid-flight mutation; if you need to change a value
    at runtime, call :func:`set_config` with a fresh instance.
    """

    # --- Filesystem roots --------------------------------------------------
    home: Path = field(default_factory=Path.home)
    data_dir: Path = field(default_factory=_default_data_dir)
    codex_home: Path = field(
        default_factory=lambda: _expand(os.environ.get("CODEX_HOME") or "~/.codex")
    )

    # --- Tmux hub session names -------------------------------------------
    claude_hub: str = "imac_claude_code_agent_hub"
    codex_hub: str = "imac_codex_agent_hub"

    # --- Claude Code paths ------------------------------------------------
    claude_config: Path = field(default_factory=lambda: _expand("~/.claude.json"))
    claude_settings: Path = field(
        default_factory=lambda: _expand("~/.claude/mobiusdefault.settings.json")
    )
    # Where ``claude`` writes its rollout JSONL files. The on-disk layout is:
    #   <claude_projects_dir>/<encode_cwd(cwd)>/<session-id>.jsonl
    claude_projects_dir: Path = field(default_factory=lambda: _expand("~/.claude/projects"))

    # --- Codex paths ------------------------------------------------------
    codex_config: Path = field(default_factory=lambda: _expand("~/.codex/config.toml"))
    codex_state_db: Path = field(default_factory=lambda: _expand("~/.codex/state_5.sqlite"))
    codex_sessions_dir: Path = field(default_factory=lambda: _expand("~/.codex/sessions"))
    codex_default_model: str = "gpt-5.5"

    # --- Proxy assets (proxychains for Claude Code) -----------------------
    proxy_envs_bash: Path = field(default_factory=lambda: _expand("~/proxy_envs.bash"))
    proxy_chains_conf: Path = field(default_factory=lambda: _expand("~/proxy_claude.conf"))

    # --- Behaviour knobs --------------------------------------------------
    # If True, importing the backend modules will run a one-shot preflight
    # check (tmux/claude/codex binaries on PATH) and ``sys.exit(1)`` on
    # missing critical binaries. Disable for unit tests / CI hosts.
    run_preflight: bool = True

    # --- Derived paths (computed) -----------------------------------------
    def claude_runtime_file(self) -> Path:
        """Path to ``hub-runtime.json`` (live Claude-Code session mapping)."""
        return self.data_dir / "hub-runtime.json"

    def claude_archive_file(self) -> Path:
        """Path to ``hub-archive.json`` (all-time Claude-Code session mapping)."""
        return self.data_dir / "hub-archive.json"

    def codex_runtime_file(self) -> Path:
        return self.data_dir / "codex-hub-runtime.json"

    def codex_archive_file(self) -> Path:
        return self.data_dir / "codex-hub-archive.json"

    def codex_profiles_dir(self) -> Path:
        return self.data_dir / "codex-profiles"

    def admin_settings_file(self) -> Path:
        return self.data_dir / "admin-settings.json"

    def model_access_file(self) -> Path:
        """Path to ``model-access.json`` (管理员导入的模型配置注册表).

        Node 端默认在 ``$MOBIUS_DATA_PATH/model-access.json`` (通常 ``/data``).
        AIMAX 端默认跟着 ``data_dir`` 走, 保持单实例; 若两者不同, 通过
        :data:`ENV_VAR_MAP` 里的 ``AIMAX_MODEL_ACCESS_FILE`` 覆盖.
        """
        return self.data_dir / "model-access.json"


AimaxConfig = TmuxAgentsConfig


# ---------------------------------------------------------------------------
# Env-var overrides
# ---------------------------------------------------------------------------
# Map of env-var name → config attribute name. Each env var, if set, overrides
# the dataclass default. Paths are run through ``_expand`` so ``~`` and
# ``$VARS`` work. Booleans accept ``0/1/false/true`` (case-insensitive).
ENV_VAR_MAP: Mapping[str, str] = {
    "AIMAX_HOME": "home",
    "AIMAX_DATA_DIR": "data_dir",
    "AIMAX_CODEX_HOME": "codex_home",
    "AIMAX_CLAUDE_HUB": "claude_hub",
    "AIMAX_CODEX_HUB": "codex_hub",
    "AIMAX_CLAUDE_CONFIG": "claude_config",
    "AIMAX_CLAUDE_SETTINGS": "claude_settings",
    "AIMAX_CLAUDE_PROJECTS_DIR": "claude_projects_dir",
    "AIMAX_CODEX_CONFIG": "codex_config",
    "AIMAX_CODEX_STATE_DB": "codex_state_db",
    "AIMAX_CODEX_SESSIONS_DIR": "codex_sessions_dir",
    "AIMAX_CODEX_DEFAULT_MODEL": "codex_default_model",
    "AIMAX_PROXY_ENVS_BASH": "proxy_envs_bash",
    "AIMAX_PROXY_CHAINS_CONF": "proxy_chains_conf",
    "AIMAX_RUN_PREFLIGHT": "run_preflight",
    # Backward-compatible aliases from the pre-rename package.
    "TMUX_AGENTS_HOME": "home",
    "TMUX_AGENTS_DATA_DIR": "data_dir",
    "TMUX_AGENTS_CODEX_HOME": "codex_home",
    "TMUX_AGENTS_CLAUDE_HUB": "claude_hub",
    "TMUX_AGENTS_CODEX_HUB": "codex_hub",
    "TMUX_AGENTS_CLAUDE_CONFIG": "claude_config",
    "TMUX_AGENTS_CLAUDE_SETTINGS": "claude_settings",
    "TMUX_AGENTS_CLAUDE_PROJECTS_DIR": "claude_projects_dir",
    "TMUX_AGENTS_CODEX_CONFIG": "codex_config",
    "TMUX_AGENTS_CODEX_STATE_DB": "codex_state_db",
    "TMUX_AGENTS_CODEX_SESSIONS_DIR": "codex_sessions_dir",
    "TMUX_AGENTS_CODEX_DEFAULT_MODEL": "codex_default_model",
    "TMUX_AGENTS_PROXY_ENVS_BASH": "proxy_envs_bash",
    "TMUX_AGENTS_PROXY_CHAINS_CONF": "proxy_chains_conf",
    "TMUX_AGENTS_RUN_PREFLIGHT": "run_preflight",
}

_BOOL_FALSE = {"0", "false", "no", "off", ""}
_BOOL_TRUE = {"1", "true", "yes", "on"}

_PATH_ATTRS = {
    "home",
    "data_dir",
    "codex_home",
    "claude_config",
    "claude_settings",
    "claude_projects_dir",
    "codex_config",
    "codex_state_db",
    "codex_sessions_dir",
    "proxy_envs_bash",
    "proxy_chains_conf",
}


def _apply_env(cfg: TmuxAgentsConfig) -> TmuxAgentsConfig:
    """Return a new config with environment-variable overrides applied."""
    overrides: dict = {}
    for env_name, attr in ENV_VAR_MAP.items():
        raw = os.environ.get(env_name)
        if raw is None:
            continue
        if env_name.startswith("TMUX_AGENTS_") and attr in overrides:
            continue
        if attr in _PATH_ATTRS:
            overrides[attr] = _expand(raw)
        elif attr == "run_preflight":
            lower = raw.strip().lower()
            if lower in _BOOL_TRUE:
                overrides[attr] = True
            elif lower in _BOOL_FALSE:
                overrides[attr] = False
        else:
            overrides[attr] = raw
    if not overrides:
        return cfg
    # Replace returns a new frozen instance.
    from dataclasses import replace
    return replace(cfg, **overrides)


# ---------------------------------------------------------------------------
# Module-level singleton (lazy + thread-safe)
# ---------------------------------------------------------------------------
_config: Optional[TmuxAgentsConfig] = None
_lock = threading.Lock()


def get_config() -> TmuxAgentsConfig:
    """Return the active configuration, building it from env vars on first call.

    Subsequent calls return the same instance. Use :func:`set_config` to
    swap it out (useful for tests or callers that build their own dataclass).
    """
    global _config
    if _config is None:
        with _lock:
            if _config is None:
                _config = _apply_env(TmuxAgentsConfig())
    return _config


def set_config(cfg: TmuxAgentsConfig) -> None:
    """Install ``cfg`` as the active configuration.

    Must be called *before* a backend is instantiated to take effect for
    that backend's persisted/archive paths (the backend caches them at
    construction time). The admin-settings reader reads on each call, so
    swapping the config after import still affects subsequent settings
    lookups.
    """
    global _config
    with _lock:
        _config = cfg


def reset_config() -> None:
    """Drop the cached config so the next :func:`get_config` rebuilds it."""
    global _config
    with _lock:
        _config = None
