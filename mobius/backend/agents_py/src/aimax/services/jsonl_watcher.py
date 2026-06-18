"""Tail a JSONL file line-by-line, pushing each parsed entry to a callback.

This is the package's universal "agent thought stream" mechanism. Both
Claude Code and Codex persist their conversation state as JSON Lines
files, so once we know the path we can stream events without any
language-binding to the agent process itself.

Behaviour
---------

* The file may not exist when ``watch`` is called; we poll for it.
* If the file is truncated or replaced (size shrinks), we reset to the
  start so the consumer sees the new content from the top.
* Partial trailing lines (no ``\\n`` yet) are kept in an internal buffer
  and stitched together on the next read.
* JSON parse errors on a single line are surfaced through ``on_error``
  but do not abort the watcher — subsequent lines still flow.

Implementation note
-------------------

The Node.js original used ``fs.watch``, which is a kernel-event-driven
API. Python's stdlib does not have a cross-platform equivalent that
works on all filesystems (notably network mounts and tmpfs sometimes
miss events). To keep the package dependency-free we use a simple poll
loop in a daemon thread — the poll interval defaults to 200 ms, which
matches the latency the JS version actually delivered after the
``fs.watch`` callback finally fired.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Callable, Optional


# Default poll interval for the file-watch thread. Tunable per-watcher via
# the ``poll_interval`` kwarg on :func:`watch`.
DEFAULT_POLL_INTERVAL = 0.2

# Default cap on the number of historical lines returned by :func:`read_all`.
# Picked to be "big enough that all real conversations fit" while keeping
# the in-memory footprint bounded.
DEFAULT_MAX_HISTORY_LINES = 10_000


# ---------------------------------------------------------------------------
# Internal watcher implementation
# ---------------------------------------------------------------------------
class _Watcher:
    """Background poll loop that tails ``path`` and emits parsed JSON entries.

    Most users construct this through :func:`watch`. The returned object
    only exposes :meth:`stop` and :meth:`state`; everything else is
    private.
    """

    def __init__(
        self,
        path: str,
        on_entry: Callable[..., None],
        on_error: Callable[[Exception], None],
        start_offset: int = 0,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
    ) -> None:
        self.path = path
        self.on_entry = on_entry
        self.on_error = on_error
        self.byte_offset = start_offset
        self.line_no = 0
        self.buffer = ""
        self._stopped = False
        self._poll_interval = poll_interval
        self._thread = threading.Thread(
            target=self._run, name=f"jsonl-watch:{os.path.basename(path)}", daemon=True
        )
        self._thread.start()

    # ---- public API ----------------------------------------------------
    def stop(self) -> None:
        """Signal the background thread to exit.

        Returns immediately; the thread may take up to one poll interval
        to actually wind down. Safe to call multiple times.
        """
        self._stopped = True

    def state(self) -> dict:
        """Return a debug snapshot ``{byteOffset, lineNo, hasFile}``."""
        return {
            "byteOffset": self.byte_offset,
            "lineNo": self.line_no,
            "hasFile": os.path.exists(self.path),
        }

    # ---- background loop ----------------------------------------------
    def _run(self) -> None:
        while not self._stopped:
            try:
                self._read_available()
            except Exception as e:  # pragma: no cover — defensive
                try:
                    self.on_error(e)
                except Exception:
                    pass
            # ``time.sleep`` is fine here — we're on a dedicated thread and
            # the only thing waking us is the stop flag, polled each tick.
            time.sleep(self._poll_interval)

    def _read_available(self) -> None:
        if self._stopped:
            return
        try:
            stat = os.stat(self.path)
        except OSError:
            return  # File not yet present (or removed); keep polling.

        if stat.st_size < self.byte_offset:
            # File was truncated or replaced; rewind to the top.
            self.byte_offset = 0
            self.line_no = 0
            self.buffer = ""

        if stat.st_size == self.byte_offset:
            return  # No new bytes since last poll.

        try:
            fd = os.open(self.path, os.O_RDONLY)
        except OSError as e:
            self.on_error(e)
            return
        try:
            os.lseek(fd, self.byte_offset, os.SEEK_SET)
            length = stat.st_size - self.byte_offset
            data = b""
            remaining = length
            while remaining > 0:
                chunk = os.read(fd, remaining)
                if not chunk:
                    break  # EOF reached early (file shrank mid-read)
                data += chunk
                remaining -= len(chunk)
            self.byte_offset += len(data)
            self.buffer += data.decode("utf-8", errors="replace")
        finally:
            try:
                os.close(fd)
            except OSError:  # pragma: no cover — defensive
                pass

        # Split on newline; the last fragment may be incomplete — keep it
        # in the buffer for the next read.
        lines = self.buffer.split("\n")
        self.buffer = lines.pop() if lines else ""
        for line in lines:
            if not line:
                continue  # Skip blank lines.
            self.line_no += 1
            try:
                entry = json.loads(line)
            except Exception as e:
                self.on_error(
                    Exception(f"JSON parse line {self.line_no}: {e}; raw={line[:200]}")
                )
                continue
            self._dispatch(entry)

    def _dispatch(self, entry: Any) -> None:
        """Call ``on_entry``. Tolerates both ``fn(entry)`` and ``fn(entry, line_no)`` callbacks."""
        try:
            self.on_entry(entry, self.line_no)
        except TypeError:
            # Callback wants a single positional arg — retry.
            try:
                self.on_entry(entry)
            except Exception as e:
                self.on_error(e)
        except Exception as e:
            self.on_error(e)


# ---------------------------------------------------------------------------
# Public factory
# ---------------------------------------------------------------------------
def watch(
    path: str,
    on_entry: Callable[..., None],
    on_error: Optional[Callable[[Exception], None]] = None,
    start_offset: int = 0,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
) -> _Watcher:
    """Start tailing ``path`` and return a controllable watcher.

    Parameters
    ----------
    path:
        Path to the JSONL file. May not exist yet — the watcher polls for it.
    on_entry:
        Called with each parsed JSON object. May accept either
        ``(entry,)`` or ``(entry, line_no)``.
    on_error:
        Called with each :class:`Exception` raised during reading or
        parsing. Defaults to a no-op.
    start_offset:
        Byte offset to begin tailing from. Pair this with the ``size``
        field returned by :func:`read_all` to stitch a history dump and
        a live tail together with no duplicates and no gaps.
    poll_interval:
        Seconds between filesystem polls. Lower = lower latency, higher
        CPU; default ``0.2`` s is a good balance.

    Returns
    -------
    A live :class:`_Watcher`. Call ``.stop()`` to shut it down.
    """
    if not path or not callable(on_entry):
        raise ValueError("watch requires both `path` and a callable `on_entry`")
    return _Watcher(
        path=path,
        on_entry=on_entry,
        on_error=on_error or (lambda _e: None),
        start_offset=start_offset,
        poll_interval=poll_interval,
    )


# ---------------------------------------------------------------------------
# Bulk history read
# ---------------------------------------------------------------------------
def _positive_int(value: Any, fallback: int) -> int:
    """Return a positive-ish integer option, falling back on invalid input."""
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return n if n >= 0 else fallback


def read_all(file_path: str, max_lines: Any = DEFAULT_MAX_HISTORY_LINES, **opts) -> dict:
    """Read all parseable entries from a JSONL file in one shot.

    ``max_lines`` may be either an integer or an option dict. The dict
    shape mirrors the Node.js helper enough for driver parity:
    ``{"maxLines": 10000, "tailCount": 200}``. ``tailCount`` is an
    additional cap applied from the end of the file.

    Returns
    -------
    dict with keys:
        * ``entries`` — list of parsed JSON objects (oldest → newest, capped at ``max_lines``)
        * ``total`` — total number of non-empty lines in the file
        * ``totalApproximate`` — always ``False`` in the stdlib Python reader
        * ``truncated`` — ``True`` iff ``total`` exceeded ``max_lines``
        * ``size`` — the file's byte length at read time, suitable as
          :func:`watch`'s ``start_offset`` for a seamless follow-up tail.
    """
    if isinstance(max_lines, dict):
        opts = {**max_lines, **opts}
        max_lines = opts.get("maxLines", opts.get("max_lines", DEFAULT_MAX_HISTORY_LINES))
    tail_count = _positive_int(opts.get("tailCount", opts.get("tail_count", 0)), 0)
    max_lines = _positive_int(max_lines, DEFAULT_MAX_HISTORY_LINES)

    if not os.path.exists(file_path):
        return {
            "entries": [],
            "total": 0,
            "totalApproximate": False,
            "truncated": False,
            "size": 0,
        }
    # Read as bytes first to capture the exact byte count — this is what
    # the watcher needs as its start offset to avoid replaying history.
    with open(file_path, "rb") as f:
        buf = f.read()
    size = len(buf)
    text = buf.decode("utf-8", errors="replace")
    lines = [ln for ln in text.split("\n") if ln]
    total = len(lines)
    effective_limit = (
        min(max_lines, tail_count) if tail_count > 0 and max_lines > 0
        else tail_count if tail_count > 0
        else max_lines
    )
    slice_ = lines[-effective_limit:] if effective_limit > 0 else []
    entries = []
    for line in slice_:
        try:
            entries.append(json.loads(line))
        except Exception:
            # Skip unparseable lines silently here — they would have been
            # surfaced through `watch`'s `on_error` during live tailing.
            pass
    return {
        "entries": entries,
        "total": total,
        "totalApproximate": False,
        "truncated": total > len(slice_),
        "size": size,
    }


__all__ = ["watch", "read_all", "DEFAULT_POLL_INTERVAL", "DEFAULT_MAX_HISTORY_LINES"]
