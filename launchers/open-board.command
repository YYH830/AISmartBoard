#!/bin/bash
# ============================================================
# AI智能看板 —— macOS 启动入口
#
# 使用方法（任选一种）：
#   1. 在「终端」里执行：  bash launchers/open-board.command
#   2. 想双击运行的话，先在本目录的终端里执行一次：
#        chmod +x "launchers/open-board.command"
#      （OneDrive 不同步 macOS 的执行权限，换电脑可能要再执行一次）
#
# 文件结构：
#     launchers/open-board.command   ← 本文件
#     app/server.js                  ← 服务程序
#     data/*.md                      ← 你的台账数据
#
# 说明：服务在后台运行，关掉终端窗口不影响使用；
#       停止服务：点界面右上角「服务运行中」徽标 →「停止服务」，
#       或执行  pkill -f server.js
# ============================================================

# 上移到项目根目录（本文件在 launchers/ 里）
cd "$(dirname "$0")/.." || exit 1

PORT_FILE="app/.server-port"
SERVER_JS="app/server.js"

# ---------- 1. 检查 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  未检测到 Node.js，无法启动本地服务。"
  echo ""
  echo "  安装方式（任选其一）："
  echo "    1) 打开 https://nodejs.org 下载 LTS 版本安装；"
  echo "    2) 已安装 Homebrew 的话，执行： brew install node"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭窗口…"
  echo ""
  exit 1
fi

# ---------- 2. 检查程序文件 ----------
if [ ! -f "$SERVER_JS" ]; then
  echo ""
  echo "  找不到程序文件：$SERVER_JS"
  echo "  请确认 app 文件夹与本脚本保持原有目录结构（launchers/ 与 app/ 同级）。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭窗口…"
  echo ""
  exit 1
fi

# ---------- 3. 已在运行就直接打开界面 ----------
# 用免鉴权的 /api/ping 探测：/api/data 在启用登录后会返回 401，会导致误判
if [ -f "$PORT_FILE" ]; then
  RUNNING_PORT=$(cat "$PORT_FILE" 2>/dev/null)
  if [ -n "$RUNNING_PORT" ] && curl -s -m 1 "http://127.0.0.1:$RUNNING_PORT/api/ping" >/dev/null 2>&1; then
    echo "  任务看板已在运行，正在打开界面…"
    open "http://localhost:$RUNNING_PORT/"
    exit 0
  fi
fi

# ---------- 4. 后台启动服务（--app 让服务自己以应用模式窗口打开界面） ----------
# --host=127.0.0.1 强制只监听本机：即使 .env 里配了 0.0.0.0（服务器用），
# 本机双击也绝不会暴露到局域网。
rm -f "$PORT_FILE"
nohup node "$SERVER_JS" --app --host=127.0.0.1 >/dev/null 2>&1 &

# 等待服务就绪（最多约 6 秒）
PORT=""
for _ in $(seq 1 30); do
  if [ -f "$PORT_FILE" ]; then
    PORT=$(cat "$PORT_FILE" 2>/dev/null)
    [ -n "$PORT" ] && break
  fi
  sleep 0.2
done

if [ -z "$PORT" ]; then
  echo ""
  echo "  服务启动失败。请确认 Node.js 可用（终端执行 node -v 查看）。"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭窗口…"
  echo ""
  exit 1
fi

# ---------- 5. 提示信息 ----------
echo ""
echo "  AI智能看板已启动：http://localhost:$PORT/"
echo "  台账数据存放于：data/ 文件夹"
echo "  启动时会要求登录，账号密码见项目根目录的 .env 文件"
echo "  服务在后台运行，关闭本窗口不影响使用。"
echo "  停止服务：点界面右上角的电源图标，或执行  pkill -f server.js"
echo ""

sleep 1
exit 0
