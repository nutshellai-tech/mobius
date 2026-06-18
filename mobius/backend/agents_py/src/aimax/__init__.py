"""aimax — drive Claude Code and Codex TUIs through tmux from Python.

Quick start
===========

.. code-block:: python

    import asyncio
    import aimax

    async def main():
        backend = aimax.get("tmux-codex")
        await backend.create_new_session({
            "sessionId": "my-session",
            "cwd": "/tmp/work",
            "initialPrompt": "List files in this directory.",
        })

    asyncio.run(main())

Supported backends
------------------

* ``"tmux-claude-code"`` — wraps Anthropic's ``claude`` TUI
  (:class:`aimax.tmux_claude_code.TmuxClaudeCodeBackend`).
* ``"tmux-codex"`` — wraps OpenAI's ``codex`` TUI
  (:class:`aimax.tmux_codex.TmuxCodexBackend`).

Each backend exposes the same async surface:

* ``create_new_session(opts)``
* ``no_pause_current_and_queue_query_at_session(opts)``
* ``pause_current_and_resume_from_session(opts)``
* ``terminate_session(session_id)``
* ``is_alive(session_id)`` / ``is_working(session_id)`` /
  ``is_job_goal_accomplished(session_id)`` / ``is_failed(session_id)``
* ``list_sessions()`` / ``get_history(session_id)`` /
  ``get_agent_raw_thought_stream(session_id, listener, opts)``

Configuration
-------------

Filesystem paths and hub names are configurable through environment
variables (see :mod:`aimax.config`) or by installing a custom
:class:`~aimax.config.TmuxAgentsConfig` *before* the first
:func:`get` call.

CLI
---

The package ships with a ``aimax`` console script — run
``aimax --help`` for a tour, or see :mod:`aimax.cli`.
"""

from __future__ import annotations

from typing import Dict

from . import config
from ._version import __version__
from .base import AgentBackend
from .config import AimaxConfig, TmuxAgentsConfig, get_config, reset_config, set_config

# Recognised backend names. Adding a new backend = extend this tuple and
# the ``get`` factory below.
SUPPORTED_BACKENDS = ("tmux-claude-code", "tmux-codex")

_singletons: Dict[str, AgentBackend] = {}


def get(name: str) -> AgentBackend:
    """Return the singleton backend named ``name``.

    First call instantiates the backend (which may do a one-shot
    preflight binary check and read the on-disk runtime mapping).
    Subsequent calls return the same instance.

    Raises
    ------
    ValueError
        ``name`` is not in :data:`SUPPORTED_BACKENDS`.
    """
    backend = _singletons.get(name)
    if backend is None:
        if name == "tmux-claude-code":
            from .tmux_claude_code import TmuxClaudeCodeBackend
            backend = TmuxClaudeCodeBackend()
        elif name == "tmux-codex":
            from .tmux_codex import TmuxCodexBackend
            backend = TmuxCodexBackend()
        else:
            raise ValueError(
                f"unknown agent backend: {name!r}. Supported: {SUPPORTED_BACKENDS}"
            )
        _singletons[name] = backend
    return backend


def reset() -> None:
    """Drop all cached singleton backends.

    Mostly useful for tests — production code rarely needs this. After
    ``reset()``, the next :func:`get` call constructs a fresh backend
    (which re-reads the runtime JSON and re-runs preflight).
    """
    _singletons.clear()


__all__ = [
    "__version__",
    "AgentBackend",
    "AimaxConfig",
    "TmuxAgentsConfig",
    "SUPPORTED_BACKENDS",
    "config",
    "get",
    "get_config",
    "set_config",
    "reset_config",
    "reset",
]
