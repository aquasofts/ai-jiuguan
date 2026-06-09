#!/usr/bin/env bash
set -euo pipefail

ASSUME_YES="false"
PUBLIC_ORIGIN_ARG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)
      ASSUME_YES="true"
      shift
      ;;
    -h|--help)
      echo "用法：sudo bash scripts/install-production-debian12.sh [公网访问地址] [--yes]"
      echo "示例：sudo bash scripts/install-production-debian12.sh https://example.com --yes"
      exit 0
      ;;
    *)
      if [ -n "$PUBLIC_ORIGIN_ARG" ]; then
        echo "未知参数：$1"
        exit 1
      fi
      PUBLIC_ORIGIN_ARG="$1"
      shift
      ;;
  esac
done

DEFAULT_PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost}"
APP_DIR="${APP_DIR:-/opt/ai-tavern}"
WEB_DIR="${WEB_DIR:-/var/www/ai-tavern}"
SERVICE_NAME="${SERVICE_NAME:-ai-tavern-backend}"
APP_USER="${APP_USER:-ai-tavern}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-ai-tavern}"
BACKEND_PORT="${BACKEND_PORT:-2255}"

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

if [ -n "$PUBLIC_ORIGIN_ARG" ]; then
  PUBLIC_ORIGIN="$(normalize_origin "$PUBLIC_ORIGIN_ARG")"
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

PUBLIC_SCHEME="${PUBLIC_ORIGIN%%://*}"
PUBLIC_HOSTPORT="${PUBLIC_ORIGIN#*://}"
PUBLIC_HOSTPORT="${PUBLIC_HOSTPORT%%/*}"
PUBLIC_HOST="${PUBLIC_HOSTPORT%%:*}"
if [ -z "$PUBLIC_HOST" ]; then
  PUBLIC_HOST="_"
fi

echo "将使用公网访问地址：$PUBLIC_ORIGIN"
if [ "$ASSUME_YES" != "true" ]; then
  read -r -p "确认继续部署？[Y/n]: " confirm_deploy
  case "$confirm_deploy" in
    n|N|no|NO|No)
      echo "已取消部署。"
      exit 0
      ;;
  esac
fi

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
need_file frontend-user/package.json
need_file frontend-user/index.html
need_file frontend-admin/package.json
need_file frontend-admin/index.html
need_file scripts/security-reset.mjs

echo "安装系统依赖..."
apt-get update
apt-get install -y ca-certificates curl nginx openssl

node_major="0"
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
fi

if [ "$node_major" -lt 22 ]; then
  echo "安装 Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if [ ! -f "$ROOT_DIR/frontend-user/dist/index.html" ] || [ ! -f "$ROOT_DIR/frontend-admin/dist/index.html" ]; then
  echo "未找到前端构建产物，正在安装依赖并构建..."
  cd "$ROOT_DIR"
  npm ci
  npm run build
else
  echo "已找到前端构建产物，跳过前端构建。"
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
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

set_env PORT "$BACKEND_PORT"
set_env HOST "127.0.0.1"
set_env USER_FRONTEND_ORIGIN "$PUBLIC_ORIGIN"
set_env ADMIN_FRONTEND_ORIGIN "$PUBLIC_ORIGIN"
set_env CORS_ORIGINS "$PUBLIC_ORIGIN"
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

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 700 "$APP_DIR/backend/data"
chmod 600 "$APP_DIR/backend/.env"
chown -R www-data:www-data "$WEB_DIR"

echo "写入 systemd 服务..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ai-tavern backend
After=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
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
SSL_LISTEN=""
SSL_CONFIG=""
if [ "$PUBLIC_SCHEME" = "https" ]; then
  SSL_DIR="/etc/ssl/${NGINX_SITE_NAME}"
  SSL_CERT="${SSL_DIR}/origin.crt"
  SSL_KEY="${SSL_DIR}/origin.key"
  install -d -m 755 "$SSL_DIR"
  if [ ! -f "$SSL_CERT" ] || [ ! -f "$SSL_KEY" ]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout "$SSL_KEY" \
      -out "$SSL_CERT" \
      -subj "/CN=${PUBLIC_HOST}" \
      -addext "subjectAltName=DNS:${PUBLIC_HOST}"
  fi
  chmod 600 "$SSL_KEY"
  SSL_LISTEN="    listen 443 ssl;"
  SSL_CONFIG="
    ssl_certificate ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
"
fi

cat > "/etc/nginx/sites-available/${NGINX_SITE_NAME}" <<EOF
server {
    listen 80;
${SSL_LISTEN}
    server_name ${PUBLIC_HOST};
${SSL_CONFIG}

    client_max_body_size 8m;
    root ${WEB_DIR}/user;

    location /api/ {
        add_header Cache-Control "no-store" always;
        proxy_pass http://127.0.0.1:${BACKEND_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
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
        add_header Cache-Control "no-store" always;
        alias ${WEB_DIR}/admin/;
        try_files \$uri \$uri/ /admin/index.html;
    }

    location = /admin/index.html {
        add_header Cache-Control "no-store" always;
        alias ${WEB_DIR}/admin/index.html;
    }

    location /admin/assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        alias ${WEB_DIR}/admin/assets/;
        try_files \$uri =404;
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }

    location / {
        add_header Cache-Control "no-store" always;
        try_files \$uri \$uri/ /index.html;
    }

    location = /index.html {
        add_header Cache-Control "no-store" always;
        try_files /index.html =404;
    }
}
EOF

ln -sf "/etc/nginx/sites-available/${NGINX_SITE_NAME}" "/etc/nginx/sites-enabled/${NGINX_SITE_NAME}"
rm -f /etc/nginx/sites-enabled/default
nginx -t

echo "启动服务..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl restart nginx

if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  if ! curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null 2>&1; then
    echo "后端健康检查失败，请查看日志：journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    exit 1
  fi
fi

echo
echo "部署完成。"
echo "用户前端：${PUBLIC_ORIGIN}/"
echo "管理后台：${PUBLIC_ORIGIN}/admin/login"
echo
echo "查看后端状态：systemctl status ${SERVICE_NAME} --no-pager"
echo "查看后端日志：journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
