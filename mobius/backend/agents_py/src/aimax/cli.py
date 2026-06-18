"""Friendly command-line interface for :mod:`aimax`.

Installed as the ``aimax`` console script. The entry point is
:func:`main` (or :func:`main_argv` for programmatic invocation).

Design goals
============

* **Discoverable**: ``aimax`` (no args) prints a friendly help
  with the most common workflows; every subcommand has its own
  ``--help`` with examples.
* **Predictable output**: every command supports ``--json`` to emit
  machine-readable JSON; the human format is plain text with stable
  field names.
* **No magic**: the CLI is a thin shim over the public Python API; the
  same kwargs map cleanly across both surfaces.

Subcommands
-----------

::

    aimax create   --backend ... --session ... --cwd ... --prompt ...
    aimax send     --backend ... --session ... --prompt ...
    aimax pause    --backend ... --session ... [--prompt ...]
    aimax stop     --backend ... --session ...
    aimax list     [--backend ...]
    aimax status   --backend ... --session ...
    aimax history  --backend ... --session ... [--tail N]
    aimax stream   --backend ... --session ... [--from-sentinel BYTES] [--max N]
    aimax config   show
    aimax admin    show
    aimax version
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import threading
from typing import Any, Iterable, Optional, Sequence

from . import SUPPORTED_BACKENDS, __version__, get
from .config import ENV_VAR_MAP, get_config
from .services import admin_settings


# ---------------------------------------------------------------------------
# Pretty-printing helpers
# ---------------------------------------------------------------------------
# ANSI colour helpers — disabled automatically when stdout is not a TTY or
# when ``NO_COLOR`` is set (https://no-color.org/).
def _use_color() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def _c(code: str, text: str) -> str:
    if not _use_color():
        return text
    return f"\x1b[{code}m{text}\x1b[0m"


def _bold(text: str) -> str:
    return _c("1", text)


def _dim(text: str) -> str:
    return _c("2", text)


def _green(text: str) -> str:
    return _c("32", text)


def _yellow(text: str) -> str:
    return _c("33", text)


def _red(text: str) -> str:
    return _c("31", text)


def _cyan(text: str) -> str:
    return _c("36", text)


def _emit_json(obj: Any) -> None:
    """Print ``obj`` as one indented JSON document. No trailing newline beyond ``print``'s."""
    json.dump(obj, sys.stdout, indent=2, ensure_ascii=False, default=str)
    print()


def _emit(obj: Any, args: argparse.Namespace) -> None:
    """Emit ``obj`` either as JSON or as a human-friendly summary, per ``--json``."""
    if getattr(args, "json", False):
        _emit_json(obj)
        return
    # Fall back to the JSON dump for unstructured data; subcommands that
    # want a custom human format should print themselves and ``return``.
    _emit_json(obj)


# ---------------------------------------------------------------------------
# Common argparse plumbing
# ---------------------------------------------------------------------------
def _add_common_flags(p: argparse.ArgumentParser, *, want_session: bool = True) -> None:
    """Attach ``--backend``, ``--session`` and ``--json`` to ``p``."""
    p.add_argument(
        "--backend",
        "-b",
        choices=SUPPORTED_BACKENDS,
        required=True,
        help="Which backend to talk to.",
    )
    if want_session:
        p.add_argument(
            "--session",
            "-s",
            required=True,
            help="The session id (= tmux window name).",
        )
    p.add_argument(
        "--json",
        action="store_true",
        help="Emit results as JSON instead of human-readable text.",
    )


def _read_prompt(args: argparse.Namespace) -> Optional[str]:
    """Resolve the prompt from ``--prompt`` / ``--prompt-file`` / stdin.

    Precedence: explicit ``--prompt`` text > ``--prompt-file`` content >
    stdin (only when neither flag is set *and* stdin is not a TTY).
    Returns ``None`` if no prompt is found at all — the caller decides
    whether that is fatal.
    """
    if getattr(args, "prompt", None):
        return args.prompt
    fpath = getattr(args, "prompt_file", None)
    if fpath:
        if fpath == "-":
            return sys.stdin.read()
        with open(fpath, "r", encoding="utf-8") as f:
            return f.read()
    # Implicit stdin: only when we're not on a terminal (i.e. piped).
    if not sys.stdin.isatty():
        data = sys.stdin.read()
        return data or None
    return None


def _parse_sentinel(value: Optional[str]) -> Any:
    """Parse ``--from-sentinel`` as either a byte offset or JSON object."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.startswith("{"):
        return json.loads(text)
    try:
        return int(text)
    except ValueError:
        return json.loads(text)


def _add_prompt_flags(p: argparse.ArgumentParser, *, required: bool) -> None:
    """Attach the ``--prompt`` / ``--prompt-file`` flag pair.

    Required prompts must be present *somewhere* (flag, file, or stdin);
    optional prompts can be omitted entirely. The actual resolution is
    in :func:`_read_prompt`.
    """
    group = p.add_argument_group(
        "prompt" + (" (required)" if required else " (optional)"),
        "Provide the prompt via flag, file, or stdin (pipe).",
    )
    group.add_argument("--prompt", "-p", help="Inline prompt text.")
    group.add_argument(
        "--prompt-file",
        "-f",
        help="Read the prompt from a file. Pass ``-`` for stdin.",
    )


def _add_agent_file_flags(p: argparse.ArgumentParser) -> None:
    group = p.add_argument_group(
        "agent config files",
        "Optional per-session config files. Backend-specific flags are ignored by the other backend.",
    )
    group.add_argument(
        "--codex-config-path",
        help="Codex config.toml to use for this session.",
    )
    group.add_argument(
        "--settings-path",
        help="Claude Code settings JSON path to use for this session.",
    )
    group.add_argument(
        "--force-no-proxy",
        action="store_true",
        help="Claude Code only: force direct mode even if proxy defaults are enabled.",
    )


def _resolve_backend(name: str):
    """Return the backend singleton, handling preflight failures gracefully."""
    try:
        return get(name)
    except SystemExit:  # preflight exit
        raise
    except Exception as e:
        print(_red(f"Failed to initialise backend {name!r}: {e}"), file=sys.stderr)
        sys.exit(2)


# ---------------------------------------------------------------------------
# Subcommand implementations
# ---------------------------------------------------------------------------
def _cmd_create(args: argparse.Namespace) -> int:
    """``aimax create`` — start a new session and submit the first prompt."""
    prompt = _read_prompt(args)
    if not prompt:
        print(
            _red("create: a prompt is required (--prompt / --prompt-file / piped stdin)"),
            file=sys.stderr,
        )
        return 2
    backend = _resolve_backend(args.backend)

    opts = {
        "sessionId": args.session,
        "cwd": os.path.abspath(args.cwd),
        "initialPrompt": prompt,
    }
    if args.flag_root:
        opts["flagRoot"] = os.path.abspath(args.flag_root)
    if args.model:
        opts["model"] = args.model
    if args.display_name:
        opts["displayName"] = args.display_name
    if args.use_proxy is not None:
        opts["useProxy"] = args.use_proxy
    if args.agent_session_id:
        opts["agentSessionId"] = args.agent_session_id
    if args.codex_config_path:
        opts["configPath"] = os.path.abspath(args.codex_config_path)
    if args.settings_path:
        opts["settingsPath"] = os.path.abspath(args.settings_path)
    if args.force_no_proxy:
        opts["forceNoProxy"] = True

    result = asyncio.run(backend.create_new_session(opts))
    if args.json:
        _emit_json(result)
    else:
        print(_green(f"✓ Session {_bold(args.session)} created on {args.backend}"))
        print(_dim(f"  cwd:              {opts['cwd']}"))
        print(_dim(f"  agent_session_id: {result.get('agentSessionId')}"))
        print(_dim(f"  jsonl_path:       {result.get('jsonlPath')}"))
    return 0


def _cmd_send(args: argparse.Namespace) -> int:
    """``aimax send`` — queue a prompt without interrupting the current turn."""
    prompt = _read_prompt(args)
    if not prompt:
        print(
            _red("send: a prompt is required (--prompt / --prompt-file / piped stdin)"),
            file=sys.stderr,
        )
        return 2
    backend = _resolve_backend(args.backend)

    opts: dict = {"sessionId": args.session, "prompt": prompt}
    if args.cwd:
        opts["cwd"] = os.path.abspath(args.cwd)
    if args.flag_root:
        opts["flagRoot"] = os.path.abspath(args.flag_root)
    if args.model:
        opts["model"] = args.model
    if args.display_name:
        opts["displayName"] = args.display_name
    if args.use_proxy is not None:
        opts["useProxy"] = args.use_proxy
    if args.agent_session_id:
        opts["agentSessionId"] = args.agent_session_id
    if args.codex_config_path:
        opts["configPath"] = os.path.abspath(args.codex_config_path)
    if args.settings_path:
        opts["settingsPath"] = os.path.abspath(args.settings_path)
    if args.force_no_proxy:
        opts["forceNoProxy"] = True

    asyncio.run(backend.no_pause_current_and_queue_query_at_session(opts))
    if args.json:
        _emit_json({"ok": True, "sessionId": args.session, "promptLength": len(prompt)})
    else:
        print(_green(f"✓ Sent {len(prompt)} chars to {_bold(args.session)}"))
    return 0


def _cmd_pause(args: argparse.Namespace) -> int:
    """``aimax pause`` — interrupt with C-c×3 and optionally resend a prompt."""
    prompt = _read_prompt(args)  # optional here
    backend = _resolve_backend(args.backend)

    opts: dict = {"sessionId": args.session}
    if prompt:
        opts["prompt"] = prompt
    if args.cwd:
        opts["cwd"] = os.path.abspath(args.cwd)
    if args.flag_root:
        opts["flagRoot"] = os.path.abspath(args.flag_root)

    asyncio.run(backend.pause_current_and_resume_from_session(opts))
    if args.json:
        _emit_json({"ok": True, "sessionId": args.session, "resentPrompt": bool(prompt)})
    else:
        if prompt:
            print(_green(f"✓ Paused {_bold(args.session)} and resent {len(prompt)} chars"))
        else:
            print(_green(f"✓ Paused {_bold(args.session)} (no new prompt)"))
    return 0


def _cmd_stop(args: argparse.Namespace) -> int:
    """``aimax stop`` — kill the tmux window and drop the runtime entry."""
    backend = _resolve_backend(args.backend)
    result = asyncio.run(backend.terminate_session(args.session))
    if args.json:
        _emit_json(result)
    else:
        if result.get("killed"):
            warn = _yellow(" (was working)") if result.get("wasWorking") else ""
            print(_green(f"✓ Stopped {_bold(args.session)}") + warn)
        else:
            print(_dim(f"· {args.session} was not running"))
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    """``aimax list`` — show every live session of one or both backends."""
    backends = [args.backend] if args.backend else list(SUPPORTED_BACKENDS)
    all_sessions: dict = {}
    for name in backends:
        try:
            b = _resolve_backend(name)
            all_sessions[name] = b.list_sessions()
        except SystemExit:
            raise
        except Exception as e:
            all_sessions[name] = {"error": str(e)}

    if args.json:
        _emit_json(all_sessions)
        return 0

    if not any(all_sessions.values()):
        print(_dim("No live sessions."))
        return 0

    for name, sessions in all_sessions.items():
        print(_bold(_cyan(f"[{name}]")))
        if isinstance(sessions, dict) and "error" in sessions:
            print(_red(f"  error: {sessions['error']}"))
            continue
        if not sessions:
            print(_dim("  (none)"))
            continue
        for s in sessions:
            sid = s.get("sessionId", "?")
            pid = s.get("pid", "?")
            last = s.get("lastActivityAt") or _dim("never")
            dead = _red(" DEAD") if s.get("paneDead") else ""
            cmd = s.get("paneCurrentCommand") or "?"
            print(
                f"  {_green('●')} {_bold(sid)}  "
                f"pid={pid}  cmd={cmd}  last={last}{dead}"
            )
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    """``aimax status`` — quick health report for a single session."""
    backend = _resolve_backend(args.backend)
    status = {
        "sessionId": args.session,
        "backend": args.backend,
        "alive": backend.is_alive(args.session),
        "working": backend.is_working(args.session),
        "jobGoalAccomplished": backend.is_job_goal_accomplished(args.session),
        "failed": backend.is_failed(args.session),
        "useProxy": backend.get_session_use_proxy(args.session),
    }
    if args.json:
        _emit_json(status)
        return 0
    flag = _green("alive") if status["alive"] else _red("dead")
    work = _yellow("working") if status["working"] else _dim("idle")
    fail = _red("failed") if status["failed"] else _green("ok")
    done = _green("done") if status["jobGoalAccomplished"] else _yellow("running")
    proxy = (
        _green("yes") if status["useProxy"] is True
        else _red("no") if status["useProxy"] is False
        else _dim("unknown")
    )
    print(_bold(f"Session {args.session} ({args.backend})"))
    print(f"  status:  {flag}  {work}  {fail}  job: {done}")
    print(f"  proxy:   {proxy}")
    return 0


def _cmd_history(args: argparse.Namespace) -> int:
    """``aimax history`` — dump the JSONL history for a session."""
    backend = _resolve_backend(args.backend)
    h = backend.get_history(args.session)
    entries = h.get("entries", [])
    if args.tail and args.tail > 0:
        entries = entries[-args.tail :]
    if args.json:
        out = {**h, "entries": entries}
        _emit_json(out)
        return 0
    print(
        _bold(f"history for {args.session}: ")
        + f"{len(entries)} shown / {h.get('total', '?')} total"
        + (_yellow(" (truncated)") if h.get("truncated") else "")
    )
    for e in entries:
        # One compact JSON line per entry — easy to read with ``less -R``.
        try:
            print(json.dumps(e, ensure_ascii=False))
        except Exception:
            print(repr(e))
    return 0


def _cmd_stream(args: argparse.Namespace) -> int:
    """``aimax stream`` — print live raw events until ``--max`` is hit or SIGINT.

    A single-threaded stream made cooperative via an :class:`asyncio.Event`
    that fires when a) ``--max`` entries have arrived or b) the user
    sends ``SIGINT`` (Ctrl-C).
    """
    backend = _resolve_backend(args.backend)
    opts: dict = {}
    if args.from_sentinel is not None:
        opts["fromSentinel"] = _parse_sentinel(args.from_sentinel)

    received = 0
    done = threading.Event()
    max_n = args.max if args.max and args.max > 0 else None

    def on_event(raw: Any) -> None:
        nonlocal received
        try:
            print(json.dumps(raw, ensure_ascii=False))
            sys.stdout.flush()
        except Exception:
            print(repr(raw))
        received += 1
        if max_n is not None and received >= max_n:
            done.set()

    unsubscribe = backend.get_agent_raw_thought_stream(args.session, on_event, opts)

    # ``done.wait()`` blocks the main thread; the watcher feeds events
    # from its background poll loop. ``KeyboardInterrupt`` flips ``done``.
    def _sigint(_signo, _frame):
        done.set()

    prev = signal.signal(signal.SIGINT, _sigint)
    try:
        done.wait()
    finally:
        signal.signal(signal.SIGINT, prev)
        try:
            unsubscribe()
        except Exception:  # pragma: no cover — defensive
            pass

    if args.json:
        _emit_json({"received": received})
    else:
        print(_dim(f"\n· streamed {received} events"), file=sys.stderr)
    return 0


def _cmd_config_show(args: argparse.Namespace) -> int:
    """``aimax config show`` — print the active configuration."""
    cfg = get_config()
    # Expand to a serialisable shape — Paths become strings via ``default=str``.
    info = {
        "version": __version__,
        "config": {
            "home": str(cfg.home),
            "data_dir": str(cfg.data_dir),
            "codex_home": str(cfg.codex_home),
            "claude_hub": cfg.claude_hub,
            "codex_hub": cfg.codex_hub,
            "claude_config": str(cfg.claude_config),
            "claude_settings": str(cfg.claude_settings),
            "claude_projects_dir": str(cfg.claude_projects_dir),
            "codex_config": str(cfg.codex_config),
            "codex_state_db": str(cfg.codex_state_db),
            "codex_sessions_dir": str(cfg.codex_sessions_dir),
            "codex_default_model": cfg.codex_default_model,
            "proxy_envs_bash": str(cfg.proxy_envs_bash),
            "proxy_chains_conf": str(cfg.proxy_chains_conf),
            "run_preflight": cfg.run_preflight,
        },
        "derived_paths": {
            "claude_runtime_file": str(cfg.claude_runtime_file()),
            "claude_archive_file": str(cfg.claude_archive_file()),
            "codex_runtime_file": str(cfg.codex_runtime_file()),
            "codex_archive_file": str(cfg.codex_archive_file()),
            "codex_profiles_dir": str(cfg.codex_profiles_dir()),
            "admin_settings_file": str(cfg.admin_settings_file()),
        },
        "env_overrides": {env: attr for env, attr in ENV_VAR_MAP.items()},
    }
    if args.json:
        _emit_json(info)
        return 0
    print(_bold(f"aimax {__version__}"))
    print()
    print(_bold("config"))
    for k, v in info["config"].items():
        print(f"  {k:<22} {v}")
    print()
    print(_bold("derived paths"))
    for k, v in info["derived_paths"].items():
        print(f"  {k:<22} {v}")
    print()
    print(_dim("Override any of the above via env vars listed in `aimax config show --json`."))
    return 0


def _cmd_admin_show(args: argparse.Namespace) -> int:
    """``aimax admin show`` — current admin settings."""
    s = admin_settings.load_settings()
    if args.json:
        _emit_json(s)
        return 0
    print(_bold("admin settings"))
    per_model = (s.get("modelNetworkProxy") or {}).get("perModel") or {}
    if not per_model:
        print("  model proxy: empty")
    for model, use_proxy in sorted(per_model.items()):
        print(f"  {model:<22} useProxy={use_proxy}")
    return 0


def _cmd_version(args: argparse.Namespace) -> int:
    """``aimax version`` — print the package version."""
    if args.json:
        _emit_json({"version": __version__})
    else:
        print(__version__)
    return 0


# ---------------------------------------------------------------------------
# Argparse wiring
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    """Construct the top-level argparse parser with all subcommands attached."""
    parser = argparse.ArgumentParser(
        prog="aimax",
        description=(
            "Friendly CLI for aimax — drive Claude Code and Codex TUIs.\n"
            "\n"
            "Common workflows:\n"
            "  aimax create -b tmux-codex -s mywin --cwd ~/proj -p 'list files'\n"
            "  aimax send   -b tmux-codex -s mywin -p 'add a test'\n"
            "  aimax stream -b tmux-codex -s mywin\n"
            "  aimax list\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--version", action="version", version=f"aimax {__version__}")
    sub = parser.add_subparsers(dest="cmd", metavar="<command>")
    sub.required = True

    # --- create ---------------------------------------------------------
    p = sub.add_parser(
        "create",
        help="Start a new session and send the first prompt.",
        description="Start a new tmux-hosted agent session and submit its first prompt.",
    )
    _add_common_flags(p)
    p.add_argument("--cwd", required=True, help="Working directory the agent should operate in.")
    p.add_argument("--flag-root", help="Override the running.flag root (defaults to --cwd).")
    p.add_argument("--model", help="Pass through to the agent's --model flag.")
    p.add_argument("--display-name", help="Friendly label persisted for the session.")
    p.add_argument(
        "--use-proxy",
        type=lambda v: v.lower() in ("1", "true", "yes", "on"),
        default=None,
        help="Force proxychains on/off; default = direct unless the caller passes a model setting.",
    )
    p.add_argument(
        "--agent-session-id",
        help="Resume an existing agent thread id (Claude uuid / Codex thread id).",
    )
    _add_agent_file_flags(p)
    _add_prompt_flags(p, required=True)
    p.set_defaults(func=_cmd_create)

    # --- send -----------------------------------------------------------
    p = sub.add_parser(
        "send",
        help="Queue a follow-up prompt (no interrupt).",
        description=(
            "Submit a new prompt to an existing session. "
            "Spawns the window first if it isn't alive (provided --cwd is reachable)."
        ),
    )
    _add_common_flags(p)
    p.add_argument("--cwd", help="Required if the session needs to be respawned.")
    p.add_argument("--flag-root")
    p.add_argument("--model")
    p.add_argument("--display-name")
    p.add_argument(
        "--use-proxy",
        type=lambda v: v.lower() in ("1", "true", "yes", "on"),
        default=None,
    )
    p.add_argument("--agent-session-id")
    _add_agent_file_flags(p)
    _add_prompt_flags(p, required=True)
    p.set_defaults(func=_cmd_send)

    # --- pause ----------------------------------------------------------
    p = sub.add_parser(
        "pause",
        help="Interrupt the current turn (C-c×3); optionally send a new prompt.",
        description=(
            "Send three Ctrl-C bursts to stop whatever the agent is doing. "
            "If a prompt is provided, it is queued after the interrupt."
        ),
    )
    _add_common_flags(p)
    p.add_argument("--cwd")
    p.add_argument("--flag-root")
    _add_prompt_flags(p, required=False)
    p.set_defaults(func=_cmd_pause)

    # --- stop -----------------------------------------------------------
    p = sub.add_parser(
        "stop",
        help="Kill the session's tmux window.",
        description="Forcefully terminate the session — equivalent to ``tmux kill-window``.",
    )
    _add_common_flags(p)
    p.set_defaults(func=_cmd_stop)

    # --- list -----------------------------------------------------------
    p = sub.add_parser(
        "list",
        help="List live sessions on one or both backends.",
        description="Enumerate live tmux windows for one or both backends.",
    )
    p.add_argument("--backend", "-b", choices=SUPPORTED_BACKENDS, default=None)
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_list)

    # --- status ---------------------------------------------------------
    p = sub.add_parser(
        "status",
        help="Quick health report for one session.",
    )
    _add_common_flags(p)
    p.set_defaults(func=_cmd_status)

    # --- history --------------------------------------------------------
    p = sub.add_parser(
        "history",
        help="Dump the JSONL history for a session.",
    )
    _add_common_flags(p)
    p.add_argument("--tail", type=int, default=0, help="Show only the last N entries.")
    p.set_defaults(func=_cmd_history)

    # --- stream ---------------------------------------------------------
    p = sub.add_parser(
        "stream",
        help="Print live raw events until SIGINT (Ctrl-C).",
        description=(
            "Tail the live agent stream and emit one JSON line per event. "
            "Pair --from-sentinel with a value returned by `history --json` "
            "to splice history and live with no duplicates."
        ),
    )
    _add_common_flags(p)
    p.add_argument(
        "--from-sentinel",
        default=None,
        help="Byte offset or JSON sentinel object from `history --json`.",
    )
    p.add_argument("--max", type=int, default=0, help="Stop after N events (0 = infinite).")
    p.set_defaults(func=_cmd_stream)

    # --- config ---------------------------------------------------------
    p_cfg = sub.add_parser("config", help="Inspect configuration.")
    cfg_sub = p_cfg.add_subparsers(dest="cfg_cmd", metavar="<subcommand>")
    cfg_sub.required = True
    p = cfg_sub.add_parser("show", help="Print active config + env-var overrides.")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_config_show)

    # --- admin ----------------------------------------------------------
    p_adm = sub.add_parser("admin", help="Inspect persistent admin settings.")
    adm_sub = p_adm.add_subparsers(dest="adm_cmd", metavar="<subcommand>")
    adm_sub.required = True
    p = adm_sub.add_parser("show", help="Show current defaults.")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_admin_show)
    # --- version --------------------------------------------------------
    p = sub.add_parser("version", help="Print the package version.")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_version)

    return parser


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------
def main_argv(argv: Sequence[str]) -> int:
    """Parse ``argv`` (excluding ``argv[0]``) and dispatch. Returns exit code."""
    parser = _build_parser()
    args = parser.parse_args(list(argv))
    func = getattr(args, "func", None)
    if func is None:  # pragma: no cover — argparse ``required=True`` blocks this
        parser.print_help()
        return 2
    return int(func(args) or 0)


def main(argv: Optional[Iterable[str]] = None) -> int:
    """Console-script entry point. Honours ``KeyboardInterrupt`` cleanly."""
    if argv is None:
        argv = sys.argv[1:]
    try:
        return main_argv(list(argv))
    except KeyboardInterrupt:
        print(_dim("\n· interrupted"), file=sys.stderr)
        return 130
    except SystemExit:
        raise
    except Exception as e:
        # Last-resort safety net so users see a friendly error rather than
        # a stack trace. Set AIMAX_DEBUG=1 to opt back into tracebacks.
        if os.environ.get("AIMAX_DEBUG") or os.environ.get("TMUX_AGENTS_DEBUG"):
            raise
        print(_red(f"error: {e}"), file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
