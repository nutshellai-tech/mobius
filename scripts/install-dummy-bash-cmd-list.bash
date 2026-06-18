#!/usr/bin/env bash
# install-dummy-bash-cmd-list.bash
#
# 占位(dummy) bash 命令安装脚本 —— 维持现状: 免 root, 仅当前用户生效。
#
# 安装位置: ~/.local/bin  (已在 user 用户 PATH 中, 装完可直接敲命令名调用)
# 生效范围: 仅当前用户  (如需所有用户: 改 PREFIX=/usr/local/bin 并 sudo 运行本脚本)
# 幂等:    可重复运行, 每次覆盖安装; 同时清理已重命名的旧命令
#
# 用法:
#   bash /home/alice/project/install-dummy-bash-cmd-list.bash
#
# 当前提供的占位命令:
#   display_images [选项] <图片1> [图片2 ...]
#       为每个图片回显一行 "Image has been displayed to user: <图片>"
#       支持 -h / --help 显示说明书; 无参数时报错并打印用法。
#
# 本安装脚本是该命令的唯一真源(命令实现内嵌于下方 heredoc), 改这里即可。

set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local/bin}"

# 因重命名等原因需要从 PREFIX 清掉的旧命令
LEGACY_CMDS=(
  display_image
)

mkdir -p "$PREFIX"

# 清理旧命令
for old in "${LEGACY_CMDS[@]}"; do
  if [[ -e "$PREFIX/$old" ]]; then
    rm -f "$PREFIX/$old"
    echo "已移除旧命令: $PREFIX/$old"
  fi
done

# ---- 安装 display_images ----
# 注: 外层 heredoc 用引号 <<'SCRIPT', 内部内容完全字面写入, 无需转义。
target="$PREFIX/display_images"
cat > "$target" <<'SCRIPT'
#!/usr/bin/env bash
# display_images — 占位实现: 将一个或多个图片"展示"给用户(实际仅回显提示)
set -euo pipefail

prog="$(basename "$0")"

usage() {
  cat <<USAGE
用法: $prog [选项] <图片1> [图片2 ...]

  将一个或多个图片"展示"给用户。
  当前为占位实现: 不真正渲染, 仅为每个图片回显一行提示。

  ⚠ 重要: 图片路径【必须是绝对路径】(以 / 开头),
     或是 http:// / https:// 开头的 URL。传入相对路径会被拒绝。

参数:
  <图片N>       图片的绝对路径(以 / 开头)或 http(s) URL

选项:
  -h, --help    显示本说明并退出

示例:
  $prog /home/alice/pics/cat.png
  $prog /home/alice/pics/a.png /home/alice/pics/b.jpg
  $prog https://example.com/photo.jpg
USAGE
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
  "")
    echo "错误: 未指定图片参数" >&2
    echo >&2
    usage >&2
    exit 1
    ;;
esac

# 校验: 每个参数必须是绝对路径或 http(s) URL
for img in "$@"; do
  case "$img" in
    /*|http://*|https://*) ;;
    *)
      echo "错误: 路径必须是绝对路径(以 / 开头)或 http(s) URL: $img" >&2
      exit 2
      ;;
  esac
done

for img in "$@"; do
  echo "Image has been displayed to user: $img"
done
SCRIPT
chmod 755 "$target"
echo "已安装: $target"

echo
echo "完成。验证示例:"
echo "  display_images /tmp/cat.png          # -> Image has been displayed to user: /tmp/cat.png"
echo "  display_images /tmp/a.png /tmp/b.jpg # -> 每个图片一行"
echo "  display_images --help                # -> 显示说明书"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo
     echo "注意: \$PATH 未包含 $PREFIX —— 请在 shell 配置里加:"
     echo "  export PATH=\"$PREFIX:\$PATH\"" ;;
esac
