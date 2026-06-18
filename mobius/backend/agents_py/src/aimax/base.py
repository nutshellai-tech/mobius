"""``AgentBackend`` base class — async lock + event bus + persistence.

Every concrete backend (``TmuxClaudeCodeBackend``, ``TmuxCodexBackend``)
extends :class:`AgentBackend`. The base class supplies three shared
concerns:

#. **Per-session async lock**. Mutating operations (create, send, pause,
   terminate) on the same session are serialised; cross-session
   operations stay concurrent.
#. **Event bus**. The backend dispatches each parsed JSONL entry into a
   tiny per-session pub-sub bus, so any number of subscribers can stream
   the agent's thoughts in real time.
#. **Two-tier persistence**. A *runtime* JSON file holds the mapping for
   currently live sessions (cleared on terminate). An *archive* JSON
   file keeps every session that has ever started so historic JSONL
   paths can be resolved even after the live entry is gone.

Subclass contract
-----------------

Subclasses **must** implement:

* ``async create_new_session(opts) -> dict``
* ``async pause_current_and_resume_from_session(opts) -> None``
* ``async no_pause_current_and_queue_query_at_session(opts) -> None``
* ``async terminate_session(session_id) -> dict``
* ``is_alive(session_id) -> bool``
* ``is_working(session_id) -> bool``
* ``list_sessions() -> list[dict]``

Subclasses **may** override (defaults are sensible no-ops):

* ``get_history(session_id) -> {entries, sentinel}``
* ``get_agent_raw_thought_stream(session_id, listener, opts) -> unsubscribe()``
* ``is_job_goal_accomplished(session_id) -> bool``
* ``is_failed(session_id) -> bool``
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from collections import defaultdict
from typing import Any, Awaitable, Callable, Dict, List, Optional


# ---------------------------------------------------------------------------
# Tiny lock-free event emitter (channel-based fanout)
# ---------------------------------------------------------------------------
class _EventEmitter:
    """In-process pub/sub. Per-channel listener list, fanout by ``emit``.

    Listeners are called *synchronously* from inside ``emit``; any
    exception raised by a listener is caught and logged so a single
    misbehaving subscriber cannot break the others.
    """

    def __init__(self) -> None:
        self._listeners: Dict[str, List[Callable[..., Any]]] = defaultdict(list)
        self._lock = threading.Lock()

    def on(self, channel: str, listener: Callable[..., Any]) -> None:
        with self._lock:
            self._listeners[channel].append(listener)

    def off(self, channel: str, listener: Callable[..., Any]) -> None:
        with self._lock:
            try:
                self._listeners[channel].remove(listener)
            except ValueError:
                pass  # already removed — fine.

    def emit(self, channel: str, *args, **kwargs) -> None:
        # Copy under the lock so concurrent ``on``/``off`` calls do not
        # break iteration. Listeners themselves run *outside* the lock.
        with self._lock:
            listeners = list(self._listeners.get(channel, ()))
        for ln in listeners:
            try:
                ln(*args, **kwargs)
            except Exception as e:  # pragma: no cover — defensive
                print(f"[event-emitter] listener on {channel} raised: {e}")


# ---------------------------------------------------------------------------
# AgentBackend
# ---------------------------------------------------------------------------
class AgentBackend:
    """Shared infrastructure for every concrete backend.

    Parameters
    ----------
    name:
        Logical backend name (``"tmux-claude-code"``, ``"tmux-codex"``).
        Used in log prefixes and runtime records.
    runtime_file:
        Absolute path to the *live* mapping JSON. Removed on terminate.
    archive_file:
        Absolute path to the *all-time* mapping JSON. Never removed; the
        live entries are mirrored here at write time so historic JSONL
        paths can be looked up after admin closes a window. Pass
        ``None`` to disable archiving.
    """

    def __init__(
        self,
        name: str,
        runtime_file: str | os.PathLike[str],
        archive_file: Optional[str | os.PathLike[str]] = None,
    ) -> None:
        self.name = name
        self.runtime_file = str(runtime_file)
        self.archive_file = str(archive_file) if archive_file else None

        # ``locks`` is keyed by ``session_id``; created lazily by
        # :meth:`_get_lock`.
        self.locks: Dict[str, asyncio.Lock] = {}

        self.emitter = _EventEmitter()

        self.persisted: Dict[str, dict] = self._load_json(self.runtime_file)
        self.archive: Dict[str, dict] = (
            self._load_json(self.archive_file) if self.archive_file else {}
        )

        # One-shot catch-up: when the archive feature was added, any
        # already-running sessions only existed in ``persisted``. Copy
        # them across so historic jsonl-path lookups work for them too.
        if self.archive_file:
            dirty = False
            for sid, p in list(self.persisted.items()):
                if sid not in self.archive:
                    self.archive[sid] = dict(p)
                    dirty = True
            if dirty:
                self._save_archive()

    # ------------------------------------------------------------------
    # Per-session asyncio lock
    # ------------------------------------------------------------------
    def _get_lock(self, session_id: Optional[str]) -> asyncio.Lock:
        # ``""`` is the catch-all key for cases where the caller did not
        # supply a session id (which the concrete backends rarely do, but
        # we tolerate it rather than crashing).
        key = session_id or ""
        lock = self.locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self.locks[key] = lock
        return lock

    async def _with_lock(
        self, session_id: Optional[str], fn: Callable[[], Awaitable[Any]]
    ) -> Any:
        """Run ``fn()`` exclusively for the given session."""
        async with self._get_lock(session_id):
            return await fn()

    # ------------------------------------------------------------------
    # Event subscription
    # ------------------------------------------------------------------
    def get_agent_raw_thought_stream(
        self,
        session_id: str,
        listener: Callable[..., Any],
        opts: Optional[dict] = None,
    ) -> Callable[[], None]:
        """Subscribe to the live raw-event stream for ``session_id``.

        ``opts`` is reserved for subclass-specific cues — e.g. the tmux
        backends understand ``{"fromSentinel": <byte_offset>}`` to splice
        history and live into a single duplicate-free stream.

        Returns
        -------
        A zero-argument callable that, when invoked, unsubscribes the
        listener. Idempotent.
        """
        ch = f"raw:{session_id}"
        self.emitter.on(ch, listener)

        def unsubscribe() -> None:
            self.emitter.off(ch, listener)

        return unsubscribe

    def _emit_raw(self, session_id: str, raw: Any) -> None:
        """Fan ``raw`` out to every subscriber of the given session."""
        self.emitter.emit(f"raw:{session_id}", raw)

    def get_history(self, session_id: str) -> dict:
        """Return ``{entries: [...], sentinel: ...}`` for ``session_id``.

        The default returns an empty snapshot — subclasses override using
        their own JSONL files. The sentinel is whatever the subclass
        uses as a "tail from here" cursor; for the tmux backends it is
        the file byte size.
        """
        return {"entries": [], "sentinel": None}

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------
    def _load_json(self, file: Optional[str]) -> dict:
        """Read a JSON file. Returns ``{}`` for missing/corrupt files."""
        if not file:
            return {}
        try:
            if not os.path.exists(file):
                return {}
            with open(file, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except Exception as e:  # pragma: no cover — defensive
            print(f"[agents/{self.name}] load {os.path.basename(file)} failed: {e}")
            return {}

    def _save_json(self, file: str, obj: dict) -> None:
        try:
            os.makedirs(os.path.dirname(file), exist_ok=True)
            with open(file, "w", encoding="utf-8") as f:
                json.dump(obj, f, indent=2)
        except Exception as e:  # pragma: no cover — defensive
            print(f"[agents/{self.name}] save {os.path.basename(file)} failed: {e}")

    def _save_persisted(self) -> None:
        self._save_json(self.runtime_file, self.persisted)

    def _save_archive(self) -> None:
        if self.archive_file:
            self._save_json(self.archive_file, self.archive)

    def _persist_entry(self, session_id: str, partial: dict) -> None:
        """Merge ``partial`` into the entry for ``session_id`` and save both files."""
        merged = {**(self.persisted.get(session_id) or {}), **partial}
        self.persisted[session_id] = merged
        self._save_persisted()
        if self.archive_file:
            arch = {**(self.archive.get(session_id) or {}), **partial}
            self.archive[session_id] = arch
            self._save_archive()

    def _forget_persisted(self, session_id: str) -> None:
        """Remove ``session_id`` from ``persisted`` only — archive is preserved."""
        self.persisted.pop(session_id, None)
        self._save_persisted()

    def _lookup_archived_jsonl_path(self, session_id: str) -> Optional[str]:
        """Fall back to the archive when the live map has no JSONL path.

        This is the safety net for the "admin closed the window then a
        client asks for history" case.
        """
        entry = self.archive.get(session_id) if self.archive else None
        return (entry or {}).get("jsonlPath")

    # ------------------------------------------------------------------
    # Misc helpers
    # ------------------------------------------------------------------
    def get_session_use_proxy(self, session_id: str) -> Optional[bool]:
        """Return the proxy choice persisted for ``session_id``, or ``None`` if unknown.

        Reads the in-memory runtime map first (a subclass attribute
        named ``runtime``, if present), then falls back to the on-disk
        persisted map.
        """
        runtime_entry = None
        rt = getattr(self, "runtime", None)
        if rt is not None and hasattr(rt, "get"):
            runtime_entry = rt.get(session_id)
        entry = runtime_entry or (self.persisted.get(session_id) if self.persisted else None)
        if not entry:
            return None
        value = entry.get("useProxy")
        if value is None:
            value = entry.get("use_proxy")
        if value in (True, 1, "1", "true"):
            return True
        if value in (False, 0, "0", "false"):
            return False
        return None

    # ------------------------------------------------------------------
    # Default state queries (subclass overrides almost always)
    # ------------------------------------------------------------------
    def is_working(self, session_id: str) -> bool:  # noqa: ARG002
        """Is the agent currently mid-turn? Default ``False`` (don't know)."""
        return False

    def is_job_goal_accomplished(self, session_id: str) -> bool:  # noqa: ARG002
        """Did the agent's overall job finish?

        Convention: the backend writes ``running.flag`` on session start,
        the agent removes it when its job ends. The flag's *absence* is
        the signal. With no cwd context the base class returns ``False``.
        """
        return False

    def is_failed(self, session_id: str) -> bool:  # noqa: ARG002
        """Did the agent's job fail? Mirror of :meth:`is_job_goal_accomplished`."""
        return False


__all__ = ["AgentBackend"]
