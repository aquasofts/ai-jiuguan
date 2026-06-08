#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1"
    echo "请先运行部署脚本：bash scripts/deploy-debian12.sh"
    exit 1
  fi
}

stop_port() {
  local port="$1"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$port"/tcp 2>/dev/null || true)"
  fi

  if [ -n "$pids" ]; then
    echo "端口 $port 已被占用，正在停止旧进程：$pids"
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

cleanup() {
  if [ -n "${BACKEND_PID:-}" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [ -n "${USER_PID:-}" ]; then kill "$USER_PID" 2>/dev/null || true; fi
  if [ -n "${ADMIN_PID:-}" ]; then kill "$ADMIN_PID" 2>/dev/null || true; fi
}

trap cleanup EXIT INT TERM

need_command node
need_command npm
need_command curl

if [ ! -f backend/.env ] || [ ! -d node_modules ]; then
  echo "未完成部署初始化，请先运行：bash scripts/deploy-debian12.sh"
  exit 1
fi

stop_port 2255
stop_port 5173
stop_port 5174
stop_port 5175
stop_port 5176

npm run db:init

echo
echo "启动服务中..."
echo "后端 API：     http://127.0.0.1:2255"
echo "用户前端：     http://127.0.0.1:5173"
echo "管理员前端：   http://127.0.0.1:5174/admin/login"
echo
echo "按 Ctrl+C 停止全部服务。"

BACKEND_LOG="${TMPDIR:-/tmp}/ai-tavern-backend.log"
npm run dev:backend >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:2255/api/health >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "后端启动失败，日志如下："
    sed -n '1,160p' "$BACKEND_LOG" || true
    exit 1
  fi

  sleep 0.5
done

if ! curl -fsS http://127.0.0.1:2255/api/health >/dev/null 2>&1; then
  echo "后端健康检查超时，请查看日志：$BACKEND_LOG"
  exit 1
fi

npm run dev:user &
USER_PID=$!

npm run dev:admin &
ADMIN_PID=$!

wait
