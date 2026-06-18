"""Prompt-paste event recording (pluggable backend).

The Node.js original wrote a row to an SQLite table every time the
backend pasted a prompt into the agent's TUI input, then exposed
analytics queries on top of that table. The SQLite schema is owned by
the parent IMAC project and is not portable, so this module ships a
*no-op default* and lets callers plug in their own recorder.

Usage
-----

::

    from aimax.services import agent_prompt_events

    def my_recorder(event: dict) -> None:
        # event = {"backend_name": str, "session_id": str, "content_length": int}
        my_database.insert(event)

    agent_prompt_events.set_recorder(my_recorder)

After ``set_recorder`` is called, every paste through any backend in
this process will hand the event dict to your function.
"""

from __future__ import annotations

from typing import Callable, Mapping, Optional


# ---------------------------------------------------------------------------
# Window-helper constants (kept for API compatibility with the JS original)
# ---------------------------------------------------------------------------
DEFAULT_WINDOW_HOURS = 5
MAX_WINDOW_HOURS = 24 * 7  # one week


def normalize_hours(value, fallback: int = DEFAULT_WINDOW_HOURS) -> int:
    """Clamp ``value`` into ``[1, MAX_WINDOW_HOURS]`` and round to int.

    Returns ``fallback`` for ``None`` / non-numeric / non-positive input.
    """
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if not (n > 0):
        return fallback
    return int(min(max(n, 1), MAX_WINDOW_HOURS))


# ---------------------------------------------------------------------------
# Pluggable recorder
# ---------------------------------------------------------------------------
RecorderFn = Callable[[Mapping[str, object]], None]

_recorder: Optional[RecorderFn] = None


def set_recorder(fn: Optional[RecorderFn]) -> None:
    """Install a recorder. Pass ``None`` to disable recording."""
    global _recorder
    _recorder = fn


def get_recorder() -> Optional[RecorderFn]:
    """Return the currently installed recorder (or ``None``)."""
    return _recorder


def record_prompt_paste(
    *, backend_name: str, session_id: str, content_length: int
) -> bool:
    """Forward a paste event to the installed recorder.

    Returns ``True`` if a recorder consumed the event, ``False`` otherwise
    (no recorder installed, missing required field, or recorder raised).
    """
    if not backend_name or not session_id:
        return False
    if _recorder is None:
        return False
    try:
        _recorder(
            {
                "backend_name": str(backend_name),
                "session_id": str(session_id),
                "content_length": max(0, int(content_length or 0)),
            }
        )
        return True
    except Exception as e:  # pragma: no cover — defensive
        print(f"[agent-prompt-events] record failed ({backend_name}/{session_id}): {e}")
        return False


# ---------------------------------------------------------------------------
# Analytics stubs (override via a custom analytics class if needed)
# ---------------------------------------------------------------------------
def stats_since(hours: int = DEFAULT_WINDOW_HOURS) -> dict:
    """Aggregate prompt-paste statistics. Stub returns zeros.

    Override by composing your own analytics module — this is left as a
    no-op here so the package does not require a database.
    """
    return {
        "window_hours": normalize_hours(hours),
        "since": None,
        "total": 0,
        "by_backend": {},
    }


def counts_by_session_since(hours: int = DEFAULT_WINDOW_HOURS) -> dict:
    """Per-session paste counts since ``hours`` ago. Stub returns ``{}``."""
    return {}


__all__ = [
    "DEFAULT_WINDOW_HOURS",
    "MAX_WINDOW_HOURS",
    "normalize_hours",
    "set_recorder",
    "get_recorder",
    "record_prompt_paste",
    "stats_since",
    "counts_by_session_since",
]
