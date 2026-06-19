#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

from imac_runtime import (
    ConfigError,
    EnvFileLoader,
    RUNTIME_SETTINGS,
    VSCODE_IPC_ENV,
    add_tmux_environment,
    kill_tcp_port_with_fuser,
    kill_tmux_session,
    mask_setting_value,
    ordered_unique,
    port_is_listening,
    run,
    safe_tmux_environment,
    tee_command,
    tmux_session_exists,
    utc_timestamp,
    write_json_private,
)


KNOWN_SETTINGS = RUNTIME_SETTINGS


def parse_args(description: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--detach",
        action="store_true",
        help="restart services without attaching to logs/session",
    )
    parser.add_argument(
        "--other-versions",
        metavar="GIT_HASH",
        help="build and serve Mobius from another git commit hash",
    )
    parser.add_argument(
        "--hard-reset",
        metavar="GIT_HASH",
        help="save current HEAD to discard/<timestamp>, reset hard to the commit, then rebuild in place",
    )
    parser.add_argument(
        "--force-vscode-server-restart",
        action="store_true",
        help="restart code-server even when the existing server is healthy",
    )
    parser.add_argument(
        "--only-update-frontend",
        action="store_true",
        help="compile and replace static frontend without restarting backend",
    )
    return parser.parse_args()


def load_configuration(run_cwd: Path, script_name: str) -> tuple[EnvFileLoader, Path, Path, str, str]:
    loader = EnvFileLoader(KNOWN_SETTINGS)
    loader.mark_preexisting()

    env_file = run_cwd / ".env"
    env_default_file = run_cwd / ".env.default"
    env_file_status = loader.load_dotenv(env_file, "loaded from .env")
    env_default_file_status = loader.load_dotenv(
        env_default_file,
        "loaded from .env.default",
        require_non_empty=True,
    )

    for key in [
        "APP_DIR",
        "MOBIUS_PORT",
        "VITE_PORT",
        "VITE_HOST",
        "CODE_SERVER_PORT",
        "CODE_SERVER_CWD",
        "CS_BIN"
    ]:
        loader.require(key, script_name)

    app_dir = os.environ["APP_DIR"]
    mobius_port = os.environ["MOBIUS_PORT"]
    code_server_port = os.environ["CODE_SERVER_PORT"]

    loader.set_default("IMAC_DEBUG_ENV_FILE", f"{app_dir}/.imac/debug-env.json")
    loader.set_default("VITE_API_TARGET", f"http://0.0.0.0:{mobius_port}")
    loader.set_default("CODE_SERVER_BIND", f"127.0.0.1:{code_server_port}")
    loader.set_default("VSCODE_WEB_URL", f"http://0.0.0.0:{code_server_port}")

    return loader, env_file, env_default_file, env_file_status, env_default_file_status


def env_snapshot_keys(loader: EnvFileLoader) -> list[str]:
    return ordered_unique([*KNOWN_SETTINGS, *sorted(loader.loaded_env_keys)])


def write_runtime_env_file(file_path: Path, loader: EnvFileLoader, generated_by: str) -> None:
    env = {
        key: os.environ[key]
        for key in env_snapshot_keys(loader)
        if key in os.environ
    }
    write_json_private(
        file_path,
        {
            "generated_by": generated_by,
            "generated_at": utc_timestamp(),
            "env": env,
        },
    )


def accepted_setting_rows(loader: EnvFileLoader) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    for key in env_snapshot_keys(loader):
        if key not in os.environ:
            continue
        value = os.environ[key]
        source = loader.setting_source.get(key, "loaded from external environment")
        rows.append((key, source, mask_setting_value(key, value)))
    return rows


def write_accepted_settings_log(
    log_file: Path,
    loader: EnvFileLoader,
    env_file: Path,
    env_default_file: Path,
    env_file_status: str,
    env_default_file_status: str,
    debug_env_file: Path,
) -> None:
    lines = [
        f"accepted settings generated_at={utc_timestamp()}",
        f"root={os.environ['APP_DIR']}",
        f"env_file={env_file}",
        f"env_file_status={env_file_status}",
        f"env_default_file={env_default_file}",
        f"env_default_file_status={env_default_file_status}",
        f"debug_env_file={debug_env_file}",
        "",
        f"{'KEY':<44} {'SOURCE':<24} VALUE",
        f"{'---':<44} {'------':<24} -----",
    ]

    for key, source, masked_value in accepted_setting_rows(loader):
        lines.append(f"{key:<44} {source:<24} {masked_value}")

    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")


def apply_product_port() -> None:
    product_port = os.environ.get("VITE_PORT") or os.environ.get("MOBIUS_PORT") or "45616"
    os.environ["VITE_PORT"] = product_port
    os.environ["MOBIUS_PORT"] = product_port
    if not os.environ.get("VITE_API_TARGET"):
        os.environ["VITE_API_TARGET"] = f"http://0.0.0.0:{product_port}"


def start_mobius(
    root: Path,
    start_script_name: str,
    other_versions: str | None = None,
    hard_reset: str | None = None,
    only_update_frontend: bool = False,
) -> None:
    start_script = root / "mobius" / start_script_name
    argv = [sys.executable, start_script]
    if other_versions:
        argv.extend(["--other-versions", other_versions])
    if hard_reset:
        argv.extend(["--hard-reset", hard_reset])
    if only_update_frontend:
        argv.append("--only-update-frontend")
    run(argv)


def code_server_is_healthy() -> bool:
    return tmux_session_exists("code-server") and port_is_listening(os.environ["CODE_SERVER_PORT"])


def start_code_server(*, force_restart: bool = True) -> None:
    print()
    print(f"=== [2/3] code-server {os.environ['CODE_SERVER_BIND']} ===")

    if not force_restart and code_server_is_healthy():
        print("   code-server 已正常运行，跳过重启")
        print("   如需强制重启，执行 start.py 时加 --force-vscode-server-restart")
        return

    if not force_restart:
        print("   code-server 未正常运行，准备启动")

    if kill_tmux_session("code-server"):
        print("   旧 code-server tmux 已 kill")

    kill_tcp_port_with_fuser(os.environ["CODE_SERVER_PORT"])

    command = tee_command(
        [
            os.environ["CS_BIN"],
            "--bind-addr",
            os.environ["CODE_SERVER_BIND"],
            "--auth",
            "none",
            "--disable-telemetry",
            "--disable-update-check",
            os.environ["CODE_SERVER_CWD"],
        ],
        "/tmp/code-server.log",
    )
    command = "unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN; " + command

    env = safe_tmux_environment(os.environ, exclude=VSCODE_IPC_ENV)
    argv = [
        "tmux",
        "new-session",
        "-d",
        "-s",
        "code-server",
        "-c",
        os.environ["CODE_SERVER_CWD"],
    ]
    add_tmux_environment(argv, env)
    argv.append(command)

    run(argv)
    time.sleep(2)


def print_health_check() -> None:
    print()
    print("=== [3/3] 端口健康检查 ===")
    time.sleep(3)

    ports = [os.environ["CODE_SERVER_PORT"], os.environ["MOBIUS_PORT"]]

    for port in ports:
        if port_is_listening(port):
            print(f"   ✓ :{port} listen")
        else:
            print(f"   ✗ :{port} 未启动")


def print_summary(root: Path) -> None:
    frontend_port = os.environ["MOBIUS_PORT"]

    print()
    print(f"accepted settings: {root / 'accepted_setting.log'}")
    print(f"前端:           http://0.0.0.0:{frontend_port}")
    print(f"后端 health:    http://0.0.0.0:{os.environ['MOBIUS_PORT']}/api/v2/health")
    print(f"mobius PM2:     cd {root / 'mobius'} && npx --no-install pm2 logs imac-mobius")
    print("code-server:    tmux attach -t code-server")
    print("claude code hub: tmux attach -t imac_claude_code_agent_hub  (用户首次发消息时按需起)")
    print(f"全停:           cd {root / 'mobius'} && npx --no-install pm2 stop imac-mobius; tmux kill-session -t code-server -t imac_claude_code_agent_hub")


def print_frontend_update_summary(root: Path) -> None:
    frontend_port = os.environ["MOBIUS_PORT"]

    print()
    print(f"accepted settings: {root / 'accepted_setting.log'}")
    print(f"前端静态文件:     {root / 'mobius' / 'public'}")
    print(f"访问地址:         http://0.0.0.0:{frontend_port}")
    if port_is_listening(frontend_port):
        print(f"后端状态:         :{frontend_port} listen，未重启")
    else:
        print(f"后端状态:         :{frontend_port} 未监听，本次未启动后端")


def attach_to_mobius() -> None:
    print()
    print("后端由 PM2 管理。可手动查看日志: cd mobius && npx --no-install pm2 logs imac-mobius")


def main(
    *,
    script_name: str = "start.py",
    description: str = (
        "Restart Mobius (compile + serve frontend), or compile/promote frontend only with "
        "--only-update-frontend."
    ),
    start_script_name: str = "start_product.py",
) -> int:
    args = parse_args(description)
    run_cwd = Path.cwd().resolve()

    try:
        loader, env_file, env_default_file, env_status, default_status = load_configuration(run_cwd, script_name)
        if args.other_versions and args.hard_reset:
            raise ConfigError("--other-versions 和 --hard-reset 不能同时使用")
        if args.only_update_frontend and (args.other_versions or args.hard_reset):
            raise ConfigError("--only-update-frontend 不能和 --other-versions / --hard-reset 同时使用")
        apply_product_port()

        root = Path(os.environ["APP_DIR"])
        debug_env_file = Path(os.environ["IMAC_DEBUG_ENV_FILE"])

        write_runtime_env_file(debug_env_file, loader, script_name)
        write_accepted_settings_log(
            root / "accepted_setting.log",
            loader,
            env_file,
            env_default_file,
            env_status,
            default_status,
            debug_env_file,
        )

        if args.only_update_frontend:
            print(f"=== [1/1] 更新 mobius 前端 (compile + replace :{os.environ['MOBIUS_PORT']}) ===")
        else:
            print(f"=== [1/3] 起 mobius (compile + serve :{os.environ['MOBIUS_PORT']}) ===")
        sys.stdout.flush()
        start_mobius(
            root,
            start_script_name,
            args.other_versions,
            args.hard_reset,
            args.only_update_frontend,
        )
        if args.only_update_frontend:
            print_frontend_update_summary(root)
            return 0

        start_code_server(force_restart=args.force_vscode_server_restart)
        print_health_check()
        print_summary(root)

        if not args.detach:
            attach_to_mobius()

        return 0

    except ConfigError as exc:
        print(f"{script_name}: {exc}", file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print(f"{script_name}: command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        return exc.returncode or 1


if __name__ == "__main__":
    raise SystemExit(main())
