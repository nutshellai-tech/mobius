"""``TmuxCodexBackend`` — drive the ``codex`` TUI inside tmux.

This is the OpenAI Codex sibling of :mod:`aimax.tmux_claude_code`,
sharing the same :class:`AgentBackend` contract but with a few important
differences:

* The Codex TUI does not let us pin a session UUID at startup. Instead
  the agent allocates one *after* the first user message, persisted in
  ``$CODEX_HOME/state_5.sqlite``. We therefore poll that SQLite database
  after every fresh launch to discover which thread was created and
  bind our session id to it.
* The rollout JSONL lives under ``$CODEX_HOME/sessions/YYYY/MM/DD/`` with a
  filename that ends in ``-<thread-id>.jsonl``. We resolve it by either
  reading the thread row's ``rollout_path`` column or, as a fallback,
  walking the directory tree.
* Trust is configured via TOML stanzas in ``$CODEX_HOME/config.toml``
  rather than the JSON file Claude uses.
* The "working / idle" determination reads Codex-flavoured event types
  (``event_msg`` / ``response_item`` / ``turn_context``) instead of the
  Claude-Code shapes.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Set

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
# Constants
# ---------------------------------------------------------------------------
READY_POLL_MS = 250
READY_TIMEOUT_MS = 25_000
# The TUI is ready when all of these strings appear on-screen. They show
# in the splash banner and the bottom status bar respectively.
READY_SENTINELS = (
    "OpenAI Codex",
    "permissions: YOLO mode",
    "/model to change",
)

# First-time-in-this-cwd trust prompt (TUI dialog).
TRUST_PROMPT_SENTINELS = (
    "Do you trust the contents of this directory",
    "Trusting the directory allows",
)
TRUST_PRESS_INTERVAL_MS = 1500

# "Update available" splash. We dismiss it with "2 + Enter" (skip).
UPDATE_PROMPT_SENTINELS = (
    "Update available!",
    "Skip until next version",
)
UPDATE_PRESS_INTERVAL_MS = 1500

PASTE_PROBE_TIMEOUT_MS = 8_000
PASTE_PROBE_INTERVAL_MS = 200
PASTE_SLEEP_BASE_MS = 800
PASTE_SLEEP_MAX_MS = 5_000
SUBMIT_ENTER_ATTEMPTS = 3
SUBMIT_ENTER_INTERVAL_MS = 500

# How long to wait for the Codex thread row to appear in state_5.sqlite
# after we paste the first prompt.
THREAD_BIND_TIMEOUT_MS = 30_000
THREAD_BIND_POLL_MS = 300
THREAD_BIND_UPDATED_SKEW_MS = 1_000
CODEX_CHANNEL_RE = re.compile(r"^[A-Za-z]+$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


# ---------------------------------------------------------------------------
# Stateless helpers (tmux, shell, TOML, etc.)
# ---------------------------------------------------------------------------
def tmux(args: List[str], *, input: Optional[str] = None) -> subprocess.CompletedProcess:
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
    if hub_exists(hub):
        return
    r = tmux(["new-session", "-d", "-s", hub, "-n", "_root"])
    if r.returncode != 0:
        raise RuntimeError(f"tmux new-session failed: {r.stderr}")
    print(f"[tmux-codex] created tmux session {hub}")


def window_exists(hub: str, name: str) -> bool:
    r = tmux(["list-windows", "-t", hub, "-F", "#{window_name}"])
    if r.returncode != 0:
        return False
    return name in r.stdout.split("\n")


def normalize_codex_channel(value: Any) -> str:
    channel = str(value or "").strip()
    if not channel:
        raise ValueError("tmux-codex requires codex channel (--profile)")
    if not CODEX_CHANNEL_RE.match(channel):
        raise ValueError(f"invalid codex channel {channel!r}: channel must contain letters only")
    return channel


def normalize_secret_env_key(value: Any) -> str:
    key = str(value or "").strip()
    if not key:
        raise ValueError("tmux-codex requires codex secret env key")
    if not ENV_KEY_RE.match(key):
        raise ValueError(f"invalid codex secret env key {key!r}")
    return key


def resolve_secret_value(secret_env_key: str, secret_value: Any) -> str:
    explicit = "" if secret_value is None else str(secret_value)
    value = explicit or os.environ.get(secret_env_key, "")
    if not value:
        raise ValueError(f"missing value for codex secret env key {secret_env_key}")
    return value


def toml_string_value(toml_text: str, key: str) -> str:
    m = re.search(
        rf"(?:^|\n)\s*{re.escape(str(key))}\s*=\s*(['\"])([^'\"]+)\1",
        str(toml_text or ""),
    )
    return m.group(2).strip() if m else ""


def shell_quote(s: Any) -> str:
    return "'" + str(s).replace("'", "'\\''") + "'"


def normalize_use_proxy(value: Any, fallback: bool = False) -> bool:
    if value in (False, 0, "0", "false"):
        return False
    if value in (True, 1, "1", "true"):
        return True
    return bool(fallback)


def _which(bin_name: str) -> Optional[str]:
    return shutil.which(bin_name)


def proxy_prereq_missing(proxy_envs: str, proxy_conf: str) -> List[str]:
    missing: List[str] = []
    if not os.path.exists(proxy_envs):
        missing.append(f"file: {proxy_envs}")
    if not os.path.exists(proxy_conf):
        missing.append(f"file: {proxy_conf}")
    if not _which("proxychains"):
        missing.append("bin (PATH): proxychains")
    return missing


def assert_proxy_available(proxy_envs: str, proxy_conf: str) -> None:
    missing = proxy_prereq_missing(proxy_envs, proxy_conf)
    if missing:
        raise RuntimeError(
            "use_proxy=true but proxy prerequisites are missing: " + ", ".join(missing)
        )


_PROFILE_NAME_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def normalize_optional_path(value: Any) -> Optional[str]:
    if not value:
        return None
    return os.path.abspath(os.path.expandvars(os.path.expanduser(str(value))))


def first_present(opts: dict, *keys: str) -> Any:
    for key in keys:
        value = opts.get(key)
        if value:
            return value
    return None


def safe_profile_name(session_id: str) -> str:
    name = _PROFILE_NAME_RE.sub("_", str(session_id)).strip("._-")
    return name[:120] or "session"


def replace_file_link_or_copy(src: str, dst: str) -> None:
    """Replace ``dst`` with a symlink to ``src``; copy if symlink fails."""
    if os.path.abspath(src) == os.path.abspath(dst):
        return
    if os.path.lexists(dst):
        os.remove(dst)
    try:
        os.symlink(src, dst)
    except OSError:
        shutil.copy2(src, dst)


# ---------------------------------------------------------------------------
# TOML helpers for ``$CODEX_HOME/config.toml``
# ---------------------------------------------------------------------------
def _toml_basic_string(s: str) -> str:
    """Return ``s`` encoded as a TOML basic string (double-quoted, escaped)."""
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"') + '"'


def codex_project_header(cwd: str) -> str:
    """``[projects."<abspath>"]`` section header for a given cwd."""
    return f"[projects.{_toml_basic_string(os.path.abspath(cwd))}]"


_TOML_SECTION_RE = re.compile(r"^\s*\[.*\]\s*$")
_TRUST_LEVEL_RE = re.compile(r"^\s*trust_level\s*=")
_TRUST_LEVEL_TRUSTED_RE = re.compile(r'^\s*trust_level\s*=\s*"trusted"\s*$')


def _is_section_header(line: str) -> bool:
    return bool(_TOML_SECTION_RE.match(line))


def _is_trust_level_line(line: str) -> bool:
    return bool(_TRUST_LEVEL_RE.match(line))


def _is_trust_level_trusted_line(line: str) -> bool:
    return bool(_TRUST_LEVEL_TRUSTED_RE.match(line))


def ensure_project_trusted(codex_home: str, codex_config: str, cwd: str) -> bool:
    """Add ``trust_level = "trusted"`` under ``[projects."<cwd>"]`` in ``config.toml``.

    Idempotent and atomic (tmp + ``os.replace``). On any failure we
    print a warning and rely on the screen-scrape fallback during
    window readiness polling.
    """
    try:
        os.makedirs(codex_home, exist_ok=True)
        header = codex_project_header(cwd)

        text = ""
        if os.path.exists(codex_config):
            with open(codex_config, "r", encoding="utf-8") as f:
                text = f.read()
        # Normalise CRLF → LF for line scanning, preserve content otherwise.
        lines = [ln.rstrip("\r") for ln in text.split("\n")]

        # Find or create the project section.
        start = -1
        for i, ln in enumerate(lines):
            if ln.strip() == header:
                start = i
                break
        if start < 0:
            if text and not text.endswith("\n"):
                text += "\n"
            with open(codex_config, "w", encoding="utf-8") as f:
                f.write(f'{text}\n{header}\ntrust_level = "trusted"\n')
            print(f"[tmux-codex] trusted project in {codex_config}: {os.path.abspath(cwd)}")
            return True

        # Locate the end of this section (next "[..]" line or EOF).
        end = len(lines)
        for i in range(start + 1, len(lines)):
            if _is_section_header(lines[i]):
                end = i
                break

        # Update an existing ``trust_level = ...`` line or insert a new one.
        trust_idx = -1
        for i in range(start + 1, end):
            if _is_trust_level_line(lines[i]):
                trust_idx = i
                break
        if trust_idx >= 0:
            if _is_trust_level_trusted_line(lines[trust_idx]):
                return True  # Already correct.
            lines[trust_idx] = 'trust_level = "trusted"'
        else:
            lines.insert(start + 1, 'trust_level = "trusted"')

        tmp = f"{codex_config}.tmp-{os.getpid()}-{int(time.time() * 1000)}"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        os.replace(tmp, codex_config)
        print(f"[tmux-codex] trusted project in {codex_config}: {os.path.abspath(cwd)}")
        return True
    except Exception as e:
        print(f"[tmux-codex] failed to pre-trust project; screen fallback will handle it: {e}")
        return False


# ---------------------------------------------------------------------------
# Screen + ASCII helpers
# ---------------------------------------------------------------------------
def summarize_screen(screen: Any) -> str:
    """Return the last ~16 non-blank lines of a captured pane (bounded length)."""
    s = str(screen or "")
    lines = [ln.rstrip() for ln in s.split("\n") if ln.strip()]
    return "\n".join(lines[-16:])[:2000]


_ASCII_RE = re.compile(r"[\x20-\x7E]")


def find_ascii_tail_marker(text: str) -> Optional[str]:
    """Return the trailing 5–15 ASCII characters of ``text``, or ``None``.

    See :func:`aimax.tmux_claude_code.find_ascii_tail_marker` —
    same idea, repeated here so the modules stay independent.
    """
    i = len(text) - 1
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
# Preflight
# ---------------------------------------------------------------------------
def _preflight(cfg) -> None:
    missing = []
    for b in ("tmux", "codex"):
        if not _which(b):
            missing.append(f"bin (PATH): {b}")
    # The Python stdlib ships ``sqlite3``; no need to test for it.
    if missing:
        print("[tmux-codex] ❌ preflight failed, refusing to start:", file=sys.stderr)
        for m in missing:
            print("   - " + m, file=sys.stderr)
        sys.exit(1)
    pm = proxy_prereq_missing(str(cfg.proxy_envs_bash), str(cfg.proxy_chains_conf))
    if pm:
        print(
            "[tmux-codex] ⚠️  proxychains prerequisites incomplete; "
            "use_proxy=false sessions still work direct: " + ", ".join(pm)
        )
    print(f"[tmux-codex] ✅ preflight pass (HUB={cfg.codex_hub}, CODEX_HOME={cfg.codex_home})")


_CFG = get_config()
if _CFG.run_preflight:
    try:
        _preflight(_CFG)
    except SystemExit:
        raise
    except Exception as e:  # pragma: no cover — defensive
        print(f"[tmux-codex] preflight warning: {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# state_5.sqlite helpers (read-only)
# ---------------------------------------------------------------------------
def _open_state_db(state_db: str) -> Optional[sqlite3.Connection]:
    """Open the Codex state DB read-only via the SQLite URI form.

    Returns ``None`` if the file is missing or cannot be opened — every
    caller in this module degrades to "no info available" in that case.
    """
    if not os.path.exists(state_db):
        return None
    try:
        conn = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception as e:  # pragma: no cover — defensive
        print(f"[tmux-codex] failed to open state db: {e}")
        return None


def snapshot_thread_ids(state_db: str, cwd: str) -> Set[str]:
    """Return the set of existing Codex thread ids for ``cwd``.

    Snapshotted before we launch a new TUI so we can later detect *the*
    newly-created thread by set-difference.
    """
    db = _open_state_db(state_db)
    if db is None:
        return set()
    try:
        rows = db.execute(
            "SELECT id FROM threads WHERE cwd = ?", (os.path.abspath(cwd),)
        ).fetchall()
        return {r["id"] for r in rows}
    except Exception:
        return set()
    finally:
        try:
            db.close()
        except Exception:  # pragma: no cover — defensive
            pass


def codex_thread_by_id(state_db: str, thread_id: Optional[str]) -> Optional[dict]:
    """Look up a thread row by id. Returns the row dict or ``None``."""
    if not thread_id:
        return None
    db = _open_state_db(state_db)
    if db is None:
        return None
    try:
        row = db.execute(
            """
            SELECT id, rollout_path, cwd, model,
                   COALESCE(created_at_ms, created_at * 1000) AS created_ms,
                   COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms
            FROM threads
            WHERE id = ?
            """,
            (thread_id,),
        ).fetchone()
        return dict(row) if row else None
    except Exception as e:  # pragma: no cover — defensive
        print(f"[tmux-codex] failed to read thread {thread_id}: {e}")
        return None
    finally:
        try:
            db.close()
        except Exception:  # pragma: no cover — defensive
            pass


def find_rollout_path_by_thread_id(
    sessions_dir: str, state_db: str, thread_id: Optional[str]
) -> Optional[str]:
    """Find the JSONL rollout path for ``thread_id``.

    Prefers the state DB's ``rollout_path`` column (canonical). Falls
    back to walking ``sessions_dir`` looking for any file ending in
    ``-<thread_id>.jsonl`` — slower but works even if the DB is stale.
    """
    row = codex_thread_by_id(state_db, thread_id)
    if row and row.get("rollout_path"):
        return row["rollout_path"]

    if not thread_id or not os.path.exists(sessions_dir):
        return None
    suffix = f"{thread_id}.jsonl"
    # Iterative DFS to avoid recursion-depth issues on deep trees.
    stack = [sessions_dir]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for entry in it:
                    p = entry.path
                    if entry.is_dir():
                        stack.append(p)
                    elif entry.is_file() and entry.name.endswith(suffix):
                        return p
        except OSError:
            continue
    return None


def find_newest_thread(
    state_db: str,
    *,
    cwd: str,
    model: Optional[str],
    since_ms: int,
    exclude_ids: Optional[Set[str]] = None,
) -> Optional[dict]:
    """Find the most recently created thread for ``cwd`` that started after ``since_ms``.

    Used after we paste the first prompt to discover which thread the
    TUI just allocated for us.
    """
    db = _open_state_db(state_db)
    if db is None:
        return None
    try:
        rows = db.execute(
            """
            SELECT id, rollout_path, cwd, model,
                   COALESCE(created_at_ms, created_at * 1000) AS created_ms,
                   COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
                   first_user_message
            FROM threads
            WHERE cwd = ?
              AND COALESCE(created_at_ms, created_at * 1000) >= ?
            ORDER BY COALESCE(created_at_ms, created_at * 1000) DESC
            LIMIT 20
            """,
            (os.path.abspath(cwd), since_ms),
        ).fetchall()
        for r in rows:
            d = dict(r)
            if exclude_ids and d["id"] in exclude_ids:
                continue
            if model and d.get("model") and d["model"] != model:
                continue
            return d
        return None
    except Exception as e:  # pragma: no cover — defensive
        print(f"[tmux-codex] failed to find newest thread: {e}")
        return None
    finally:
        try:
            db.close()
        except Exception:  # pragma: no cover — defensive
            pass


def find_recently_updated_thread(
    state_db: str,
    *,
    cwd: str,
    model: Optional[str],
    since_ms: int,
) -> Optional[dict]:
    """Find the most recently updated thread for ``cwd`` after ``since_ms``.

    Used when a tmux window already existed before this Python driver
    reattached. In that case there may be no newly-created thread row,
    only an existing thread whose ``updated_at`` changes after paste.
    """
    db = _open_state_db(state_db)
    if db is None:
        return None
    try:
        rows = db.execute(
            """
            SELECT id, rollout_path, cwd, model,
                   COALESCE(created_at_ms, created_at * 1000) AS created_ms,
                   COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
                   first_user_message
            FROM threads
            WHERE cwd = ?
              AND COALESCE(updated_at_ms, updated_at * 1000) >= ?
            ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
            LIMIT 20
            """,
            (os.path.abspath(cwd), since_ms),
        ).fetchall()
        for r in rows:
            d = dict(r)
            if model and d.get("model") and d["model"] != model:
                continue
            return d
        return None
    except Exception as e:  # pragma: no cover — defensive
        print(f"[tmux-codex] failed to find recently updated thread: {e}")
        return None
    finally:
        try:
            db.close()
        except Exception:  # pragma: no cover — defensive
            pass


# ---------------------------------------------------------------------------
# Codex event classifiers (used by is_working / _update_working_from_entry)
# ---------------------------------------------------------------------------
def is_codex_task_complete(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    return entry.get("type") == "event_msg" and (entry.get("payload") or {}).get("type") == "task_complete"


def is_codex_task_start(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    return (
        entry.get("type") == "event_msg"
        and (entry.get("payload") or {}).get("type") in ("task_started", "user_message")
    )


# ---------------------------------------------------------------------------
# Async helpers
# ---------------------------------------------------------------------------
async def _sleep_ms(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


def _now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
class TmuxCodexBackend(AgentBackend):
    """Concrete :class:`AgentBackend` driving the ``codex`` TUI."""

    def __init__(self) -> None:
        cfg = get_config()
        self.cfg = cfg
        self.hub = cfg.codex_hub
        self.codex_home = str(cfg.codex_home)
        self.codex_config = str(cfg.codex_config)
        self.codex_state_db = str(cfg.codex_state_db)
        self.codex_sessions_dir = str(cfg.codex_sessions_dir)
        self.codex_profiles_dir = str(cfg.codex_profiles_dir())
        self.proxy_envs = str(cfg.proxy_envs_bash)
        self.proxy_conf = str(cfg.proxy_chains_conf)
        self.default_model = cfg.codex_default_model

        super().__init__(
            name="tmux-codex",
            runtime_file=cfg.codex_runtime_file(),
            archive_file=cfg.codex_archive_file(),
        )

        self.runtime: Dict[str, dict] = {}
        self._restore_from_persisted()

    # ------------------------------------------------------------------
    # Per-session Codex profile paths
    # ------------------------------------------------------------------
    def _default_codex_paths(self) -> dict:
        return {
            "codex_home": self.codex_home,
            "config_path": self.codex_config,
            "codex_state_db": self.codex_state_db,
            "codex_sessions_dir": self.codex_sessions_dir,
        }

    def _codex_paths_from_persisted(self, p: Optional[dict]) -> dict:
        base = self._default_codex_paths()
        if not p:
            return base
        codex_home = p.get("codexHome") or p.get("codex_home")
        config_path = p.get("configPath") or p.get("codexConfigPath") or p.get("codex_config")
        state_db = p.get("codexStateDb") or p.get("codex_state_db")
        sessions_dir = p.get("codexSessionsDir") or p.get("codex_sessions_dir")
        out = {
            "codex_home": normalize_optional_path(codex_home) or base["codex_home"],
            "config_path": normalize_optional_path(config_path) or base["config_path"],
            "codex_state_db": normalize_optional_path(state_db) or base["codex_state_db"],
            "codex_sessions_dir": normalize_optional_path(sessions_dir) or base["codex_sessions_dir"],
            "codex_profile_key": first_present(p, "codexProfileKey", "codex_profile_key"),
            "codex_config_path": normalize_optional_path(
                first_present(p, "codexConfigPath", "codex_config_path")
            ),
            "codex_secret_env_key": first_present(p, "codexSecretEnvKey", "codex_secret_env_key"),
        }
        return out

    def _persisted_codex_paths(self, paths: dict) -> dict:
        out = {
            "codexHome": paths["codex_home"],
            "configPath": paths["config_path"],
            "codexStateDb": paths["codex_state_db"],
            "codexSessionsDir": paths["codex_sessions_dir"],
        }
        if paths.get("codex_profile_key"):
            out["codexProfileKey"] = paths["codex_profile_key"]
        if paths.get("codex_config_path"):
            out["codexConfigPath"] = paths["codex_config_path"]
        if paths.get("codex_secret_env_key"):
            out["codexSecretEnvKey"] = paths["codex_secret_env_key"]
        return out

    def _codex_paths_for_session(self, session_id: str) -> dict:
        entry = self.runtime.get(session_id)
        if entry:
            return {
                "codex_home": entry.get("codex_home") or self.codex_home,
                "config_path": entry.get("config_path") or self.codex_config,
                "codex_state_db": entry.get("codex_state_db") or self.codex_state_db,
                "codex_sessions_dir": entry.get("codex_sessions_dir") or self.codex_sessions_dir,
                "codex_profile_key": entry.get("codex_profile_key"),
                "codex_config_path": entry.get("codex_config_path"),
                "codex_secret_env_key": entry.get("codex_secret_env_key"),
            }
        return self._codex_paths_from_persisted(self.persisted.get(session_id))

    def _extract_codex_config_path(self, opts: dict) -> Optional[str]:
        return normalize_optional_path(
            first_present(opts, "configPath", "codexConfigPath", "codexConfig", "config_path")
        )

    def _prepare_codex_paths(
        self,
        session_id: str,
        *,
        config_path: Optional[str] = None,
        fallback: Optional[dict] = None,
    ) -> dict:
        """Return the Codex file layout for a new/spawned window.

        Codex reads base ``config.toml`` and ``<channel>.config.toml`` from
        ``CODEX_HOME``. If callers pass a source config explicitly, we create a
        managed per-session home under ``AIMAX_DATA_DIR/codex-profiles``:
        config is copied there so trust stanzas can be added without mutating
        the caller's source file. Provider secrets are exported from the TOML
        ``env_key`` at launch time.
        """
        fallback_paths = fallback or self._default_codex_paths()
        config_src = config_path or fallback_paths["config_path"]

        if config_path and not os.path.exists(config_src):
            raise FileNotFoundError(f"Codex config file does not exist: {config_src}")

        if not config_path:
            return fallback_paths

        profile_home = os.path.join(self.codex_profiles_dir, safe_profile_name(session_id))
        os.makedirs(profile_home, exist_ok=True)
        os.makedirs(os.path.join(profile_home, "sessions"), exist_ok=True)

        final_config = os.path.join(profile_home, "config.toml")
        if os.path.exists(config_src) and os.path.abspath(config_src) != os.path.abspath(final_config):
            shutil.copy2(config_src, final_config)
        elif not os.path.exists(final_config):
            with open(final_config, "w", encoding="utf-8") as f:
                f.write("")

        return {
            "codex_home": profile_home,
            "config_path": final_config,
            "codex_state_db": os.path.join(profile_home, "state_5.sqlite"),
            "codex_sessions_dir": os.path.join(profile_home, "sessions"),
        }

    # ------------------------------------------------------------------
    # Setup / restore
    # ------------------------------------------------------------------
    def _restore_from_persisted(self) -> None:
        total = 0
        for sid, p in (self.persisted or {}).items():
            total += 1
            paths = self._codex_paths_from_persisted(p)
            if not p or not p.get("agentSessionId"):
                if not p or not p.get("cwd") or not window_exists(self.hub, sid):
                    continue
                recovered = find_newest_thread(
                    paths["codex_state_db"],
                    cwd=p.get("cwd"),
                    model=p.get("model") or self.default_model,
                    since_ms=max(0, int(p.get("startedAt") or 0) - THREAD_BIND_UPDATED_SKEW_MS),
                    exclude_ids=None,
                )
                recovered_jsonl = (
                    recovered.get("rollout_path")
                    or find_rollout_path_by_thread_id(
                        paths["codex_sessions_dir"], paths["codex_state_db"], recovered.get("id")
                    )
                    if recovered and recovered.get("id") else None
                )
                if recovered and recovered.get("id") and recovered_jsonl and os.path.exists(recovered_jsonl):
                    entry = {
                        "agent_session_id": recovered["id"],
                        "cwd": p.get("cwd"),
                        "flag_root": p.get("flagRoot") or p.get("cwd"),
                        "model": recovered.get("model") or p.get("model") or self.default_model,
                        "use_proxy": normalize_use_proxy(p.get("useProxy"), False),
                        "display_name": p.get("displayName"),
                        "jsonl_path": recovered_jsonl,
                        "started_at": recovered.get("created_ms") or p.get("startedAt") or 0,
                        "working": True,
                        "watch": None,
                        "codex_home": paths["codex_home"],
                        "config_path": paths["config_path"],
                        "codex_state_db": paths["codex_state_db"],
                        "codex_sessions_dir": paths["codex_sessions_dir"],
                        "codex_profile_key": paths.get("codex_profile_key"),
                        "codex_config_path": paths.get("codex_config_path"),
                        "codex_secret_env_key": paths.get("codex_secret_env_key"),
                    }
                    self.runtime[sid] = entry
                    self._persist_entry(sid, {
                        "agentSessionId": entry["agent_session_id"],
                        "cwd": entry["cwd"],
                        "flagRoot": entry["flag_root"],
                        "model": entry["model"],
                        "useProxy": entry["use_proxy"],
                        "displayName": entry["display_name"],
                        "jsonlPath": entry["jsonl_path"],
                        "startedAt": entry["started_at"],
                        "pendingBind": False,
                        **self._persisted_codex_paths(paths),
                    })
                    self._ensure_watcher(sid)
                    print(
                        f"[tmux-codex] recovered pending runtime {sid} "
                        f"to codex_thread={entry['agent_session_id']}"
                    )
                    continue
                self.runtime[sid] = {
                    "agent_session_id": None,
                    "cwd": p.get("cwd"),
                    "flag_root": p.get("flagRoot") or p.get("cwd"),
                    "model": p.get("model") or self.default_model,
                    "use_proxy": normalize_use_proxy(p.get("useProxy"), False),
                    "display_name": p.get("displayName"),
                    "jsonl_path": None,
                    "started_at": p.get("startedAt") or 0,
                    "working": True,
                    "watch": None,
                    "codex_home": paths["codex_home"],
                    "config_path": paths["config_path"],
                    "codex_state_db": paths["codex_state_db"],
                    "codex_sessions_dir": paths["codex_sessions_dir"],
                    "codex_profile_key": paths.get("codex_profile_key"),
                    "codex_config_path": paths.get("codex_config_path"),
                    "codex_secret_env_key": paths.get("codex_secret_env_key"),
                }
                print(f"[tmux-codex] restored pending runtime {sid}; waiting for codex thread bind")
                continue
            jsonl_path = p.get("jsonlPath") or find_rollout_path_by_thread_id(
                paths["codex_sessions_dir"], paths["codex_state_db"], p.get("agentSessionId")
            )
            if not jsonl_path or not os.path.exists(jsonl_path):
                print(f"[tmux-codex] dropping runtime {sid}; rollout jsonl missing: {jsonl_path}")
                continue
            self.runtime[sid] = {
                "agent_session_id": p.get("agentSessionId"),
                "cwd": p.get("cwd"),
                "flag_root": p.get("flagRoot") or p.get("cwd"),
                "model": p.get("model") or self.default_model,
                "use_proxy": normalize_use_proxy(p.get("useProxy"), False),
                "display_name": p.get("displayName"),
                "jsonl_path": jsonl_path,
                "started_at": p.get("startedAt") or 0,
                "working": False,
                "watch": None,
                "codex_home": paths["codex_home"],
                "config_path": paths["config_path"],
                "codex_state_db": paths["codex_state_db"],
                "codex_sessions_dir": paths["codex_sessions_dir"],
                "codex_profile_key": paths.get("codex_profile_key"),
                "codex_config_path": paths.get("codex_config_path"),
                "codex_secret_env_key": paths.get("codex_secret_env_key"),
            }
            self._ensure_watcher(sid)
        print(f"[tmux-codex] runtime loaded {len(self.runtime)}/{total}")

    def _ensure_watcher(self, session_id: str, start_offset: Optional[int] = None) -> None:
        """Attach the shared JSONL watcher for ``session_id`` (idempotent).

        ``start_offset`` defaults to the file's current size, so live
        subscribers do not see history replayed. Pass ``0`` after a
        fresh thread bind so newly-attached subscribers receive the
        prologue too.
        """
        entry = self.runtime.get(session_id)
        if not entry or not entry.get("jsonl_path") or entry.get("watch"):
            return
        start_sentinel = (
            None
            if start_offset is None
            else {"primary": start_offset, "mobius": 0 if start_offset == 0 else None}
        )

        def on_entry(raw, _line_no=None):
            self._emit_raw(session_id, raw)

        def on_error(e):
            print(f"[tmux-codex/watch {session_id}] {e}")

        entry["watch"] = watch_merged_jsonl(
            path=entry["jsonl_path"],
            start_sentinel=start_sentinel,
            on_entry=on_entry,
            on_primary_entry=lambda raw, _line_no=None: self._update_working_from_entry(entry, raw),
            on_error=on_error,
        )

    # ------------------------------------------------------------------
    # Public API (lock-wrapped delegates)
    # ------------------------------------------------------------------
    async def create_new_session(self, opts: dict) -> dict:
        """Spawn a Codex session and submit ``initialPrompt``.

        ``opts`` matches :meth:`TmuxClaudeCodeBackend.create_new_session`.
        The Codex backend additionally binds to a freshly-allocated
        thread id by polling ``state_5.sqlite`` after the first paste.
        """
        return await self._with_lock(opts.get("sessionId"), lambda: self._create_impl(opts))

    async def pause_current_and_resume_from_session(self, opts: dict) -> None:
        await self._with_lock(opts.get("sessionId"), lambda: self._pause_impl(opts))

    async def no_pause_current_and_queue_query_at_session(self, opts: dict) -> None:
        await self._with_lock(opts.get("sessionId"), lambda: self._queue_impl(opts))

    async def terminate_session(self, session_id: str) -> dict:
        return await self._with_lock(session_id, lambda: self._terminate_impl(session_id))

    # ------------------------------------------------------------------
    # Non-mutating status
    # ------------------------------------------------------------------
    def is_alive(self, session_id: str) -> bool:
        return window_exists(self.hub, session_id)

    def is_working(self, session_id: str) -> bool:
        """Is Codex mid-turn? Combines a cached flag and a JSONL tail re-scan."""
        if not self.is_alive(session_id):
            return False
        entry = self.runtime.get(session_id)
        if entry and entry.get("working") and not entry.get("jsonl_path"):
            return True
        from_jsonl = self._read_working_from_jsonl((entry or {}).get("jsonl_path"))
        if from_jsonl is None:
            return bool((entry or {}).get("working"))
        return from_jsonl

    def _read_working_from_jsonl(self, jsonl_path: Optional[str]) -> Optional[bool]:
        """Reverse-scan the last 64 KiB of the JSONL for a state-defining event.

        Returns ``True`` / ``False`` / ``None`` (== unknown).
        """
        if not jsonl_path or not os.path.exists(jsonl_path):
            return None
        try:
            stat = os.stat(jsonl_path)
            if stat.st_size == 0:
                return None
            length = min(stat.st_size, 64 * 1024)
            with open(jsonl_path, "rb") as f:
                f.seek(stat.st_size - length)
                buf = f.read(length)
            lines = [ln for ln in buf.decode("utf-8", errors="replace").split("\n") if ln]
        except OSError:
            return None

        for i in range(len(lines) - 1, -1, -1):
            try:
                e = json.loads(lines[i])
            except Exception:
                continue
            if is_codex_task_complete(e):
                return False
            if is_codex_task_start(e):
                return True
            if e.get("type") == "response_item":
                pt = (e.get("payload") or {}).get("type")
                if pt in ("function_call", "function_call_output", "reasoning", "message"):
                    return True
            if e.get("type") == "turn_context":
                return True
        return None

    def is_job_goal_accomplished(self, session_id: str) -> bool:
        entry = self.runtime.get(session_id)
        root = (entry or {}).get("flag_root") or (entry or {}).get("cwd")
        if not root:
            return False
        return not os.path.exists(running_flag_path_of(root, session_id))

    def is_failed(self, session_id: str) -> bool:
        entry = self.runtime.get(session_id)
        root = (entry or {}).get("flag_root") or (entry or {}).get("cwd")
        if not root:
            return False
        return os.path.exists(failed_flag_path_of(root, session_id))

    def list_sessions(self) -> list:
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
        e = self.runtime.get(session_id) or {}
        if e.get("jsonl_path"):
            return e["jsonl_path"]
        p = self.persisted.get(session_id) or {}
        if p.get("jsonlPath"):
            return p["jsonlPath"]
        return self._lookup_archived_jsonl_path(session_id)

    def get_history(self, session_id: str, opts: Optional[dict] = None) -> dict:
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
                on_error=lambda e: print(f"[tmux-codex/sub {session_id}] {e}"),
            )

            def unsubscribe():
                try:
                    w.stop()
                except Exception:  # pragma: no cover — defensive
                    pass

            return unsubscribe
        return super().get_agent_raw_thought_stream(session_id, listener, opts)

    def _append_mobius_prompt_entry(self, session_id: str, mobius_jsonl: Optional[dict]) -> bool:
        """Write Mobius prompt metadata beside the Codex rollout JSONL."""
        if not mobius_jsonl:
            return False
        entry = self.runtime.get(session_id) or {}
        jsonl_path = entry.get("jsonl_path")
        if not jsonl_path:
            print(
                f"[tmux-codex] mobius jsonl skipped ({session_id}): "
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
            print(f"[tmux-codex] mobius jsonl append failed ({session_id}): {e}")
            return False

    # ------------------------------------------------------------------
    # Mutating implementations
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
        config_path = self._extract_codex_config_path(opts)
        codex_profile_key = first_present(opts, "codexChannel", "codex_channel", "codexProfileKey", "codex_profile_key")
        codex_config_path = normalize_optional_path(
            first_present(opts, "codexConfigPath", "codex_config_path")
        )
        codex_secret_env_key = first_present(opts, "codexSecretEnvKey", "codex_secret_env_key")
        codex_secret_value = first_present(opts, "codexSecretValue", "codex_secret_value")

        if not session_id or not cwd:
            raise ValueError("create_new_session requires sessionId + cwd")
        if not initial_prompt:
            raise ValueError("create_new_session requires initialPrompt")
        if not os.path.exists(cwd):
            raise FileNotFoundError(f"cwd does not exist: {cwd}")

        spawn_info: Optional[dict] = None
        allow_updated_thread_fallback = False
        if not window_exists(self.hub, session_id):
            codex_paths = self._prepare_codex_paths(session_id, config_path=config_path)
            if codex_config_path:
                codex_paths["codex_config_path"] = codex_config_path
            if codex_profile_key:
                codex_paths["codex_profile_key"] = codex_profile_key
            if codex_secret_env_key:
                codex_paths["codex_secret_env_key"] = codex_secret_env_key
            spawn_info = await self._spawn_window(
                session_id=session_id, cwd=cwd, flag_root=flag_root,
                model=model, use_proxy=use_proxy,
                display_name=display_name, agent_session_id=agent_session_id,
                codex_paths=codex_paths,
                codex_profile_key=codex_profile_key,
                codex_config_path=codex_config_path,
                codex_secret_env_key=codex_secret_env_key,
                codex_secret_value=codex_secret_value,
            )
        else:
            codex_paths = self._codex_paths_for_session(session_id)
            if session_id in self.runtime:
                if config_path:
                    print(
                        f"[tmux-codex] configPath ignored for live window "
                        f"{session_id}; restart the session to change Codex files"
                    )
            elif config_path:
                codex_paths = self._prepare_codex_paths(
                    session_id,
                    config_path=config_path,
                    fallback=codex_paths,
                )
            if codex_profile_key:
                codex_paths["codex_profile_key"] = codex_profile_key
            if codex_config_path:
                codex_paths["codex_config_path"] = codex_config_path
            if codex_secret_env_key:
                codex_paths["codex_secret_env_key"] = codex_secret_env_key
            await self._ensure_runtime_from_known_thread(
                session_id=session_id, cwd=cwd, flag_root=flag_root,
                model=model, use_proxy=use_proxy,
                display_name=display_name, agent_session_id=agent_session_id,
                codex_paths=codex_paths,
                codex_profile_key=codex_profile_key,
                codex_config_path=codex_config_path,
                codex_secret_env_key=codex_secret_env_key,
            )
            allow_updated_thread_fallback = True

        entry_for_paths = self.runtime.get(session_id) or {}
        if not cwd:
            cwd = entry_for_paths.get("cwd")
        if not model:
            model = entry_for_paths.get("model")
        if use_proxy is None:
            use_proxy = entry_for_paths.get("use_proxy")
        if not display_name:
            display_name = entry_for_paths.get("display_name")
        if not cwd:
            raise RuntimeError(f"session {session_id} has no cwd for Codex thread binding")

        bind_known_thread_ids = (
            (spawn_info or {}).get("knownThreadIds")
            or snapshot_thread_ids(codex_paths["codex_state_db"], cwd)
        )
        bind_since_ms = (spawn_info or {}).get("startedAt") or _now_ms()
        await self._send_prompt_to_window(session_id, initial_prompt)
        entry = self.runtime.get(session_id) or {}
        safe_write_running_flag(
            flag_root or entry.get("flag_root") or entry.get("cwd") or cwd,
            session_id, {"backend": "tmux-codex"}, "tmux-codex",
        )
        if not (self.runtime.get(session_id) or {}).get("agent_session_id"):
            await self._bind_runtime_after_prompt(
                session_id=session_id, cwd=cwd, flag_root=flag_root or cwd,
                model=model or self.default_model,
                use_proxy=normalize_use_proxy(use_proxy, False),
                display_name=display_name,
                since_ms=bind_since_ms, known_thread_ids=bind_known_thread_ids,
                allow_updated_thread_fallback=allow_updated_thread_fallback,
                codex_paths=codex_paths,
                codex_profile_key=codex_profile_key,
                codex_config_path=codex_config_path,
                codex_secret_env_key=codex_secret_env_key,
            )

        entry = self.runtime.get(session_id) or {}
        return {
            "sessionId": session_id,
            "agentSessionId": entry.get("agent_session_id"),
            "jsonlPath": entry.get("jsonl_path"),
            "startedAt": entry.get("started_at") or _now_ms(),
            "codexHome": entry.get("codex_home"),
            "configPath": entry.get("config_path"),
        }

    async def _queue_impl(self, opts: dict) -> None:
        session_id = opts.get("sessionId")
        prompt = opts.get("prompt")
        cwd = opts.get("cwd")
        flag_root = opts.get("flagRoot")
        model = opts.get("model")
        use_proxy = opts.get("useProxy")
        display_name = opts.get("displayName")
        agent_session_id = opts.get("agentSessionId")
        mobius_jsonl = opts.get("mobiusJsonl")
        config_path = self._extract_codex_config_path(opts)
        codex_profile_key = first_present(opts, "codexChannel", "codex_channel", "codexProfileKey", "codex_profile_key")
        codex_config_path = normalize_optional_path(
            first_present(opts, "codexConfigPath", "codex_config_path")
        )
        codex_secret_env_key = first_present(opts, "codexSecretEnvKey", "codex_secret_env_key")
        codex_secret_value = first_present(opts, "codexSecretValue", "codex_secret_value")

        if not session_id:
            raise ValueError("sessionId required")
        if not prompt:
            raise ValueError("prompt required")

        spawn_info: Optional[dict] = None
        allow_updated_thread_fallback = False
        codex_paths = self._codex_paths_for_session(session_id)
        if not window_exists(self.hub, session_id):
            persisted = self.runtime.get(session_id) or {}
            final_cwd = cwd or persisted.get("cwd")
            final_agent_sid = agent_session_id or persisted.get("agent_session_id")
            fallback_paths = self._codex_paths_for_session(session_id)
            codex_paths = self._prepare_codex_paths(
                session_id,
                config_path=config_path,
                fallback=fallback_paths,
            )
            final_use_proxy = normalize_use_proxy(
                use_proxy,
                persisted.get("use_proxy") if persisted.get("use_proxy") is not None else False,
            )
            if not final_cwd:
                raise RuntimeError(f"session {session_id} has no live window and no cwd")
            final_profile_key = codex_profile_key or persisted.get("codex_profile_key")
            final_profile_config = codex_config_path or codex_paths.get("codex_config_path")
            final_secret_env_key = codex_secret_env_key or persisted.get("codex_secret_env_key")
            if final_profile_key:
                codex_paths["codex_profile_key"] = final_profile_key
            if final_profile_config:
                codex_paths["codex_config_path"] = final_profile_config
            if final_secret_env_key:
                codex_paths["codex_secret_env_key"] = final_secret_env_key
            spawn_info = await self._spawn_window(
                session_id=session_id,
                cwd=final_cwd,
                flag_root=flag_root or persisted.get("flag_root") or final_cwd,
                model=model or persisted.get("model") or self.default_model,
                use_proxy=final_use_proxy,
                display_name=display_name or persisted.get("display_name"),
                agent_session_id=final_agent_sid,
                codex_paths=codex_paths,
                codex_profile_key=final_profile_key,
                codex_config_path=final_profile_config,
                codex_secret_env_key=final_secret_env_key,
                codex_secret_value=codex_secret_value,
            )
            cwd = final_cwd
            flag_root = flag_root or persisted.get("flag_root") or final_cwd
            model = model or persisted.get("model") or self.default_model
            use_proxy = final_use_proxy
            codex_profile_key = final_profile_key
            codex_config_path = final_profile_config
            codex_secret_env_key = final_secret_env_key
            display_name = display_name or persisted.get("display_name")
        else:
            if session_id in self.runtime and config_path:
                print(
                    f"[tmux-codex] configPath ignored for live window "
                    f"{session_id}; restart the session to change Codex files"
                )
            elif config_path:
                codex_paths = self._prepare_codex_paths(
                    session_id,
                    config_path=config_path,
                    fallback=codex_paths,
                )
            if codex_config_path:
                codex_paths["codex_config_path"] = codex_config_path
            if codex_profile_key:
                codex_paths["codex_profile_key"] = codex_profile_key
            if codex_secret_env_key:
                codex_paths["codex_secret_env_key"] = codex_secret_env_key
            await self._ensure_runtime_from_known_thread(
                session_id=session_id, cwd=cwd, flag_root=flag_root,
                model=model, use_proxy=use_proxy,
                display_name=display_name, agent_session_id=agent_session_id,
                codex_paths=codex_paths,
                codex_profile_key=codex_profile_key,
                codex_config_path=codex_config_path,
                codex_secret_env_key=codex_secret_env_key,
            )
            allow_updated_thread_fallback = True

        entry_for_paths = self.runtime.get(session_id) or {}
        if not cwd:
            cwd = entry_for_paths.get("cwd")
        if not model:
            model = entry_for_paths.get("model")
        if use_proxy is None:
            use_proxy = entry_for_paths.get("use_proxy")
        if not display_name:
            display_name = entry_for_paths.get("display_name")
        if not cwd:
            raise RuntimeError(f"session {session_id} has no cwd for Codex thread binding")

        bind_known_thread_ids = (
            (spawn_info or {}).get("knownThreadIds")
            or snapshot_thread_ids(codex_paths["codex_state_db"], cwd)
        )
        bind_since_ms = (spawn_info or {}).get("startedAt") or _now_ms()
        entry = self.runtime.get(session_id)
        if entry:
            entry["working"] = True
        mobius_jsonl_written = False
        if entry and entry.get("jsonl_path"):
            mobius_jsonl_written = self._append_mobius_prompt_entry(session_id, mobius_jsonl)
        await self._send_prompt_to_window(session_id, prompt)
        entry = self.runtime.get(session_id) or {}
        safe_write_running_flag(
            flag_root or entry.get("flag_root") or entry.get("cwd") or cwd,
            session_id, {"backend": "tmux-codex"}, "tmux-codex",
        )
        if not (self.runtime.get(session_id) or {}).get("agent_session_id"):
            await self._bind_runtime_after_prompt(
                session_id=session_id, cwd=cwd, flag_root=flag_root or cwd,
                model=model or self.default_model,
                use_proxy=normalize_use_proxy(use_proxy, False),
                display_name=display_name,
                since_ms=bind_since_ms, known_thread_ids=bind_known_thread_ids,
                allow_updated_thread_fallback=allow_updated_thread_fallback,
                codex_paths=codex_paths,
                codex_profile_key=codex_profile_key,
                codex_config_path=codex_config_path,
                codex_secret_env_key=codex_secret_env_key,
            )
            if not mobius_jsonl_written:
                self._append_mobius_prompt_entry(session_id, mobius_jsonl)

    async def _pause_impl(self, opts: dict) -> None:
        session_id = opts.get("sessionId")
        prompt = opts.get("prompt")
        cwd = opts.get("cwd")
        flag_root = opts.get("flagRoot")

        if not session_id:
            raise ValueError("sessionId required")
        persisted = self.runtime.get(session_id) or {}

        if window_exists(self.hub, session_id):
            for i in range(3):
                tmux(["send-keys", "-t", f"{self.hub}:{session_id}", "C-c"])
                if i < 2:
                    await _sleep_ms(50)
            if persisted:
                persisted["working"] = False
            await _sleep_ms(300)

        if not prompt:
            safe_remove_running_flag(
                flag_root or persisted.get("flag_root") or persisted.get("cwd") or cwd,
                session_id, "tmux-codex",
            )
            return
        await self._queue_impl({
            "sessionId": session_id,
            "prompt": prompt,
            "cwd": persisted.get("cwd"),
            "flagRoot": persisted.get("flag_root"),
            "model": persisted.get("model"),
            "useProxy": persisted.get("use_proxy"),
            "displayName": persisted.get("display_name"),
            "agentSessionId": persisted.get("agent_session_id"),
            "codexProfileKey": persisted.get("codex_profile_key"),
            "codexConfigPath": persisted.get("codex_config_path"),
            "codexSecretEnvKey": persisted.get("codex_secret_env_key"),
        })

    async def _terminate_impl(self, session_id: str) -> dict:
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
            print(f"[tmux-codex] terminate: killed window={session_id} (wasWorking={was_working})")
        flag_root = (entry or {}).get("flag_root") or (entry or {}).get("cwd")
        if flag_root:
            safe_remove_flag_dir(flag_root, session_id, "tmux-codex")
        return {"sessionId": session_id, "killed": was_alive, "wasWorking": was_working}

    # ------------------------------------------------------------------
    # Thread binding (Codex-specific)
    # ------------------------------------------------------------------
    async def _ensure_runtime_from_known_thread(
        self,
        *,
        session_id: str,
        cwd: Optional[str],
        flag_root: Optional[str],
        model: Optional[str],
        use_proxy: Any,
        display_name: Optional[str],
        agent_session_id: Optional[str],
        codex_paths: dict,
        codex_profile_key: Optional[str] = None,
        codex_config_path: Optional[str] = None,
        codex_secret_env_key: Optional[str] = None,
    ) -> Optional[dict]:
        """Bootstrap a runtime entry from a caller-supplied thread id.

        Used after a backend restart where the tmux window is still
        alive but our in-memory map is empty.
        """
        if session_id in self.runtime:
            return self.runtime[session_id]
        if not agent_session_id:
            return None
        jsonl_path = find_rollout_path_by_thread_id(
            codex_paths["codex_sessions_dir"], codex_paths["codex_state_db"], agent_session_id
        )
        if not jsonl_path:
            return None
        entry = {
            "agent_session_id": agent_session_id,
            "cwd": cwd,
            "flag_root": flag_root or cwd,
            "model": model or self.default_model,
            "use_proxy": normalize_use_proxy(use_proxy, False),
            "display_name": display_name,
            "jsonl_path": jsonl_path,
            "started_at": _now_ms(),
            "working": False,
            "watch": None,
            "codex_home": codex_paths["codex_home"],
            "config_path": codex_paths["config_path"],
            "codex_state_db": codex_paths["codex_state_db"],
            "codex_sessions_dir": codex_paths["codex_sessions_dir"],
            "codex_profile_key": codex_profile_key or codex_paths.get("codex_profile_key"),
            "codex_config_path": codex_config_path or codex_paths.get("codex_config_path"),
            "codex_secret_env_key": codex_secret_env_key or codex_paths.get("codex_secret_env_key"),
        }
        self.runtime[session_id] = entry
        self._persist_entry(session_id, {
            "agentSessionId": agent_session_id,
            "cwd": cwd,
            "flagRoot": flag_root or cwd,
            "model": model or self.default_model,
            "useProxy": entry["use_proxy"],
            "displayName": display_name,
            "jsonlPath": jsonl_path,
            "startedAt": entry["started_at"],
            "pendingBind": False,
            "codexSecretEnvKey": entry.get("codex_secret_env_key"),
            **self._persisted_codex_paths(codex_paths),
        })
        self._ensure_watcher(session_id)
        return entry

    async def _bind_runtime_after_prompt(
        self,
        *,
        session_id: str,
        cwd: str,
        flag_root: str,
        model: Optional[str],
        use_proxy: bool,
        display_name: Optional[str],
        since_ms: int,
        known_thread_ids: Set[str],
        allow_updated_thread_fallback: bool = False,
        codex_paths: Optional[dict] = None,
        codex_profile_key: Optional[str] = None,
        codex_config_path: Optional[str] = None,
        codex_secret_env_key: Optional[str] = None,
    ) -> dict:
        """Poll ``state_5.sqlite`` for the freshly-created thread and bind to it.

        Raises if no thread shows up within :data:`THREAD_BIND_TIMEOUT_MS`.
        """
        codex_paths = codex_paths or self._default_codex_paths()
        deadline = _now_ms() + THREAD_BIND_TIMEOUT_MS
        found: Optional[dict] = None
        found_by = "created"
        while _now_ms() < deadline:
            found = find_newest_thread(
                codex_paths["codex_state_db"],
                cwd=cwd,
                model=model or self.default_model,
                since_ms=since_ms or (_now_ms() - 10_000),
                exclude_ids=known_thread_ids or set(),
            )
            if found and found.get("id"):
                found_by = "created"
                break
            if allow_updated_thread_fallback:
                found = find_recently_updated_thread(
                    codex_paths["codex_state_db"],
                    cwd=cwd,
                    model=model or self.default_model,
                    since_ms=max(0, int(since_ms or _now_ms()) - THREAD_BIND_UPDATED_SKEW_MS),
                )
                if found and found.get("id"):
                    found_by = "updated"
                    break
            await _sleep_ms(THREAD_BIND_POLL_MS)
        if not found or not found.get("id"):
            raise RuntimeError(
                f"Codex thread was not recorded within {THREAD_BIND_TIMEOUT_MS}ms (cwd={cwd})"
            )

        jsonl_path = found.get("rollout_path") or find_rollout_path_by_thread_id(
            codex_paths["codex_sessions_dir"], codex_paths["codex_state_db"], found["id"]
        )
        if not jsonl_path:
            raise RuntimeError(f"Codex thread {found['id']} has no rollout_path")
        entry = {
            "agent_session_id": found["id"],
            "cwd": cwd,
            "flag_root": flag_root or cwd,
            "model": found.get("model") or model or self.default_model,
            "use_proxy": normalize_use_proxy(use_proxy, False),
            "display_name": display_name,
            "jsonl_path": jsonl_path,
            "started_at": found.get("created_ms") or _now_ms(),
            "working": True,
            "watch": None,
            "codex_home": codex_paths["codex_home"],
            "config_path": codex_paths["config_path"],
            "codex_state_db": codex_paths["codex_state_db"],
            "codex_sessions_dir": codex_paths["codex_sessions_dir"],
            "codex_profile_key": codex_profile_key or codex_paths.get("codex_profile_key"),
            "codex_config_path": codex_config_path or codex_paths.get("codex_config_path"),
            "codex_secret_env_key": codex_secret_env_key or codex_paths.get("codex_secret_env_key"),
        }
        self.runtime[session_id] = entry
        self._persist_entry(session_id, {
            "agentSessionId": found["id"],
            "cwd": cwd,
            "flagRoot": flag_root or cwd,
            "model": entry["model"],
            "useProxy": entry["use_proxy"],
            "displayName": display_name,
            "jsonlPath": jsonl_path,
            "startedAt": entry["started_at"],
            "pendingBind": False,
            "codexSecretEnvKey": entry.get("codex_secret_env_key"),
            **self._persisted_codex_paths(codex_paths),
        })
        # Start the watcher at byte 0 so any subscribers attached before
        # the bind still receive the prologue events.
        self._ensure_watcher(session_id, 0)
        print(
            f"[tmux-codex] bound window={session_id} to codex_thread={found['id']} "
            f"via {found_by} jsonl={jsonl_path}"
        )
        return entry

    def _update_working_from_entry(self, entry: dict, raw: Any) -> None:
        """Update the cached ``working`` flag based on a single new JSONL entry."""
        if not entry:
            return
        if is_codex_task_complete(raw):
            entry["working"] = False
        elif is_codex_task_start(raw):
            entry["working"] = True
        elif isinstance(raw, dict) and raw.get("type") == "response_item":
            pt = (raw.get("payload") or {}).get("type")
            if pt in ("function_call", "function_call_output", "reasoning", "message"):
                entry["working"] = True

    # ------------------------------------------------------------------
    # Window lifecycle
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
        codex_paths: Optional[dict] = None,
        codex_profile_key: Optional[str] = None,
        codex_config_path: Optional[str] = None,
        codex_secret_env_key: Optional[str] = None,
        codex_secret_value: Optional[str] = None,
    ) -> dict:
        codex_paths = codex_paths or self._default_codex_paths()
        ensure_hub(self.hub)
        started_at = _now_ms()
        known_thread_ids = snapshot_thread_ids(codex_paths["codex_state_db"], cwd)
        eff_flag_root = flag_root or cwd
        final_model = model or self.default_model
        # ``use_proxy`` now comes exclusively from the model registry entry
        # (per-model ``useProxy``); the admin-settings default for
        # ``tmux-codex`` is intentionally disabled because every model owns
        # its own proxy flag now.
        final_use_proxy = normalize_use_proxy(use_proxy, False)
        if final_use_proxy:
            assert_proxy_available(self.proxy_envs, self.proxy_conf)

        use_resume = bool(agent_session_id)
        rollout_path: Optional[str] = None
        if use_resume:
            rollout_path = find_rollout_path_by_thread_id(
                codex_paths["codex_sessions_dir"], codex_paths["codex_state_db"], agent_session_id
            )
            if not rollout_path:
                print(
                    f"[tmux-codex] resume target rollout not found ({agent_session_id}); "
                    f"starting a new thread"
                )
                use_resume = False

        # Codex is always invoked with ``--profile <channel>`` so the
        # provider config lives in ``$CODEX_HOME/<channel>.config.toml``.
        # If the TOML declares env_key, api_key is supplied via explicit export.
        profile_key = normalize_codex_channel(codex_profile_key or codex_paths.get("codex_profile_key"))
        expected_config_path = os.path.join(codex_paths["codex_home"], f"{profile_key}.config.toml")
        if not os.path.exists(expected_config_path):
            raise FileNotFoundError(f"codex channel config missing: {expected_config_path}")
        with open(expected_config_path, "r", encoding="utf-8") as f:
            config_text = f.read()
        config_env_key = toml_string_value(config_text, "env_key")
        secret_env_key = normalize_secret_env_key(config_env_key) if config_env_key else None
        secret_value = (
            resolve_secret_value(secret_env_key, toml_string_value(config_text, "api_key") or codex_secret_value)
            if secret_env_key
            else ""
        )
        profile_arg = f"--profile {shell_quote(profile_key)}"
        codex_args = ["-m", final_model, "-C", cwd, "--dangerously-bypass-approvals-and-sandbox"]
        if use_resume:
            codex_args.append(agent_session_id)
        subcommand = "resume " if use_resume else ""
        arg_str = " ".join(shell_quote(a) for a in codex_args)

        cmd_lines = [
            "unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE "
            "VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN",
            "export IS_SANDBOX=1",
            f"export CODEX_HOME={shell_quote(codex_paths['codex_home'])}",
        ]
        if secret_env_key:
            cmd_lines.append(f"export {secret_env_key}={shell_quote(secret_value)}")
        if final_use_proxy:
            cmd_lines.append(
                f"if [[ -f {shell_quote(self.proxy_envs)} ]]; then "
                f"source {shell_quote(self.proxy_envs)}; fi"
            )
            cmd_lines.append(
                f"exec proxychains -q -f {shell_quote(self.proxy_conf)} "
                f"codex {profile_arg} {subcommand}{arg_str}"
            )
        else:
            cmd_lines.append(f"exec codex {profile_arg} {subcommand}{arg_str}")
        cmd = " && ".join(cmd_lines)

        ensure_project_trusted(codex_paths["codex_home"], codex_paths["config_path"], cwd)

        r = tmux(["new-window", "-t", self.hub, "-n", session_id, "-c", cwd, "bash", "-lc", cmd])
        if r.returncode != 0:
            raise RuntimeError(f"tmux new-window failed: {r.stderr}")
        print(
            f"[tmux-codex] started: window={session_id} cwd={cwd} model={final_model} "
            f"use_proxy={1 if final_use_proxy else 0} profile={profile_key} secret_env={secret_env_key} "
            f"codex_home={codex_paths['codex_home']}"
            + (f" resume={agent_session_id}" if use_resume else "")
        )

        deadline = _now_ms() + READY_TIMEOUT_MS
        ready = False
        last_trust_press = 0
        last_update_press = 0
        last_screen = ""
        while _now_ms() < deadline:
            cap = tmux(["capture-pane", "-pt", f"{self.hub}:{session_id}", "-p", "-S", "-200"])
            screen = cap.stdout if cap.returncode == 0 else ""
            last_screen = screen or last_screen
            if all(s in screen for s in READY_SENTINELS):
                ready = True
                break
            if all(s in screen for s in UPDATE_PROMPT_SENTINELS):
                now = _now_ms()
                if now - last_update_press > UPDATE_PRESS_INTERVAL_MS:
                    tmux(["send-keys", "-t", f"{self.hub}:{session_id}", "2", "Enter"])
                    last_update_press = now
                    print(f"[tmux-codex] window={session_id} skipped Codex update prompt (cwd={cwd})")
            if any(s in screen for s in TRUST_PROMPT_SENTINELS):
                now = _now_ms()
                if now - last_trust_press > TRUST_PRESS_INTERVAL_MS:
                    tmux(["send-keys", "-t", f"{self.hub}:{session_id}", "Enter"])
                    last_trust_press = now
                    print(
                        f"[tmux-codex] window={session_id} confirmed Codex directory trust "
                        f"(cwd={cwd})"
                    )
            await _sleep_ms(READY_POLL_MS)
        if not ready:
            tmux(["kill-window", "-t", f"{self.hub}:{session_id}"])
            detail = summarize_screen(last_screen)
            tail = f"; last screen:\n{detail}" if detail else ""
            raise RuntimeError(
                f"Codex TUI was not ready within {READY_TIMEOUT_MS}ms (cwd={cwd}){tail}"
            )
        print(f"[tmux-codex] window={session_id} TUI ready")

        if not use_resume:
            entry = {
                "agent_session_id": None,
                "cwd": cwd,
                "flag_root": eff_flag_root,
                "model": final_model,
                "use_proxy": final_use_proxy,
                "display_name": display_name,
                "jsonl_path": None,
                "started_at": started_at,
                "working": False,
                "watch": None,
                "codex_home": codex_paths["codex_home"],
                "config_path": codex_paths["config_path"],
                "codex_state_db": codex_paths["codex_state_db"],
                "codex_sessions_dir": codex_paths["codex_sessions_dir"],
                "codex_profile_key": profile_key,
                "codex_config_path": codex_config_path or expected_config_path,
                "codex_secret_env_key": secret_env_key,
            }
            self.runtime[session_id] = entry
            self._persist_entry(session_id, {
                "cwd": cwd,
                "flagRoot": eff_flag_root,
                "model": final_model,
                "useProxy": final_use_proxy,
                "displayName": display_name,
                "startedAt": started_at,
                "pendingBind": True,
                "codexSecretEnvKey": secret_env_key,
                "codexProfileKey": profile_key,
                "codexConfigPath": codex_config_path or expected_config_path,
                **self._persisted_codex_paths(codex_paths),
            })
        else:
            entry = {
                "agent_session_id": agent_session_id,
                "cwd": cwd,
                "flag_root": eff_flag_root,
                "model": final_model,
                "use_proxy": final_use_proxy,
                "display_name": display_name,
                "jsonl_path": rollout_path,
                "started_at": started_at,
                "working": False,
                "watch": None,
                "codex_home": codex_paths["codex_home"],
                "config_path": codex_paths["config_path"],
                "codex_state_db": codex_paths["codex_state_db"],
                "codex_sessions_dir": codex_paths["codex_sessions_dir"],
                "codex_profile_key": profile_key,
                "codex_config_path": codex_config_path or expected_config_path,
                "codex_secret_env_key": secret_env_key,
            }
            self.runtime[session_id] = entry
            self._persist_entry(session_id, {
                "agentSessionId": agent_session_id,
                "cwd": cwd,
                "flagRoot": eff_flag_root,
                "model": final_model,
                "useProxy": final_use_proxy,
                "displayName": display_name,
                "jsonlPath": rollout_path,
                "startedAt": started_at,
                "pendingBind": False,
                "codexSecretEnvKey": secret_env_key,
                "codexProfileKey": profile_key,
                "codexConfigPath": codex_config_path or expected_config_path,
                **self._persisted_codex_paths(codex_paths),
            })
            self._ensure_watcher(session_id)

        safe_write_running_flag(eff_flag_root, session_id, {"backend": "tmux-codex"}, "tmux-codex")
        return {"startedAt": started_at, "knownThreadIds": known_thread_ids}

    async def _send_prompt_to_window(self, session_id: str, text: str) -> None:
        """Paste ``text`` into Codex's TUI and submit it (see Claude backend for the dance)."""
        if not window_exists(self.hub, session_id):
            raise RuntimeError(f"window {session_id} does not exist")
        marker = find_ascii_tail_marker(text)
        marker_dbg = repr(marker) if marker else "(none)"
        print(f"[tmux-codex] sendPrompt window={session_id} len={len(text)} marker={marker_dbg}")

        buf_name = f"aimax_codex_{os.getpid()}_{_now_ms()}"
        r1 = tmux(["load-buffer", "-b", buf_name, "-"], input=text)
        if r1.returncode != 0:
            raise RuntimeError(f"tmux load-buffer failed: {r1.stderr}")

        r2 = tmux([
            "paste-buffer", "-p", "-d", "-b", buf_name, "-t", f"{self.hub}:{session_id}",
        ])
        if r2.returncode != 0:
            tmux(["delete-buffer", "-b", buf_name])
            raise RuntimeError(f"tmux paste-buffer failed: {r2.stderr}")

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
                    f"[tmux-codex] paste marker did not appear within "
                    f"{PASTE_PROBE_TIMEOUT_MS}ms; sending Enter anyway"
                )
        else:
            sleep_ms = min(PASTE_SLEEP_MAX_MS, max(PASTE_SLEEP_BASE_MS, int(len(text) * 0.5)))
            await _sleep_ms(sleep_ms)

        entry = self.runtime.get(session_id)
        if entry:
            entry["working"] = True
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
    "TmuxCodexBackend",
    "find_rollout_path_by_thread_id",
    "snapshot_thread_ids",
    "find_newest_thread",
    "find_recently_updated_thread",
    "find_ascii_tail_marker",
    "shell_quote",
    "normalize_use_proxy",
]
