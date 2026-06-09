#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT="${BACKEND_PORT:-2255}"
USER_PORT="${USER_PORT:-5173}"
ADMIN_PORT="${ADMIN_PORT:-5174}"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "macOS 请先安装 Node.js："
  echo "  brew install node"
  exit 1
fi

major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$major" -lt 22 ]; then
  echo "当前 Node.js 版本为 $(node -v)。SQLite 存储需要 Node.js 22 或更高版本。"
  echo "macOS 建议执行：brew install node"
  exit 1
fi

install_dependencies() {
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
}

needs_security_reset() {
  [ ! -f backend/.env ] && return 0
  ! grep -Eq '^JWT_SECRET=.{32,}' backend/.env && return 0
  grep -Eq '^JWT_SECRET=(please-generate-a-random-secret-at-least-32-chars|dev-secret-change-me|replace-with-a-long-random-string)$' backend/.env && return 0
  grep -Eq '^ADMIN_PASSWORD=(please-change-this-admin-password|admin123)?$' backend/.env && return 0
  return 1
}

set_env() {
  local key="$1"
  local value="$2"
  local file="backend/.env"
  local tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" "$file"; then
    awk -v key="$key" -v value="$value" 'BEGIN { prefix = key "=" } index($0, prefix) == 1 { $0 = prefix value } { print }' "$file" > "$tmp"
    cat "$tmp" > "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
  rm -f "$tmp"
}

configure_local_env() {
  set_env PORT "$BACKEND_PORT"
  set_env HOST "127.0.0.1"
  set_env USER_FRONTEND_ORIGIN "http://localhost:${USER_PORT}"
  set_env ADMIN_FRONTEND_ORIGIN "http://localhost:${ADMIN_PORT}"
  set_env CORS_ORIGINS "http://localhost:${USER_PORT},http://127.0.0.1:${USER_PORT},http://localhost:${ADMIN_PORT},http://127.0.0.1:${ADMIN_PORT}"
  chmod 600 backend/.env 2>/dev/null || true
}

if ! install_dependencies; then
  echo
  echo "依赖安装失败。可清理依赖目录后重试："
  echo "  rm -rf node_modules"
  echo "  bash scripts/deploy-mac.sh"
  exit 1
fi

if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
fi

configure_local_env

if needs_security_reset; then
  npm run security:reset
  configure_local_env
fi

npm run db:init
npm run build

echo
echo "部署完成。启动项目："
echo "  bash scripts/start-mac.sh"
echo
echo "默认访问地址："
echo "  后端 API：   http://127.0.0.1:${BACKEND_PORT}"
echo "  用户前端：   http://127.0.0.1:${USER_PORT}"
echo "  管理后台：   http://127.0.0.1:${ADMIN_PORT}/admin/login"
