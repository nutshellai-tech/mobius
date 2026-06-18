"""``TmuxClaudeCodeBackend`` — drive the ``claude`` TUI inside tmux.

How it fits together
====================

* A single long-lived tmux session (default name
  ``imac_claude_code_agent_hub``) hosts every Claude-Code agent. Each
  conversational session is one tmux *window* whose name is the
  IMAC-side session id, so we can address it directly without
  remembering tmux indices.
* Inside each window we exec ``claude --dangerously-skip-permissions``
  (optionally wrapped in ``proxychains``). The TUI runs interactively
  and persists its conversation as a JSONL file at
  ``~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl``.

I/O conventions
---------------

* **Writing user input** is a four-step dance: ``tmux load-buffer`` →
  ``tmux paste-buffer -p`` (bracketed paste so embedded ``\\n`` don't
  prematurely submit) → screen-capture probe to confirm the paste
  landed → ``tmux send-keys Enter`` three times (the TUI silently
  swallows the first Enter while switching modes).
* **Reading agent output** is a JSONL tail. One shared watcher per
  session emits each new entry through :meth:`AgentBackend._emit_raw`.
  Subscribers can either rely on the shared stream or open their own
  watcher from an arbitrary byte offset for catch-up.
* **Interrupting** sends ``C-c`` three times (idempotent — extra Ctrl-C's
  on an empty prompt are no-ops).
* **Killing** is ``tmux kill-window``.

Cross-process persistence
-------------------------

The runtime mapping (session id → claude uuid → JSONL path) is mirrored
to ``hub-runtime.json`` so that restarting *our* backend does not kill
the still-alive ``claude`` TUIs. On the next startup we reconnect the
tail watchers without touching the agent processes.

Job-completion convention
-------------------------

Every prompt submission writes ``running.flag`` (see
:mod:`aimax.utils.session_flags`). The agent removes the flag
when its job finishes. :meth:`is_job_goal_accomplished` simply asks
whether the file is still on disk.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import uuid
from typing import Any, Dict, List, Optional

from .base import AgentBackend
from .config import get_config
from .services.mobius_jsonl import (
    append_mobius_prompt_entry,
    read_merged_jsonl_history,
    watch_merged_jsonl,
)
from .services.agent_prompt_events import record_prompt_paste
from .utils.session_flags import (
    failed_flag_path_of,
    running_flag_path_of,
    safe_remove_flag_dir,
    safe_remove_running_flag,
    safe_write_running_flag,
)


# ---------------------------------------------------------------------------
# Timing & sentinel constants
# ---------------------------------------------------------------------------
# Bottom-bar text we wait for to confirm the TUI is fully up.
READY_POLL_MS = 250
READY_TIMEOUT_MS = 25_000
READY_SENTINEL = "bypass permissions on"

# First-time-in-this-cwd trust dialog. ``--dangerously-skip-permissions``
# does *not* bypass it. We try to pre-write trust into ``~/.claude.json``;
# if that fails we screen-scrape for the dialog text and press Enter.
TRUST_PROMPT_SENTINELS = (
    "trust this folder",
    "Is this a project you created or one you trust",
    "Do you trust the files",
)
TRUST_PRESS_INTERVAL_MS = 1500

# Paste-landed verification: we look for an ASCII tail of the pasted text
# in the captured pane content. If the marker never appears within the
# timeout we still send Enter (best-effort; users can retry).
PASTE_PROBE_TIMEOUT_MS = 8_000
PASTE_PROBE_INTERVAL_MS = 200
PASTE_SLEEP_BASE_MS = 800
PASTE_SLEEP_MAX_MS = 5_000

# The TUI occasionally swallows the first Enter after a bracketed paste
# while switching to "submit" mode. Sending Enter three times with a gap
# is idempotent (extra Enters on an empty input box are no-ops) and
# eliminates the swallow.
SUBMIT_ENTER_ATTEMPTS = 3
SUBMIT_ENTER_INTERVAL_MS = 500

# Initial context prompts are sometimes the first thing a freshly-opened
# Claude TUI sees. The JS driver randomises a tiny greeting/delay plan to
# reduce first-message swallowing around the TUI readiness boundary.
INITIAL_CONTEXT_DELAY_MS = 5_000
INITIAL_CONTEXT_GREETING_CHOICES = ("hello", "greeting", "are you there", "good day")


# ---------------------------------------------------------------------------
# Stateless module-level helpers
# ---------------------------------------------------------------------------
def tmux(args: List[str], *, input: Optional[str] = None) -> subprocess.CompletedProcess:
    """Run ``tmux <args>``. Returns the CompletedProcess.

    ``input`` is forwarded as the child's stdin (text, UTF-8). The name
    intentionally shadows :func:`subprocess.run`'s kwarg.
    """
    return subprocess.run(
        ["tmux", *args],
        input=input,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def hub_exists(hub: str) -> bool:
    return tmux(["has-session", "-t", hub]).returncode == 0


def ensure_hub(hub: str) -> None:
    """Create the tmux hub session if it does not exist."""
    if hub_exists(hub):
        return
    r = tmux(["new-session", "-d", "-s", hub, "-n", "_root"])
    if r.returncode != 0:
        raise RuntimeError(f"tmux new-session failed: {r.stderr}")
    print(f"[tmux-claude-code] created tmux session {hub}")


def window_exists(hub: str, name: str) -> bool:
    r = tmux(["list-windows", "-t", hub, "-F", "#{window_name}"])
    if r.returncode != 0:
        return False
    return name in r.stdout.split("\n")


# ``claude`` derives the project directory name from cwd by replacing
# every non-alphanumeric character with ``-``. E.g.
# ``/home/u/cc-workspace/foo_bar`` → ``-home-u-cc-workspace-foo-bar``.
_CWD_REPLACE_RE = re.compile(r"[^a-zA-Z0-9]")


def encode_cwd(cwd: str) -> str:
    """Encode a cwd path into ``claude``'s project directory naming convention."""
    return _CWD_REPLACE_RE.sub("-", cwd)


def jsonl_path_of(claude_projects_dir: str, cwd: str, claude_session_id: str) -> str:
    """Build the JSONL path for a given (cwd, session_id) pair."""
    return os.path.join(claude_projects_dir, encode_cwd(cwd), f"{claude_session_id}.jsonl")


def shell_quote(s: Any) -> str:
    """POSIX single-quote escape for safe inclusion in a ``bash -lc`` string."""
    return "'" + str(s).replace("'", "'\\''") + "'"


def normalize_use_proxy(value: Any, fallback: bool = False) -> bool:
    """Coerce arbitrary truthy/falsy input into a strict ``bool``."""
    if value in (False, 0, "0", "false"):
        return False
    if value in (True, 1, "1", "true"):
        return True
    return bool(fallback)


def _which(bin_name: str) -> Optional[str]:
    return shutil.which(bin_name)


def proxy_prereq_missing(proxy_envs: str, proxy_conf: str) -> List[str]:
    """Return a list of missing proxychains prerequisites (files + binary)."""
    missing: List[str] = []
    if not os.path.exists(proxy_envs):
        missing.append(f"file: {proxy_envs}")
    if not os.path.exists(proxy_conf):
        missing.append(f"file: {proxy_conf}")
    if not _which("proxychains"):
        missing.append("bin (PATH): proxychains")
    return missing


def assert_proxy_available(proxy_envs: str, proxy_conf: str) -> None:
    """Raise if any proxychains prerequisite is missing."""
    missing = proxy_prereq_missing(proxy_envs, proxy_conf)
    if missing:
        raise RuntimeError(
            "use_proxy=true but proxy prerequisites are missing: " + ", ".join(missing)
        )


# ---------------------------------------------------------------------------
# Pre-trust helper (write into ~/.claude.json)
# ---------------------------------------------------------------------------
def ensure_project_trusted(claude_config: str, cwd: str) -> bool:
    """Mark ``cwd`` as trusted in ``~/.claude.json``.

    Idempotent: returns ``True`` early if already trusted. Atomic via
    ``tmp + os.replace``. Failures are logged and the screen-scrape
    fallback in :meth:`TmuxClaudeCodeBackend._spawn_window` will handle
    the dialog.
    """
    try:
        abs_cwd = os.path.abspath(cwd)
        if not os.path.exists(claude_config):
            return False
        with open(claude_config, "r", encoding="utf-8") as f:
            j = json.load(f)
        if not isinstance(j.get("projects"), dict):
            j["projects"] = {}
        cur = j["projects"].get(abs_cwd)
        if isinstance(cur, dict) and cur.get("hasTrustDialogAccepted") is True:
            return True
        j["projects"][abs_cwd] = {**(cur or {}), "hasTrustDialogAccepted": True}
        tmp = f"{claude_config}.tmp-{os.getpid()}-{int(time.time() * 1000)}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(j, f, indent=2)
        os.replace(tmp, claude_config)
        print(f"[tmux-claude-code] pre-trusted project: {abs_cwd} → {claude_config}")
        return True
    except Exception as e:
        print(f"[tmux-claude-code] pre-trust failed (will fall back to screen prompt): {e}")
        return False


# ---------------------------------------------------------------------------
# ASCII tail marker (paste-landed probe)
# ---------------------------------------------------------------------------
_ASCII_RE = re.compile(r"[\x20-\x7E]")


def find_ascii_tail_marker(text: str) -> Optional[str]:
    """Return the trailing 5–15 ASCII characters of ``text``, or ``None``.

    Used as a probe substring in the tmux pane capture: if we see it
    rendered, the paste has actually landed in the TUI input box.
    Wide/CJK characters are stripped because they may not round-trip
    through tmux pane rendering byte-for-byte.
    """
    i = len(text) - 1
    # Skip trailing whitespace — Enter etc. won't be visible in pane.
    while i >= 0 and text[i].isspace():
        i -= 1
    tail = ""
    while i >= 0 and len(tail) < 15:
        if not _ASCII_RE.match(text[i]):
            break
        tail = text[i] + tail
        i -= 1
    return tail if len(tail) >= 5 else None


# ---------------------------------------------------------------------------
# Preflight (runs at import time unless disabled in config)
# ---------------------------------------------------------------------------
def _preflight(cfg) -> None:
    missing = []
    for b in ("tmux", "claude"):
        if not _which(b):
            missing.append(f"bin (PATH): {b}")
    if missing:
        print("[tmux-claude-code] ❌ preflight failed, refusing to start:", file=sys.stderr)
        for m in missing:
            print("   - " + m, file=sys.stderr)
        sys.exit(1)
    pm = proxy_prereq_missing(str(cfg.proxy_envs_bash), str(cfg.proxy_chains_conf))
    if pm:
        print(
            "[tmux-claude-code] ⚠️  proxychains prerequisites incomplete; "
            "use_proxy=false sessions still work direct: " + ", ".join(pm)
        )
    print(f"[tmux-claude-code] ✅ preflight pass (HUB={cfg.claude_hub})")


# Run preflight on import. Disable by setting
# ``AIMAX_RUN_PREFLIGHT=0`` or pre-installing a config with
# ``run_preflight=False``.
_CFG = get_config()
if _CFG.run_preflight:
    try:
        _preflight(_CFG)
    except SystemExit:
        raise
    except Exception as e:  # pragma: no cover — defensive
        print(f"[tmux-claude-code] preflight warning: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Internal: async sleep + monotonic clock
# ---------------------------------------------------------------------------
async def _sleep_ms(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


def _now_ms() -> int:
    return int(time.time() * 1000)


def pick_initial_context_plan() -> str:
    roll = random.random()
    if roll < 1 / 3:
        return "greeting_then_context"
    if roll < 2 / 3:
        return "direct_context"
    return "delay_then_context"


def pick_initial_context_greeting() -> str:
    return random.choice(INITIAL_CONTEXT_GREETING_CHOICES)


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
class TmuxClaudeCodeBackend(AgentBackend):
    """Concrete :class:`AgentBackend` driving the ``claude`` TUI."""

    def __init__(self) -> None:
        cfg = get_config()
        # Cache config-derived paths so per-call lookups are cheap.
        self.cfg = cfg
        self.hub = cfg.claude_hub
        self.proxy_envs = str(cfg.proxy_envs_bash)
        self.proxy_conf = str(cfg.proxy_chains_conf)
        self.claude_projects_dir = str(cfg.claude_projects_dir)
        self.claude_config_path = str(cfg.claude_config)
        self.claude_settings_path = str(cfg.claude_settings)

        super().__init__(
            name="tmux-claude-code",
            runtime_file=cfg.claude_runtime_file(),
            archive_file=cfg.claude_archive_file(),
        )

        # ``runtime`` is keyed by session_id and holds the entry shape
        # ``{agent_session_id, cwd, flag_root, model, use_proxy,
        #    display_name, jsonl_path, started_at, watch}``.
        self.runtime: Dict[str, dict] = {}
        self._restore_from_persisted()

    # ------------------------------------------------------------------
    # Persistence → runtime
    # ------------------------------------------------------------------
    def _restore_from_persisted(self) -> None:
        """Rebuild ``runtime`` from the on-disk live mapping.

        ``claude`` TUIs survive a backend restart inside tmux; this
        method reconnects to them without killing anything.
        """
        total = 0
        for sid, p in (self.persisted or {}).items():
            total += 1
            if not p or not p.get("jsonlPath") or not os.path.exists(p["jsonlPath"]):
                print(
                    f"[tmux-claude-code] runtime entry {sid} dropped "
                    f"(jsonl missing: {p and p.get('jsonlPath')})"
                )
                continue
            self.runtime[sid] = {
                "agent_session_id": p.get("agentSessionId"),
                "cwd": p.get("cwd"),
                "flag_root": p.get("flagRoot") or p.get("cwd"),
                "model": p.get("model"),
                "use_proxy": normalize_use_proxy(p.get("useProxy"), False),
                "settings_path": p.get("settingsPath"),
                "force_no_proxy": bool(p.get("forceNoProxy")),
                "display_name": p.get("displayName"),
                "jsonl_path": p.get("jsonlPath"),
                "started_at": p.get("startedAt") or 0,
                "watch": None,
            }
            self._ensure_watcher(sid)
        print(f"[tmux-claude-code] runtime loaded {len(self.runtime)}/{total}")

    def _ensure_watcher(self, session_id: str) -> None:
        """Attach the shared JSONL watcher for ``session_id`` (idempotent)."""
        entry = self.runtime.get(session_id)
        if not entry or not entry.get("jsonl_path") or entry.get("watch"):
            return

        def on_entry(raw, _line_no=None):
            self._emit_raw(session_id, raw)

        def on_error(e):
            print(f"[tmux-claude-code/watch {session_id}] {e}")

        entry["watch"] = watch_merged_jsonl(
            path=entry["jsonl_path"],
            start_sentinel=None,
            on_entry=on_entry,
            on_error=on_error,
        )

    # ------------------------------------------------------------------
    # Public API (lock-wrapped delegates)
    # ------------------------------------------------------------------
    async def create_new_session(self, opts: dict) -> dict:
        """Spawn a new session and submit ``initialPrompt``.

        ``opts`` keys (camelCase, mirroring the JS API):
            * ``sessionId`` (str, required)
            * ``cwd`` (str, required)
            * ``initialPrompt`` (str, required)
            * ``flagRoot`` (str, optional) — defaults to ``cwd``
            * ``model`` (str, optional)
            * ``useProxy`` (bool, optional) — defaults to direct/no proxy
            * ``displayName`` (str, optional)
            * ``agentSessionId`` (str, optional) — resume an existing claude uuid

        Returns ``{sessionId, agentSessionId, jsonlPath, startedAt}``.
        """
        return await self._with_lock(opts.get("sessionId"), lambda: self._create_impl(opts))

    async def pause_current_and_resume_from_session(self, opts: dict) -> None:
        """Interrupt the current turn (3× C-c). If ``prompt`` is set, resend it afterwards."""
        await self._with_lock(opts.get("sessionId"), lambda: self._pause_impl(opts))

    async def no_pause_current_and_queue_query_at_session(self, opts: dict) -> None:
        """Append ``prompt`` without interrupting. Spawns the window if necessary."""
        await self._with_lock(opts.get("sessionId"), lambda: self._queue_impl(opts))

    async def terminate_session(self, session_id: str) -> dict:
        """Kill the tmux window and drop the runtime entry.

        Returns ``{sessionId, killed, wasWorking}``.
        """
        return await self._with_lock(session_id, lambda: self._terminate_impl(session_id))

    # ------------------------------------------------------------------
    # Non-mutating status (concurrent-safe — no lock)
    # ------------------------------------------------------------------
    def is_alive(self, session_id: str) -> bool:
        """Is the tmux window still present?"""
        return window_exists(self.hub, session_id)

    def is_working(self, session_id: str) -> bool:
        """Is the agent mid-turn?

        Reads the tail of the JSONL file and applies a whitelist scan —
        only ``user`` / ``assistant`` / ``system+(init|hook_*)`` change
        the verdict; future metadata types are skipped so they cannot
        break the judgement.
        """
        if not self.is_alive(session_id):
            return False
        entry = self.runtime.get(session_id)
        if not entry or not entry.get("jsonl_path"):
            return False
        jp = entry["jsonl_path"]
        try:
            if not os.path.exists(jp):
                return False
            stat = os.stat(jp)
            if stat.st_size == 0:
                return False
            length = min(stat.st_size, 16 * 1024)
            with open(jp, "rb") as f:
                f.seek(stat.st_size - length)
                buf = f.read(length)
            lines = [ln for ln in buf.decode("utf-8", errors="replace").split("\n") if ln]
        except OSError:
            return False

        for i in range(len(lines) - 1, -1, -1):
            try:
                e = json.loads(lines[i])
            except Exception:
                continue
            t = e.get("type")
            if t == "assistant":
                # Missing or ``tool_use`` → still running; everything else is a stop.
                sr = (e.get("message") or {}).get("stop_reason")
                return not sr or sr == "tool_use"
            if t == "user":
                return True
            if t == "system":
                sub = e.get("subtype")
                if sub in ("init", "hook_started", "hook_response"):
                    return True
        return False

    def is_job_goal_accomplished(self, session_id: str) -> bool:
        """``running.flag`` removed by the agent → True."""
        entry = self.runtime.get(session_id)
        root = (entry or {}).get("flag_root") or (entry or {}).get("cwd")
        if not root:
            return False
        return not os.path.exists(running_flag_path_of(root, session_id))

    def is_failed(self, session_id: str) -> bool:
        """``failed.flag`` present → True."""
        entry = self.runtime.get(session_id)
        root = (entry or {}).get("flag_root") or (entry or {}).get("cwd")
        if not root:
            return False
        return os.path.exists(failed_flag_path_of(root, session_id))

    def list_sessions(self) -> list:
        """Return one dict per tmux window in the hub.

        Each entry: ``{sessionId, agentSessionId, pid, index,
        lastActivityMs, lastActivityAt, tmuxOpen, paneDead,
        paneCurrentCommand}``.
        """
        fmt = (
            "#{window_name}|#{pane_pid}|#{window_index}|"
            "#{window_activity}|#{pane_dead}|#{pane_current_command}"
        )
        r = tmux(["list-windows", "-t", self.hub, "-F", fmt])
        if r.returncode != 0:
            return []
        from datetime import datetime, timezone
        out = []
        for line in (r.stdout or "").strip().split("\n"):
            if not line:
                continue
            parts = line.split("|")
            if len(parts) < 6:
                continue
            name, pid, idx, activity, pane_dead, pane_current_command = parts[:6]
            entry = self.runtime.get(name)
            try:
                last_activity_sec = float(activity)
            except ValueError:
                last_activity_sec = 0
            last_activity_ms = int(last_activity_sec * 1000) if last_activity_sec > 0 else None
            last_iso = (
                datetime.fromtimestamp(last_activity_ms / 1000, tz=timezone.utc).isoformat()
                if last_activity_ms
                else None
            )
            out.append({
                "sessionId": name,
                "agentSessionId": (entry or {}).get("agent_session_id"),
                "pid": int(pid) if pid.isdigit() else None,
                "index": int(idx) if idx.isdigit() else None,
                "lastActivityMs": last_activity_ms,
                "lastActivityAt": last_iso,
                "tmuxOpen": True,
                "paneDead": pane_dead == "1",
                "paneCurrentCommand": pane_current_command or None,
            })
        return out

    # ------------------------------------------------------------------
    # JSONL path resolution + history
    # ------------------------------------------------------------------
    def _resolve_jsonl_path(self, session_id: str) -> Optional[str]:
        """Look up the JSONL path through runtime → persisted → archive."""
        e = self.runtime.get(session_id) or {}
        if e.get("jsonl_path"):
            return e["jsonl_path"]
        p = self.persisted.get(session_id) or {}
        if p.get("jsonlPath"):
            return p["jsonlPath"]
        return self._lookup_archived_jsonl_path(session_id)

    def get_history(self, session_id: str, opts: Optional[dict] = None) -> dict:
        """Return the full conversation history as a snapshot dict.

        Pairs with :meth:`get_agent_raw_thought_stream` via the
        ``fromSentinel`` cursor.
        """
        jp = self._resolve_jsonl_path(session_id)
        if not jp:
            return {"entries": [], "total": 0, "truncated": False, "sentinel": 0}
        r = read_merged_jsonl_history(jp, opts or {})
        return {
            "entries": r["entries"],
            "total": r["total"],
            "totalApproximate": r.get("totalApproximate", False),
            "truncated": r["truncated"],
            "sentinel": r["sentinel"],
        }

    def get_agent_raw_thought_stream(self, session_id, listener, opts=None):
        """Subscribe to the live thought stream.

        If ``opts["fromSentinel"]`` is present (byte offset or merged
        sentinel dict, as
        returned by :meth:`get_history`), this opens a *private* watcher
        seeking from that offset — so the subscriber can stitch history
        and live with zero duplicate or missing entries.
        Otherwise it falls back to the shared event-bus subscription
        provided by :class:`AgentBackend`.
        """
        opts = opts or {}
        from_sentinel = opts.get("fromSentinel")
        if from_sentinel is not None:
            jp = self._resolve_jsonl_path(session_id)
            if not jp:
                return super().get_agent_raw_thought_stream(session_id, listener, opts)
            w = watch_merged_jsonl(
                path=jp,
                start_sentinel=from_sentinel,
                on_entry=lambda raw, _ln=None: listener(raw),
                on_error=lambda e: print(f"[tmux-claude-code/sub {session_id}] {e}"),
            )

            def unsubscribe():
                try:
                    w.stop()
                except Exception:  # pragma: no cover — defensive
                    pass

            return unsubscribe
        return super().get_agent_raw_thought_stream(session_id, listener, opts)

    def _append_mobius_prompt_entry(self, session_id: str, mobius_jsonl: Optional[dict]) -> bool:
        """Write Mobius's prompt capture into the sibling ``*.mobius.jsonl`` file."""
        if not mobius_jsonl:
            return False
        entry = self.runtime.get(session_id) or {}
        jsonl_path = entry.get("jsonl_path")
        if not jsonl_path:
            print(
                f"[tmux-claude-code] mobius jsonl skipped ({session_id}): "
                "original jsonl path missing"
            )
            return False
        try:
            opts = {
                "jsonl_path": jsonl_path,
                "session_id": session_id,
                "agent_session_id": entry.get("agent_session_id"),
                "cwd": entry.get("cwd"),
                "backend_name": self.name,
                **mobius_jsonl,
            }
            append_mobius_prompt_entry(**opts)
            return True
        except Exception as e:
            print(f"[tmux-claude-code] mobius jsonl append failed ({session_id}): {e}")
            return False

    # ------------------------------------------------------------------
    # Mutating implementations (each runs under the per-session lock)
    # ------------------------------------------------------------------
    async def _create_impl(self, opts: dict) -> dict:
        session_id = opts.get("sessionId")
        cwd = opts.get("cwd")
        flag_root = opts.get("flagRoot")
        model = opts.get("model")
        use_proxy = opts.get("useProxy")
        display_name = opts.get("displayName")
        initial_prompt = opts.get("initialPrompt")
        agent_session_id = opts.get("agentSessionId")
        is_initial_context_prompt = bool(opts.get("isInitialContextPrompt", False))
        settings_path = (
            opts.get("settingsPath")
            or opts.get("claudeSettingsPath")
            or opts.get("settingsJsonPath")
        )
        force_no_proxy = bool(opts.get("forceNoProxy", False))

        if not session_id or not cwd:
            raise ValueError("create_new_session requires sessionId + cwd")
        if not initial_prompt:
            raise ValueError("create_new_session requires initialPrompt")
        if not os.path.exists(cwd):
            raise FileNotFoundError(f"cwd does not exist: {cwd}")

        # If a window already exists for this session id, reuse it
        # rather than killing — tmux windows survive backend restarts.
        if not window_exists(self.hub, session_id):
            await self._spawn_window(
                session_id=session_id,
                cwd=cwd,
                flag_root=flag_root,
                model=model,
                use_proxy=use_proxy,
                display_name=display_name,
                agent_session_id=agent_session_id,
                settings_path=settings_path,
                force_no_proxy=force_no_proxy,
            )
        elif session_id not in self.runtime and agent_session_id:
            # Window exists but our runtime map is empty (first reload
            # since the entry was lost). Bootstrap from caller-supplied info.
            jp = jsonl_path_of(self.claude_projects_dir, cwd, agent_session_id)
            final_settings_path = os.path.abspath(settings_path) if settings_path else None
            final_force_no_proxy = bool(force_no_proxy) or bool(final_settings_path)
            final_use_proxy = (
                False if final_force_no_proxy
                else normalize_use_proxy(
                    use_proxy, False
                )
            )
            self.runtime[session_id] = {
                "agent_session_id": agent_session_id,
                "cwd": cwd,
                "flag_root": flag_root or cwd,
                "model": model,
                "use_proxy": final_use_proxy,
                "settings_path": final_settings_path,
                "force_no_proxy": final_force_no_proxy,
                "display_name": display_name,
                "jsonl_path": jp,
                "started_at": _now_ms(),
                "watch": None,
            }
            self._persist_entry(session_id, {
                "agentSessionId": agent_session_id,
                "cwd": cwd,
                "flagRoot": flag_root or cwd,
                "model": model,
                "useProxy": final_use_proxy,
                "settingsPath": final_settings_path,
                "forceNoProxy": final_force_no_proxy,
                "displayName": display_name,
                "jsonlPath": jp,
                "startedAt": _now_ms(),
            })
            self._ensure_watcher(session_id)

        entry = self.runtime.get(session_id) or {}
        await self._send_maybe_initial_context_prompt(
            session_id, initial_prompt, is_initial_context_prompt
        )
        safe_write_running_flag(
            flag_root or entry.get("flag_root") or entry.get("cwd") or cwd,
            session_id, {}, "tmux-claude-code",
        )
        return {
            "sessionId": session_id,
            "agentSessionId": entry.get("agent_session_id"),
            "jsonlPath": entry.get("jsonl_path"),
            "startedAt": entry.get("started_at") or _now_ms(),
            "settingsPath": entry.get("settings_path"),
        }

    async def _queue_impl(self, opts: dict) -> None:
        """Send ``prompt``; spawn the window first if needed."""
        session_id = opts.get("sessionId")
        prompt = opts.get("prompt")
        cwd = opts.get("cwd")
        flag_root = opts.get("flagRoot")
        model = opts.get("model")
        use_proxy = opts.get("useProxy")
        display_name = opts.get("displayName")
        agent_session_id = opts.get("agentSessionId")
        is_initial_context_prompt = bool(opts.get("isInitialContextPrompt", False))
        settings_path = (
            opts.get("settingsPath")
            or opts.get("claudeSettingsPath")
            or opts.get("settingsJsonPath")
        )
        force_no_proxy = bool(opts.get("forceNoProxy", False))
        mobius_jsonl = opts.get("mobiusJsonl")

        if not session_id:
            raise ValueError("sessionId required")
        if not prompt:
            raise ValueError("prompt required")

        if not window_exists(self.hub, session_id):
            persisted = self.runtime.get(session_id) or {}
            final_cwd = cwd or persisted.get("cwd")
            final_agent_sid = agent_session_id or persisted.get("agent_session_id")
            final_settings_path = settings_path or persisted.get("settings_path")
            final_force_no_proxy = (
                bool(force_no_proxy)
                or bool(persisted.get("force_no_proxy"))
                or bool(final_settings_path)
            )
            final_use_proxy = (
                False if final_force_no_proxy
                else normalize_use_proxy(
                    use_proxy,
                    persisted.get("use_proxy")
                    if persisted.get("use_proxy") is not None
                    else False,
                )
            )
            if not final_cwd:
                raise RuntimeError(
                    f"session {session_id} has no live window and no cwd, cannot spawn"
                )
            await self._spawn_window(
                session_id=session_id,
                cwd=final_cwd,
                flag_root=flag_root or persisted.get("flag_root") or final_cwd,
                model=model or persisted.get("model"),
                use_proxy=final_use_proxy,
                settings_path=final_settings_path,
                force_no_proxy=final_force_no_proxy,
                display_name=display_name or persisted.get("display_name"),
                agent_session_id=final_agent_sid,
            )
        self._append_mobius_prompt_entry(session_id, mobius_jsonl)
        await self._send_maybe_initial_context_prompt(
            session_id, prompt, is_initial_context_prompt
        )
        entry = self.runtime.get(session_id) or {}
        safe_write_running_flag(
            flag_root or entry.get("flag_root") or entry.get("cwd") or cwd,
            session_id, {}, "tmux-claude-code",
        )

    async def _pause_impl(self, opts: dict) -> None:
        """Interrupt with C-c × 3 then (optionally) resend ``prompt``."""
        session_id = opts.get("sessionId")
        prompt = opts.get("prompt")
        cwd = opts.get("cwd")
        flag_root = opts.get("flagRoot")

        if not session_id:
            raise ValueError("sessionId required")
        persisted = self.runtime.get(session_id) or {}

        if window_exists(self.hub, session_id):
            # Three C-c bursts: the TUI swallows the first while it
            # context-switches. We use ``asyncio.sleep`` (not blocking
            # ``time.sleep``) so other coroutines still run.
            for i in range(3):
                tmux(["send-keys", "-t", f"{self.hub}:{session_id}", "C-c"])
                if i < 2:
                    await _sleep_ms(50)
            await _sleep_ms(300)  # give the TUI time to process the interrupt

        if not prompt:
            safe_remove_running_flag(
                flag_root or persisted.get("flag_root") or persisted.get("cwd") or cwd,
                session_id, "tmux-claude-code",
            )
            return

        # Resend through the queue path so respawn-if-dead logic applies.
        await self._queue_impl({
            "sessionId": session_id,
            "prompt": prompt,
            "cwd": persisted.get("cwd"),
            "flagRoot": persisted.get("flag_root"),
            "model": persisted.get("model"),
            "useProxy": persisted.get("use_proxy"),
            "displayName": persisted.get("display_name"),
            "agentSessionId": persisted.get("agent_session_id"),
        })

    async def _terminate_impl(self, session_id: str) -> dict:
        """Kill the tmux window. Returns ``{sessionId, killed, wasWorking}``."""
        was_alive = window_exists(self.hub, session_id)
        was_working = was_alive and self.is_working(session_id)
        entry = self.runtime.get(session_id)
        if entry and entry.get("watch"):
            try:
                entry["watch"].stop()
            except Exception:  # pragma: no cover — defensive
                pass
        self.runtime.pop(session_id, None)
        self._forget_persisted(session_id)
        if was_alive:
            tmux(["kill-window", "-t", f"{self.hub}:{session_id}"])
            print(
                f"[tmux-claude-code] terminate: killed window={session_id} "
                f"(wasWorking={was_working})"
            )
        # Defensive cleanup: agent should have removed running.flag itself.
        flag_root = (entry or {}).get("flag_root") or (entry or {}).get("cwd")
        if flag_root:
            safe_remove_flag_dir(flag_root, session_id, "tmux-claude-code")
        return {"sessionId": session_id, "killed": was_alive, "wasWorking": was_working}

    # ------------------------------------------------------------------
    # Window lifecycle (tmux primitives)
    # ------------------------------------------------------------------
    async def _spawn_window(
        self,
        *,
        session_id: str,
        cwd: str,
        flag_root: Optional[str],
        model: Optional[str],
        use_proxy: Any,
        display_name: Optional[str],
        agent_session_id: Optional[str],
        settings_path: Optional[str] = None,
        force_no_proxy: bool = False,
    ) -> None:
        """Create a new tmux window, exec ``claude`` inside, and wait for ready."""
        ensure_hub(self.hub)
        eff_flag_root = flag_root or cwd
        final_settings_path = os.path.abspath(settings_path) if settings_path else None
        if final_settings_path and not os.path.exists(final_settings_path):
            raise FileNotFoundError(f"Claude Code settings file does not exist: {final_settings_path}")
        final_force_no_proxy = bool(force_no_proxy) or bool(final_settings_path)
        final_use_proxy = (
            False if final_force_no_proxy
            else normalize_use_proxy(
                use_proxy, False
            )
        )
        if final_use_proxy:
            assert_proxy_available(self.proxy_envs, self.proxy_conf)

        # Resume guard: a legacy session's JSONL may not be under our
        # projects dir (older SDK link source). Detect and fall back.
        use_resume = bool(agent_session_id)
        if use_resume and not os.path.exists(
            jsonl_path_of(self.claude_projects_dir, cwd, agent_session_id)
        ):
            print(
                f"[tmux-claude-code] resume target jsonl not found ({agent_session_id}); "
                f"falling back to new session"
            )
            use_resume = False
        claude_session_id = agent_session_id if use_resume else str(uuid.uuid4())

        claude_args = [
            "--dangerously-skip-permissions",
            # Forbid the agent from stopping to ask humans — block at the
            # harness level so the TUI never even tries. Also block
            # ExitPlanMode so the agent can't stall waiting for plan approval.
            "--disallowedTools AskUserQuestion,ExitPlanMode",
            f"--resume {claude_session_id}" if use_resume else f"--session-id {claude_session_id}",
        ]
        if model:
            claude_args.append(f"--model {shell_quote(model)}")
        settings_arg = (
            f"--settings {shell_quote(final_settings_path)}"
            if final_settings_path
            else f"--settings {shell_quote(self.claude_settings_path)}"
        )

        # The ``bash -lc`` chain that the tmux window runs as PID 1.
        cmd_lines = [
            f'source {shell_quote(self.proxy_envs)}' if final_use_proxy else None,
            "unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE "
            "VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN",
            "export IS_SANDBOX=1",
            (
                f"exec proxychains -q -f {shell_quote(self.proxy_conf)} claude "
                + " ".join(claude_args)
            )
            if final_use_proxy
            else (
                f"exec claude {settings_arg} "
                + " ".join(claude_args)
            ),
        ]
        cmd = " && ".join(c for c in cmd_lines if c)

        # Pre-trust so the TUI does not present the trust dialog at all.
        ensure_project_trusted(self.claude_config_path, cwd)

        r = tmux(["new-window", "-t", self.hub, "-n", session_id, "-c", cwd, "bash", "-lc", cmd])
        if r.returncode != 0:
            raise RuntimeError(f"tmux new-window failed: {r.stderr}")
        print(
            f"[tmux-claude-code] started: window={session_id} cwd={cwd} "
            f"claude_session={claude_session_id} use_proxy={1 if final_use_proxy else 0}"
            + (f" settings={final_settings_path}" if final_settings_path else "")
        )

        # Wait for the bottom-bar "bypass permissions on" indicator.
        deadline = _now_ms() + READY_TIMEOUT_MS
        ready = False
        last_trust_press = 0
        while _now_ms() < deadline:
            cap = tmux(["capture-pane", "-pt", f"{self.hub}:{session_id}", "-p", "-S", "-200"])
            screen = cap.stdout if cap.returncode == 0 else ""
            if READY_SENTINEL in screen:
                ready = True
                break
            if any(s in screen for s in TRUST_PROMPT_SENTINELS):
                # Rate-limited re-press: the default highlight is on
                # "Yes, I trust this folder", so Enter accepts.
                now = _now_ms()
                if now - last_trust_press > TRUST_PRESS_INTERVAL_MS:
                    tmux(["send-keys", "-t", f"{self.hub}:{session_id}", "Enter"])
                    last_trust_press = now
                    print(
                        f"[tmux-claude-code] window={session_id} trust dialog detected, "
                        f"auto-confirmed (cwd={cwd})"
                    )
            await _sleep_ms(READY_POLL_MS)
        if not ready:
            tmux(["kill-window", "-t", f"{self.hub}:{session_id}"])
            raise RuntimeError(
                f"claude TUI was not ready within {READY_TIMEOUT_MS}ms (cwd={cwd})."
            )
        print(f"[tmux-claude-code] window={session_id} TUI ready")

        # Bookkeeping: runtime + persisted + archive + watcher + flag.
        jp = jsonl_path_of(self.claude_projects_dir, cwd, claude_session_id)
        self.runtime[session_id] = {
            "agent_session_id": claude_session_id,
            "cwd": cwd,
            "flag_root": eff_flag_root,
            "model": model,
            "use_proxy": final_use_proxy,
            "settings_path": final_settings_path,
            "force_no_proxy": final_force_no_proxy,
            "display_name": display_name,
            "jsonl_path": jp,
            "started_at": _now_ms(),
            "watch": None,
        }
        self._persist_entry(session_id, {
            "agentSessionId": claude_session_id,
            "cwd": cwd,
            "flagRoot": eff_flag_root,
            "model": model,
            "useProxy": final_use_proxy,
            "settingsPath": final_settings_path,
            "forceNoProxy": final_force_no_proxy,
            "displayName": display_name,
            "jsonlPath": jp,
            "startedAt": _now_ms(),
        })
        self._ensure_watcher(session_id)
        safe_write_running_flag(eff_flag_root, session_id, {}, "tmux-claude-code")

    # ------------------------------------------------------------------
    # Prompt delivery (the I/O critical path)
    # ------------------------------------------------------------------
    async def _send_maybe_initial_context_prompt(
        self, session_id: str, text: str, is_initial_context_prompt: bool
    ) -> None:
        """Send normal prompts directly; randomise first context prompt delivery."""
        if not is_initial_context_prompt:
            await self._send_prompt_to_window(session_id, text)
            return

        plan = pick_initial_context_plan()
        if plan == "greeting_then_context":
            greeting = pick_initial_context_greeting()
            print(
                f"[tmux-claude-code] initial context plan={plan} "
                f"greeting={json.dumps(greeting)} delay_ms={INITIAL_CONTEXT_DELAY_MS}"
            )
            await self._send_prompt_to_window(session_id, greeting)
            await _sleep_ms(INITIAL_CONTEXT_DELAY_MS)
            await self._send_prompt_to_window(session_id, text)
            return

        if plan == "delay_then_context":
            print(
                f"[tmux-claude-code] initial context plan={plan} "
                f"delay_ms={INITIAL_CONTEXT_DELAY_MS}"
            )
            await _sleep_ms(INITIAL_CONTEXT_DELAY_MS)
            await self._send_prompt_to_window(session_id, text)
            return

        print(f"[tmux-claude-code] initial context plan={plan}")
        await self._send_prompt_to_window(session_id, text)

    async def _send_prompt_to_window(self, session_id: str, text: str) -> None:
        """Paste ``text`` into the TUI input and submit it.

        Sequence:
            1. ``tmux load-buffer`` — stage the bytes in a named buffer.
            2. ``tmux paste-buffer -p`` — bracketed paste into the TUI.
               Bracketed is essential — without it, embedded ``\\n`` get
               interpreted as Enter and multi-line messages split.
            3. **Screen-capture probe** — wait until an ASCII tail of the
               pasted text appears in the captured pane content (proof
               the paste actually landed).
            4. ``tmux send-keys Enter`` × 3 — the TUI sometimes swallows
               the first Enter while switching modes; the retry is
               idempotent since paste(-p) is atomic.
        """
        if not window_exists(self.hub, session_id):
            raise RuntimeError(f"window {session_id} does not exist")

        marker = find_ascii_tail_marker(text)
        marker_dbg = repr(marker) if marker else "(none)"
        print(
            f"[tmux-claude-code] sendPrompt window={session_id} "
            f"len={len(text)} marker={marker_dbg}"
        )

        # Step 1: load-buffer.
        buf_name = f"aimax_{os.getpid()}_{_now_ms()}"
        r1 = tmux(["load-buffer", "-b", buf_name, "-"], input=text)
        if r1.returncode != 0:
            raise RuntimeError(f"tmux load-buffer failed: {r1.stderr}")

        # Step 2: bracketed paste (-p). ``-d`` deletes the buffer
        # afterwards so we do not leak named buffers.
        r2 = tmux([
            "paste-buffer", "-p", "-d", "-b", buf_name, "-t", f"{self.hub}:{session_id}",
        ])
        if r2.returncode != 0:
            tmux(["delete-buffer", "-b", buf_name])
            raise RuntimeError(f"tmux paste-buffer failed: {r2.stderr}")

        # Step 3: probe for the marker.
        if marker:
            deadline = _now_ms() + PASTE_PROBE_TIMEOUT_MS
            saw = False
            while _now_ms() < deadline:
                await _sleep_ms(PASTE_PROBE_INTERVAL_MS)
                pane = tmux([
                    "capture-pane", "-pt", f"{self.hub}:{session_id}", "-p", "-S", "-80",
                ])
                if pane.returncode == 0 and marker in pane.stdout:
                    saw = True
                    break
            if not saw:
                print(
                    f"[tmux-claude-code] paste marker did not appear within "
                    f"{PASTE_PROBE_TIMEOUT_MS}ms; sending Enter anyway"
                )
        else:
            # No usable ASCII tail; sleep proportional to text length.
            sleep_ms = min(PASTE_SLEEP_MAX_MS, max(PASTE_SLEEP_BASE_MS, int(len(text) * 0.5)))
            await _sleep_ms(sleep_ms)

        # Step 4: submit (three Enters).
        for i in range(SUBMIT_ENTER_ATTEMPTS):
            r = tmux(["send-keys", "-t", f"{self.hub}:{session_id}", "Enter"])
            if r.returncode != 0:
                raise RuntimeError(f"tmux send-keys Enter failed: {r.stderr}")
            if i < SUBMIT_ENTER_ATTEMPTS - 1:
                await _sleep_ms(SUBMIT_ENTER_INTERVAL_MS)

        record_prompt_paste(
            backend_name=self.name, session_id=session_id, content_length=len(text)
        )


__all__ = [
    "TmuxClaudeCodeBackend",
    "encode_cwd",
    "jsonl_path_of",
    "find_ascii_tail_marker",
    "shell_quote",
    "normalize_use_proxy",
]
