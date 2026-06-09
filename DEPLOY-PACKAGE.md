# 生产部署包使用说明

适用于 Debian 12 / Ubuntu 22.04+ 的轻量部署。1C / 1G / 5G SSD 建议使用这个生产脚本，不要长期运行 Vite 开发服务。

## 上传并部署

把压缩包上传到服务器后执行：

```bash
tar -xzf ai-tavern-deploy-20260609.tar.gz
cd ai-tavern-deploy-20260609
bash scripts/install-production-debian12.sh
```

脚本运行后会提示填写公网访问地址。可以填：

- `203.0.113.10`
- `example.com`
- `https://example.com`

脚本会安装 Node.js 22、Nginx、后端依赖，创建 systemd 服务，并把前端静态文件放到 Nginx 下。

## 访问地址

- 用户前端：`http://your-domain-or-ip/`
- 管理后台：`http://your-domain-or-ip/admin/login`

首次部署时终端会输出管理员用户名和随机管理员密码，请保存好。

## 常用命令

```bash
systemctl status ai-tavern-backend --no-pager
journalctl -u ai-tavern-backend -n 100 --no-pager
systemctl restart ai-tavern-backend
systemctl restart nginx
```

## 数据和配置位置

- 后端目录：`/opt/ai-tavern/backend`
- 环境配置：`/opt/ai-tavern/backend/.env`
- SQLite 数据库：`/opt/ai-tavern/backend/data/app.sqlite`
- 前端静态文件：`/var/www/ai-tavern`

重复运行部署脚本会更新代码和前端文件，但会保留已有 `.env` 和数据库。
