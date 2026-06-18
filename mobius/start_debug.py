#!/usr/bin/env python3

#   ┌────────────────┬─────────────────────────────────────────────────────────────────────┐
#   │ 项目           │ 值                                                                  │
#   ├────────────────┼─────────────────────────────────────────────────────────────────────┤
#   │ 前端编译后在哪  │ debug 模式不编译前端；无编译产物                                    │
#   │ 后端编译后在哪  │ 无编译产物，后端直接跑源码：/home/user/imac-test/mobius/server.js │
#   │ 前端运行 cwd   │ /home/user/imac-test/mobius/frontend                              │
#   │ 后端运行 cwd   │ /home/user/imac-test/mobius                                       │
#   │ 前端运行命令    │ npm run dev -- --host "$VITE_HOST"                                  │
#   │ 后端运行命令    │ node --watch server.js                                              │
#   └────────────────┴─────────────────────────────────────────────────────────────────────┘

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from imac_runtime import (  # noqa: E402
    ConfigError,
    EnvFileLoader,
    RUNTIME_SETTINGS,
    add_tmux_environment,
    kill_tcp_port_with_lsof,
    kill_tmux_session,
    run,
    safe_tmux_environment,
    ss_lines_for_ports,
    tee_command,
    tmux_session_exists,
)


HERE = Path(__file__).resolve().parent
SESSION = "imac-mobius"
KNOWN_SETTINGS = RUNTIME_SETTINGS


def set_if_blank(key: str, value: str) -> None:
    if not os.environ.get(key):
        os.environ[key] = value


def set_if_missing(key: str, value: str) -> None:
    if key not in os.environ:
        os.environ[key] = value


def load_configuration() -> None:
    loader = EnvFileLoader(KNOWN_SETTINGS)
    loader.mark_preexisting()
    loader.load_dotenv(REPO_ROOT / ".env", "loaded from .env")
    loader.load_dotenv(REPO_ROOT / ".env.default", "loaded from .env.default")

    debug_env_file = os.environ.get("IMAC_DEBUG_ENV_FILE")
    if debug_env_file:
        loader.load_runtime_json(Path(debug_env_file), "loaded from debug env")

    backend_port = os.environ.get("MOBIUS_PORT") or "45614"
    frontend_port = os.environ.get("VITE_PORT") or "45616"
    frontend_host = os.environ.get("VITE_HOST") or "0.0.0.0"

    os.environ["MOBIUS_PORT"] = backend_port
    os.environ["VITE_PORT"] = frontend_port
    os.environ["VITE_HOST"] = frontend_host
    set_if_blank("VITE_API_TARGET", f"http://0.0.0.0:{backend_port}")
    set_if_missing("VITE_HMR_PROTOCOL", "wss")
    set_if_missing("VITE_HMR_CLIENT_PORT", "443")

    core_data = os.environ.get("CORE_DATA_PATH") or str(REPO_ROOT / "protected_data")
    os.environ.setdefault("AIMUX_BRIDGE_HOST", "127.0.0.1")
    os.environ.setdefault("AIMUX_BRIDGE_PORT", "45615")
    # AIMUX_BRIDGE_RUNTIME 不显式设: 让 aimux CLI/broker 走自身默认 fallback (~/.aimux/bridge/runtime.json).
    # 这样 agent 调 aimux CLI 时无需 export env, 跟 aimux 0.1.3 上游行为一致.
    # 若调用方显式设了 AIMUX_BRIDGE_RUNTIME (如老部署 / 容器化场景), ecosystem.config.js envKeys 仍会透传.


def reset_tmux_session() -> None:
    if tmux_session_exists(SESSION):
        print(f"kill existing {SESSION}")
        kill_tmux_session(SESSION)


def free_application_ports() -> None:
    for port in [os.environ["MOBIUS_PORT"], os.environ["VITE_PORT"], os.environ.get("AIMUX_BRIDGE_PORT", "45615")]:
        if kill_tcp_port_with_lsof(port):
            print(f"port {port} occupied, killing")
    time.sleep(1)


def ensure_aimux_bridge_venv() -> None:
    venv_aimux = HERE / ".venv-aimux" / "bin" / "aimux"
    if venv_aimux.exists():
        return
    print("setting up aimux bridge venv (mobius/.venv-aimux)")
    run(["bash", str(HERE / "scripts" / "setup-aimux-bridge.sh")], cwd=HERE)


def start_backend() -> None:
    command = tee_command(["node", "--watch", "server.js"], "/tmp/mobius-server.log")
    env = safe_tmux_environment(os.environ)

    argv = [
        "tmux",
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-n",
        "mobius",
        "-c",
        HERE,
    ]
    add_tmux_environment(argv, env)
    argv.append(command)
    run(argv)


def start_frontend() -> None:
    command = tee_command(
        ["npm", "run", "dev", "--", "--host", os.environ["VITE_HOST"]],
        "/tmp/mobius-vite.log",
    )
    env = safe_tmux_environment(os.environ)

    argv = [
        "tmux",
        "split-window",
        "-t",
        f"{SESSION}:mobius",
        "-h",
        "-c",
        HERE / "frontend",
    ]
    add_tmux_environment(argv, env)
    argv.append(command)
    run(argv)


def start_aimux_bridge() -> None:
    bridge_bin = HERE / ".venv-aimux" / "bin" / "aimux"
    if not bridge_bin.exists():
        print(f"aimux bridge binary missing at {bridge_bin}, skipping bridge window")
        return
    command = tee_command(
        [
            str(bridge_bin),
            "bridge",
            "deploy",
            "--host",
            os.environ["AIMUX_BRIDGE_HOST"],
            "--port",
            os.environ["AIMUX_BRIDGE_PORT"],
        ],
        "/tmp/mobius-bridge.log",
    )
    env = safe_tmux_environment(os.environ)

    argv = [
        "tmux",
        "new-window",
        "-t",
        SESSION,
        "-n",
        "aimux-bridge",
        "-c",
        HERE,
    ]
    add_tmux_environment(argv, env)
    argv.append(command)
    run(argv)


def print_status() -> None:
    backend_port = os.environ["MOBIUS_PORT"]
    frontend_port = os.environ["VITE_PORT"]
    bridge_port = os.environ.get("AIMUX_BRIDGE_PORT", "45615")

    print()
    print("=== 实验栈状态 ===")
    for line in ss_lines_for_ports([backend_port, frontend_port, bridge_port], include_process=True):
        print(line)

    print()
    print(f"✅ tmux session: {SESSION}")
    print(f"✅ backend:       http://0.0.0.0:{backend_port}/api/v2/health")
    print(f"✅ frontend:      http://0.0.0.0:{frontend_port}")
    print(f"✅ aimux bridge:  http://127.0.0.1:{bridge_port} (proxy: /aimux_bridge/*)")
    print()
    print(f"attach 查日志:  tmux attach -t {SESSION}")
    print(f"全停:           tmux kill-session -t {SESSION}")


def main() -> int:
    try:
        load_configuration()
        ensure_aimux_bridge_venv()
        reset_tmux_session()
        free_application_ports()
        start_backend()
        time.sleep(0.5)
        start_frontend()
        start_aimux_bridge()
        time.sleep(4)
        print_status()
        return 0
    except ConfigError as exc:
        print(f"start_debug.py: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"start_debug.py: command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
