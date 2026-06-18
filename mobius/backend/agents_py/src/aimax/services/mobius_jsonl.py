"""Merged agent JSONL + Mobius prompt-capture JSONL helpers.

The Node.js backend keeps user prompts that Mobius submits in a sibling
``*.mobius.jsonl`` file. Histories and live streams merge that file with
the agent-owned rollout JSONL so the UI can show both native agent
events and Mobius-captured user inputs after reloads.

This module ports the same small contract to Python:

* ``read_merged_jsonl_history`` reads primary + sibling history and
  returns a two-sided sentinel ``{"primary": bytes, "mobius": bytes}``.
* ``watch_merged_jsonl`` tails both files from that sentinel.
* ``append_mobius_prompt_entry`` writes a Claude-shaped user entry into
  the sibling file.
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from . import jsonl_watcher


DEFAULT_MAX_LINES = 10_000
MOBIUS_JSONL_VERSION = 1


def mobius_jsonl_path_of(jsonl_path: Optional[str]) -> Optional[str]:
    """Return the sibling ``*.mobius.jsonl`` path for ``jsonl_path``."""
    if not jsonl_path:
        return None
    s = str(jsonl_path)
    if s.endswith(".jsonl"):
        return s[: -len(".jsonl")] + ".mobius.jsonl"
    return s + ".mobius.jsonl"


def _file_size(file_path: Optional[str]) -> int:
    if not file_path:
        return 0
    try:
        return os.path.getsize(file_path) if os.path.exists(file_path) else 0
    except OSError:
        return 0


def _parse_timestamp_ms(entry: Any) -> Optional[int]:
    if not isinstance(entry, dict):
        return None
    candidates = [
        entry.get("timestamp"),
        entry.get("created_at"),
        (entry.get("payload") or {}).get("timestamp")
        if isinstance(entry.get("payload"), dict) else None,
        (entry.get("message") or {}).get("created_at")
        if isinstance(entry.get("message"), dict) else None,
    ]
    for raw in candidates:
        if not raw:
            continue
        try:
            text = str(raw)
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            dt = datetime.fromisoformat(text)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except Exception:
            continue
    return None


def _source_order(source: str) -> int:
    return 0 if source == "primary" else 1


def _record_sort_key(record: dict) -> tuple:
    ts = _parse_timestamp_ms(record.get("entry"))
    has_ts = 1 if ts is not None else 0
    # Match JS comparator: entries without timestamps sort before
    # timestamped entries, then primary before mobius, then original index.
    return (has_ts, ts or 0, _source_order(record.get("source") or ""), record.get("index") or 0)


def _positive_int(value: Any, fallback: int) -> int:
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return n if n >= 0 else fallback


def read_merged_jsonl_history(jsonl_path: str, opts: Optional[dict] = None) -> dict:
    """Read primary + sibling Mobius JSONL history as one sorted stream."""
    opts = opts or {}
    max_lines = _positive_int(opts.get("maxLines", opts.get("max_lines", DEFAULT_MAX_LINES)), DEFAULT_MAX_LINES)
    tail_count = _positive_int(opts.get("tailCount", opts.get("tail_count", 0)), 0)
    side_opts = {**opts, "maxLines": max_lines, "tailCount": tail_count}

    primary = jsonl_watcher.read_all(jsonl_path, side_opts)
    mobius_path = mobius_jsonl_path_of(jsonl_path)
    mobius = (
        jsonl_watcher.read_all(mobius_path, side_opts)
        if mobius_path
        else {"entries": [], "total": 0, "totalApproximate": False, "truncated": False, "size": 0}
    )

    records = []
    for index, entry in enumerate(primary.get("entries") or []):
        records.append({"entry": entry, "index": index, "source": "primary"})
    for index, entry in enumerate(mobius.get("entries") or []):
        records.append({"entry": entry, "index": index, "source": "mobius"})
    records.sort(key=_record_sort_key)

    total = int(primary.get("total") or 0) + int(mobius.get("total") or 0)
    effective_limit = (
        min(max_lines, tail_count) if tail_count > 0 and max_lines > 0
        else tail_count if tail_count > 0
        else max_lines
    )
    selected = records[-effective_limit:] if effective_limit > 0 else []
    entries = [r["entry"] for r in selected]
    return {
        "entries": entries,
        "total": total,
        "totalApproximate": bool(primary.get("totalApproximate")) or bool(mobius.get("totalApproximate")),
        "truncated": total > len(entries) or bool(primary.get("truncated")) or bool(mobius.get("truncated")),
        "sentinel": {
            "primary": int(primary.get("size") or 0),
            "mobius": int(mobius.get("size") or 0),
        },
        "paths": {
            "primary": jsonl_path or None,
            "mobius": mobius_path or None,
        },
    }


def current_merged_jsonl_sentinel(jsonl_path: str) -> dict:
    """Return current byte offsets for primary + sibling files."""
    mobius_path = mobius_jsonl_path_of(jsonl_path)
    return {"primary": _file_size(jsonl_path), "mobius": _file_size(mobius_path)}


def normalize_sentinel(sentinel: Any, jsonl_path: str) -> dict:
    """Normalize numeric or dict sentinel shapes to ``{primary, mobius}``."""
    current = current_merged_jsonl_sentinel(jsonl_path)
    if isinstance(sentinel, (int, float)) and not isinstance(sentinel, bool):
        n = max(0, int(sentinel))
        return {"primary": n, "mobius": 0 if n == 0 else current["mobius"]}
    if not isinstance(sentinel, dict):
        return current

    def read_num(*keys: str) -> Optional[int]:
        for key in keys:
            raw = sentinel.get(key)
            try:
                n = int(float(raw))
            except (TypeError, ValueError):
                continue
            if n >= 0:
                return n
        return None

    primary = read_num("primary", "primarySize", "size")
    mobius = read_num("mobius", "mobiusSize")
    return {
        "primary": primary if primary is not None else current["primary"],
        "mobius": mobius if mobius is not None else current["mobius"],
    }


class _MergedWatcher:
    """Small wrapper that stops both underlying JSONL watchers."""

    def __init__(self, watchers: list) -> None:
        self._watchers = watchers

    def stop(self) -> None:
        for w in self._watchers:
            try:
                w.stop()
            except Exception:
                pass

    def state(self) -> dict:
        return {
            "primary": self._watchers[0].state() if len(self._watchers) > 0 and hasattr(self._watchers[0], "state") else None,
            "mobius": self._watchers[1].state() if len(self._watchers) > 1 and hasattr(self._watchers[1], "state") else None,
        }


def watch_merged_jsonl(
    *,
    path: str,
    start_sentinel: Any = None,
    on_entry: Callable[..., None],
    on_primary_entry: Optional[Callable[..., None]] = None,
    on_error: Optional[Callable[[Exception], None]] = None,
) -> _MergedWatcher:
    """Tail primary + sibling Mobius JSONL from ``start_sentinel``."""
    if not path or not callable(on_entry):
        raise ValueError("watch_merged_jsonl requires `path` and callable `on_entry`")
    on_error = on_error or (lambda _e: None)
    offsets = normalize_sentinel(start_sentinel, path)
    mobius_path = mobius_jsonl_path_of(path)
    watchers = []

    def primary(raw, line_no=None):
        try:
            if callable(on_primary_entry):
                on_primary_entry(raw, line_no)
        except Exception as e:
            on_error(e)
        try:
            on_entry(raw, line_no, "primary")
        except TypeError:
            on_entry(raw)

    watchers.append(jsonl_watcher.watch(
        path=path,
        start_offset=offsets["primary"],
        on_entry=primary,
        on_error=on_error,
    ))

    if mobius_path:
        def mobius(raw, line_no=None):
            try:
                on_entry(raw, line_no, "mobius")
            except TypeError:
                on_entry(raw)

        watchers.append(jsonl_watcher.watch(
            path=mobius_path,
            start_offset=offsets["mobius"],
            on_entry=mobius,
            on_error=on_error,
        ))

    return _MergedWatcher(watchers)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def prompt_kind(content: Any, explicit_kind: Optional[str] = None) -> str:
    if explicit_kind:
        return explicit_kind
    text = str(content or "").strip()
    return "compact" if text.startswith("/compact") else "user_input"


def build_mobius_user_entry(
    *,
    session_id: str,
    agent_session_id: Optional[str] = None,
    cwd: Optional[str] = None,
    backend_name: Optional[str] = None,
    content: Any = "",
    input_text: Any = None,
    request_id: Optional[str] = None,
    turn_number: Any = None,
    source: Optional[str] = None,
    user_id: Optional[str] = None,
    kind: Optional[str] = None,
    timestamp: Optional[str] = None,
) -> dict:
    """Build the Mobius-captured user entry written to sibling JSONL."""
    ts = timestamp or _now_iso()
    body = str(content or "")
    typed = None if input_text is None else str(input_text)
    try:
        turn = int(turn_number)
    except (TypeError, ValueError):
        turn = None
    resolved_kind = prompt_kind(body, kind)
    prompt_id = str(uuid.uuid4())
    return {
        "parentUuid": None,
        "isSidechain": False,
        "promptId": prompt_id,
        "type": "user",
        "message": {
            "role": "user",
            "content": body,
        },
        "uuid": str(uuid.uuid4()),
        "timestamp": ts,
        "permissionMode": "bypassPermissions",
        "userType": "external",
        "entrypoint": "mobius",
        "cwd": cwd or None,
        "sessionId": agent_session_id or session_id,
        "version": f"mobius-jsonl/{MOBIUS_JSONL_VERSION}",
        "mobius": {
            "schema_version": MOBIUS_JSONL_VERSION,
            "source": source or "session.send",
            "kind": resolved_kind,
            "backend": backend_name or None,
            "session_id": session_id or None,
            "agent_session_id": agent_session_id or None,
            "user_id": user_id or None,
            "request_id": request_id or None,
            "turn_number": turn,
            "input_text": typed,
            "content_length": len(body),
            "captured_at": ts,
        },
    }


def append_mobius_prompt_entry(*, jsonl_path: str, **entry_opts) -> dict:
    """Append one Mobius user prompt entry to the sibling JSONL file."""
    file_path = mobius_jsonl_path_of(jsonl_path)
    if not file_path:
        raise ValueError("missing original JSONL path; cannot write mobius JSONL")
    aliases = {
        "inputText": "input_text",
        "requestId": "request_id",
        "turnNumber": "turn_number",
        "userId": "user_id",
        "sessionId": "session_id",
        "agentSessionId": "agent_session_id",
        "backendName": "backend_name",
    }
    normalized = {}
    for key, value in entry_opts.items():
        normalized[aliases.get(key, key)] = value
    allowed = {
        "session_id",
        "agent_session_id",
        "cwd",
        "backend_name",
        "content",
        "input_text",
        "request_id",
        "turn_number",
        "source",
        "user_id",
        "kind",
        "timestamp",
    }
    normalized = {k: v for k, v in normalized.items() if k in allowed}
    entry = build_mobius_user_entry(**normalized)
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {"filePath": file_path, "entry": entry}


__all__ = [
    "mobius_jsonl_path_of",
    "read_merged_jsonl_history",
    "current_merged_jsonl_sentinel",
    "normalize_sentinel",
    "watch_merged_jsonl",
    "prompt_kind",
    "build_mobius_user_entry",
    "append_mobius_prompt_entry",
]
