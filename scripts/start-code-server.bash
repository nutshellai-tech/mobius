#!/usr/bin/env bash
# start-code-server.bash — 启动 code-server (VSCode Web).
# 端口 45617, 仅本机访问, 无密码 (config 在 ~/.config/code-server/config.yaml).
# 独立 tmux session, 与 start.py 互不影响.
#
# 用法:
#   bash start-code-server.bash            # 启动 (若已在跑则不重启)
#   bash start-code-server.bash --restart  # 强制重启
#   bash start-code-server.bash --stop     # 停止
#
# 如果 code-server 未装: proxychains bash -c "curl -fsSL https://code-server.dev/install.sh | sh"

set -uo pipefail

SESSION=code-server
BIN=/usr/bin/code-server
PORT=45617
HOST=127.0.0.1
WORKDIR=${CODE_SERVER_CWD:-${HOME:-$(pwd)}}

ACTION=${1:-start}

if [[ ! -x "$BIN" ]]; then
  echo "✗ 未找到 $BIN; 装: proxychains bash -c \"curl -fsSL https://code-server.dev/install.sh | sh\""
  exit 1
fi

case "$ACTION" in
  --stop|stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "停止 $SESSION" || echo "未在跑"
    fuser -k "${PORT}/tcp" 2>/dev/null
    exit 0
    ;;
  --restart|restart)
    tmux kill-session -t "$SESSION" 2>/dev/null
    fuser -k "${PORT}/tcp" 2>/dev/null
    sleep 1
    ;;
esac

if tmux has-session -t "$SESSION" 2>/dev/null && ss -tln 2>/dev/null | grep -qE "127.0.0.1:$PORT\b"; then
  echo "✓ code-server 已在跑 (tmux session: $SESSION, http://$HOST:$PORT)"
  exit 0
fi

# 端口被占就先释放
if ss -tln 2>/dev/null | grep -qE "127.0.0.1:$PORT\b"; then
  fuser -k "${PORT}/tcp" 2>/dev/null
  sleep 1
fi

tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -c "$WORKDIR"
# VSCODE_IPC_HOOK_CLI 是 VS Code 集成终端继承下来的, code-server 看到会 ECONNREFUSED.
tmux send-keys -t "$SESSION" \
  "unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN; exec '$BIN' --bind-addr ${HOST}:${PORT} --auth none --disable-telemetry --disable-update-check '$WORKDIR'" C-m

sleep 5
if ss -tln 2>/dev/null | grep -qE "127.0.0.1:$PORT\b"; then
  echo "✓ code-server up: http://$HOST:$PORT"
  echo "  tmux session: $SESSION (attach: tmux attach -t $SESSION)"
else
  echo "✗ 启动失败; tmux capture-pane -p -t $SESSION 看错误"
fi
