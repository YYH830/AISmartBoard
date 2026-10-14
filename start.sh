#!/usr/bin/env bash
# ============================================================================
#  AI智能看板 —— Linux 服务器启动脚本
#
#  用法：
#     bash start.sh start     启动（后台运行）
#     bash start.sh stop      停止
#     bash start.sh restart   重启
#     bash start.sh status    查看状态
#     bash start.sh logs      实时查看日志
#     bash start.sh pass      查看/重设访问账号密码
#
#  配置：同目录下的 .env 文件（首次运行会自动生成一份模板）
# ============================================================================

set -u

# 切到脚本所在目录，保证相对路径都对
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

APP="$DIR/app/server.js"
ENV_FILE="$DIR/.env"
PID_FILE="$DIR/server.pid"
LOG_FILE="$DIR/server.log"

# ---------------------------------------------------------------- 输出小工具
c_info()  { printf '\033[36m%s\033[0m\n' "$1"; }
c_ok()    { printf '\033[32m%s\033[0m\n' "$1"; }
c_warn()  { printf '\033[33m%s\033[0m\n' "$1"; }
c_err()   { printf '\033[31m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- 环境准备
ensure_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'EOF'
# AI智能看板 —— 部署配置
# 改完这个文件后执行：  bash start.sh restart

# 监听地址。0.0.0.0 表示允许外部访问（服务器部署必须是这个）
WTK_HOST=0.0.0.0

# 监听端口。记得在服务器防火墙 / 云安全组里放行这个端口
WTK_PORT=8765

# 登录账号
WTK_USER=admin

# 登录密码
#
#   ⚠ 注意：12345 只是个能立刻用起来的初始密码，太简单了，
#     公网上很容易被猜到。想长期开放访问，请务必改成 12 位以上的
#     复杂密码，例如： WTK_PASS=Xk7#mQ2pL9vN
#
WTK_PASS=12345
EOF
    chmod 600 "$ENV_FILE" 2>/dev/null
    c_info "已生成配置文件 .env（登录账号 admin / 密码 12345）"
    c_warn "提示：这个初始密码过于简单，开放到公网前请记得修改 WTK_PASS。"
  fi
}

# 载入 .env（忽略注释与空行）
# 逐行解析，不用 source —— 密码里带空格或 $ 之类的字符时 source 会把值当命令执行
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '' | \#*) continue ;;                 # 跳过空行与注释
    esac
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    # 只接受合法的变量名，避免后面间接取值时报错
    case "$key" in
      '' | *[!A-Za-z0-9_]*) continue ;;
    esac
    # 去掉值两端的空白
    val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # 去掉包裹的引号
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    # 已经存在的环境变量优先，与程序内部的取值规则保持一致
    if [ -z "${!key:-}" ]; then
      export "$key=$val"
    fi
  done < "$ENV_FILE"
}

# ---------------------------------------------------------------- 状态判断
is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  # kill -0 只检查进程是否存在，不发信号
  kill -0 "$pid" 2>/dev/null || return 1
  return 0
}

current_pid() { cat "$PID_FILE" 2>/dev/null; }

# 实际监听端口（端口被占用时服务会自动顺延，这里以配置值为准）
actual_port() {
  if [ -n "${WTK_PORT:-}" ]; then echo "$WTK_PORT"; return; fi
  echo 8765
}

# ---------------------------------------------------------------- 各子命令
do_start() {
  if ! command -v node >/dev/null 2>&1; then
    c_err "未检测到 Node.js，请先安装："
    echo "    Debian / Ubuntu :  apt install -y nodejs"
    echo "    或使用官方源   :  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
    exit 1
  fi

  if [ ! -f "$APP" ]; then
    c_err "找不到程序文件：$APP"
    echo "    请确认「app」文件夹与本脚本在同一目录下。"
    exit 1
  fi

  if is_running; then
    c_warn "服务已经在运行（PID $(current_pid)），无需重复启动。"
    do_status
    return 0
  fi

  ensure_env_file
  load_env

  c_info "正在启动AI智能看板…"
  # --no-open 表示不要尝试打开浏览器（服务器上没有桌面环境）
  nohup node "$APP" --no-open >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  # 等待服务就绪（最多 10 秒）
  local port ready=0 waited=0
  port="$(actual_port)"
  while [ "$waited" -lt 50 ]; do
    if ! is_running; then
      c_err "启动失败，日志末尾："
      tail -n 20 "$LOG_FILE"
      rm -f "$PID_FILE"
      exit 1
    fi
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS -m 1 "http://127.0.0.1:$port/api/ping" >/dev/null 2>&1; then
        ready=1
        break
      fi
    else
      # 没有 curl 就没法探测，只能等一会儿
      sleep 1
      ready=1
      break
    fi
    sleep 0.2
    waited=$((waited + 1))
  done

  if [ "$ready" -ne 1 ]; then
    c_warn "进程已经起来了，但 $port 端口暂时没响应，可能还在初始化，稍等几秒再试。"
  fi

  echo
  do_status
  echo
  c_ok "启动完成。"
  echo "    · 对外访问：http://<服务器IP>:$port/"
  echo "    · 访问密码：见 $ENV_FILE 里的 WTK_PASS（或下方日志）"
  echo "    · 若打不开，检查服务器防火墙和云服务商安全组是否放行了 $port 端口"
}

do_stop() {
  if ! is_running; then
    c_warn "服务当前没有在运行。"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(current_pid)"
  c_info "正在停止服务（PID $pid）…"
  kill "$pid" 2>/dev/null
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 40 ]; do
    sleep 0.25
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    c_warn "进程没有正常退出，强制结束。"
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  c_ok "已停止。"
}

do_restart() {
  do_stop
  sleep 1
  do_start
}

do_status() {
  local port
  port="$(actual_port)"
  if is_running; then
    c_ok "服务运行中（PID $(current_pid)）"
    echo "    · 监听端口：$port"
    echo "    · 台账目录：$DIR/data"
    if command -v curl >/dev/null 2>&1; then
      local info
      info="$(curl -fsS -m 2 "http://127.0.0.1:$port/api/ping" 2>/dev/null)"
      [ -n "$info" ] && echo "    · 服务响应：$info"
    fi
    echo "    · 日志文件：$LOG_FILE"
  else
    c_warn "服务未运行。"
  fi
}

do_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    c_warn "还没有日志文件，服务可能从未启动过。"
    return 0
  fi
  echo "按 Ctrl+C 退出日志查看。"
  tail -n 100 -f "$LOG_FILE"
}

do_pass() {
  ensure_env_file
  load_env
  echo
  c_info "登录账号：${WTK_USER:-admin}"
  c_info "登录密码：${WTK_PASS:-（未设置，服务会自动生成）}"
  if [ -n "${WTK_PASS:-}" ] && [ "${#WTK_PASS}" -lt 8 ]; then
    echo
    c_warn "⚠ 当前密码少于 8 位，比较容易被猜出来。"
  fi
  echo
  echo "  想换成自己的账号密码："
  echo "    1) 编辑 $ENV_FILE ，修改 WTK_USER（账号）和 WTK_PASS（密码）"
  echo "    2) 执行  bash start.sh restart"
  echo
}

# ---------------------------------------------------------------- 入口
# 先载入已有配置，好让 status / stop 等命令也能拿到端口设置
load_env

case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs ;;
  pass)    do_pass ;;
  *)
    echo "AI智能看板 —— 服务管理"
    echo
    echo "  bash start.sh start     启动（后台运行）"
    echo "  bash start.sh stop      停止"
    echo "  bash start.sh restart   重启"
    echo "  bash start.sh status    查看状态"
    echo "  bash start.sh logs      实时查看日志"
    echo "  bash start.sh pass      查看访问账号密码"
    ;;
esac
