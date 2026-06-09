#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

env_value() {
  local key="$1"
  local fallback="$2"
  if [ -f backend/.env ]; then
    local value
    value="$(grep -E "^${key}=" backend/.env | tail -n 1 | cut -d= -f2- || true)"
    if [ -n "$value" ]; then
      echo "$value"
      return
    fi
  fi
  echo "$fallback"
}

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

BACKEND_PORT="${BACKEND_PORT:-$(env_value PORT 2255)}"
USER_PORT="${USER_PORT:-5173}"
ADMIN_PORT="${ADMIN_PORT:-5174}"
API_BASE_URL="http://127.0.0.1:${BACKEND_PORT}"

stop_port "$BACKEND_PORT"
stop_port "$USER_PORT"
stop_port "$ADMIN_PORT"

npm run db:init

echo
echo "启动服务中..."
echo "后端 API：     ${API_BASE_URL}"
echo "用户前端：     http://127.0.0.1:${USER_PORT}"
echo "管理员前端：   http://127.0.0.1:${ADMIN_PORT}/admin/login"
echo
echo "按 Ctrl+C 停止全部服务。"

BACKEND_LOG="${TMPDIR:-/tmp}/ai-tavern-backend.log"
(cd backend && PORT="$BACKEND_PORT" HOST=127.0.0.1 node src/server.js) >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

for _ in $(seq 1 20); do
  if curl -fsS "${API_BASE_URL}/api/health" >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "后端启动失败，日志如下："
    sed -n '1,160p' "$BACKEND_LOG" || true
    exit 1
  fi

  sleep 0.5
done

if ! curl -fsS "${API_BASE_URL}/api/health" >/dev/null 2>&1; then
  echo "后端健康检查超时，请查看日志：$BACKEND_LOG"
  exit 1
fi

VITE_API_BASE_URL="$API_BASE_URL" VITE_PORT="$USER_PORT" npm run dev -w frontend-user &
USER_PID=$!

VITE_API_BASE_URL="$API_BASE_URL" VITE_PORT="$ADMIN_PORT" npm run dev -w frontend-admin &
ADMIN_PID=$!

wait
