#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

if ! npm install; then
  echo
  echo "依赖安装失败。若看到 ENOTEMPTY，可执行下面命令后重试："
  echo "  rm -rf node_modules package-lock.json"
  echo "  bash scripts/deploy-mac.sh"
  exit 1
fi

if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
fi

if ! grep -q '^JWT_SECRET=.\{32,\}' backend/.env || grep -q '^JWT_SECRET=please-generate-a-random-secret-at-least-32-chars' backend/.env || grep -q '^JWT_SECRET=dev-secret-change-me' backend/.env || grep -q '^ADMIN_PASSWORD=please-change-this-admin-password' backend/.env || grep -q '^ADMIN_PASSWORD=admin123' backend/.env; then
  npm run security:reset
fi

npm run db:init
npm run build

echo
echo "部署完成。启动项目："
echo "  bash scripts/start-mac.sh"
