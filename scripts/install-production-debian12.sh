#!/usr/bin/env bash
set -euo pipefail

DEFAULT_PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost}"
APP_DIR="${APP_DIR:-/opt/ai-tavern}"
WEB_DIR="${WEB_DIR:-/var/www/ai-tavern}"
SERVICE_NAME="${SERVICE_NAME:-ai-tavern-backend}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 运行：sudo bash scripts/install-production-debian12.sh"
  exit 1
fi

normalize_origin() {
  local raw="${1:-}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%/}"
  if [ -z "$raw" ]; then
    raw="$DEFAULT_PUBLIC_ORIGIN"
  fi
  if [[ "$raw" != http://* && "$raw" != https://* ]]; then
    raw="http://${raw}"
  fi
  echo "$raw"
}

if [ -n "${1:-}" ]; then
  PUBLIC_ORIGIN="$(normalize_origin "$1")"
else
  echo "请填写网站公网访问地址。"
  echo "示例：203.0.113.10、example.com、https://example.com"
  read -r -p "公网访问地址 [${DEFAULT_PUBLIC_ORIGIN}]: " input_public_origin
  PUBLIC_ORIGIN="$(normalize_origin "${input_public_origin:-$DEFAULT_PUBLIC_ORIGIN}")"
fi

case "$PUBLIC_ORIGIN" in
  http://*|https://*) ;;
  *)
    echo "公网访问地址格式不正确：$PUBLIC_ORIGIN"
    exit 1
    ;;
esac

echo "将使用公网访问地址：$PUBLIC_ORIGIN"
read -r -p "确认继续部署？[Y/n]: " confirm_deploy
case "$confirm_deploy" in
  n|N|no|NO|No)
    echo "已取消部署。"
    exit 0
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

need_file() {
  if [ ! -e "$ROOT_DIR/$1" ]; then
    echo "部署包缺少文件：$1"
    exit 1
  fi
}

need_file package.json
need_file package-lock.json
need_file backend/src/server.js
need_file backend/.env.example
need_file frontend-user/dist/index.html
need_file frontend-admin/dist/index.html
need_file scripts/security-reset.mjs

echo "安装系统依赖..."
apt-get update
apt-get install -y ca-certificates curl nginx

node_major="0"
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
fi

if [ "$node_major" -lt 22 ]; then
  echo "安装 Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! id ai-tavern >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin ai-tavern
fi

echo "复制应用文件..."
install -d "$APP_DIR/backend" "$APP_DIR/scripts" "$APP_DIR/backend/data"
cp -a "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$APP_DIR/"
cp -a "$ROOT_DIR/scripts/security-reset.mjs" "$APP_DIR/scripts/"
rm -rf "$APP_DIR/backend/src"
cp -a "$ROOT_DIR/backend/src" "$APP_DIR/backend/"
cp -a "$ROOT_DIR/backend/package.json" "$ROOT_DIR/backend/.env.example" "$APP_DIR/backend/"

if [ ! -f "$APP_DIR/backend/.env" ]; then
  cp "$APP_DIR/backend/.env.example" "$APP_DIR/backend/.env"
fi

set_env() {
  local key="$1"
  local value="$2"
  local file="$APP_DIR/backend/.env"
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

set_env PORT "2255"
set_env HOST "127.0.0.1"
set_env USER_FRONTEND_ORIGIN "$PUBLIC_ORIGIN"
set_env ADMIN_FRONTEND_ORIGIN "$PUBLIC_ORIGIN"
set_env ALLOW_INSECURE_DEFAULTS "false"

echo "安装后端生产依赖..."
cd "$APP_DIR"
npm ci --omit=dev --workspace backend --include-workspace-root=false
npm cache clean --force >/dev/null 2>&1 || true

if ! grep -Eq '^JWT_SECRET=.{32,}' "$APP_DIR/backend/.env" \
  || grep -Eq '^JWT_SECRET=(please-generate-a-random-secret-at-least-32-chars|dev-secret-change-me|replace-with-a-long-random-string)$' "$APP_DIR/backend/.env" \
  || grep -Eq '^ADMIN_PASSWORD=(please-change-this-admin-password|admin123)?$' "$APP_DIR/backend/.env"; then
  echo "生成安全配置和管理员密码..."
  npm run security:reset
else
  echo "保留已有安全配置。"
fi

echo "初始化数据库..."
npm run db:init -w backend

echo "复制前端静态文件..."
rm -rf "$WEB_DIR/user" "$WEB_DIR/admin"
install -d "$WEB_DIR/user" "$WEB_DIR/admin"
cp -a "$ROOT_DIR/frontend-user/dist/." "$WEB_DIR/user/"
cp -a "$ROOT_DIR/frontend-admin/dist/." "$WEB_DIR/admin/"

chown -R ai-tavern:ai-tavern "$APP_DIR"
chmod 700 "$APP_DIR/backend/data"
chmod 600 "$APP_DIR/backend/.env"
chown -R www-data:www-data "$WEB_DIR"

echo "写入 systemd 服务..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=AI Tavern backend
After=network.target

[Service]
Type=simple
User=ai-tavern
Group=ai-tavern
WorkingDirectory=${APP_DIR}/backend
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=${APP_DIR}/backend/data ${APP_DIR}/backend/.env

[Install]
WantedBy=multi-user.target
EOF

echo "写入 Nginx 配置..."
cat > /etc/nginx/sites-available/ai-tavern <<EOF
server {
    listen 80;
    server_name _;

    client_max_body_size 8m;
    root ${WEB_DIR}/user;

    location /api/ {
        proxy_pass http://127.0.0.1:2255/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location = /admin {
        return 301 /admin/login;
    }

    location /admin/ {
        alias ${WEB_DIR}/admin/;
        try_files \$uri \$uri/ /admin/index.html;
    }

    location /assets/ {
        try_files \$uri =404;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

ln -sf /etc/nginx/sites-available/ai-tavern /etc/nginx/sites-enabled/ai-tavern
rm -f /etc/nginx/sites-enabled/default
nginx -t

echo "启动服务..."
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart nginx

echo
echo "部署完成。"
echo "用户前端：${PUBLIC_ORIGIN}/"
echo "管理后台：${PUBLIC_ORIGIN}/admin/login"
echo
echo "查看后端状态：systemctl status ${SERVICE_NAME} --no-pager"
echo "查看后端日志：journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
