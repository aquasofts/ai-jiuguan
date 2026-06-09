# ai-tavern

这是一个前后端分离的 ai-tavern 项目，包含：

- `backend`：Node.js + Express 后端，提供用户、管理员、角色卡、API、账单、历史记录和 SSE 流式聊天接口。
- `frontend-user`：用户聊天前端，左侧会话/角色卡菜单，右侧 Markdown 聊天区，支持上传文件与 AI 对话。
- `frontend-admin`：管理员前端，包含首页统计、用户管理、角色卡管理、API 管理、提示词配置、费用管理。

## 快速启动

### macOS

安装 Node.js：

```bash
brew install node
```

部署指令：

```bash
bash scripts/deploy-mac.sh
```

启动指令：

```bash
bash scripts/start-mac.sh
```

或：

```bash
npm run start:mac
```

### Debian 12

安装 Node.js 22 或更高版本：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

部署指令：

```bash
bash scripts/deploy-debian12.sh
```

启动指令：

```bash
bash scripts/start-debian12.sh
```

或：

```bash
npm run start:debian12
```

默认地址：

- 后端 API：`http://localhost:2255`
- 用户前端：`http://localhost:5173`
- 管理员前端：`http://localhost:5174/admin/login`

如果浏览器打开成 `5175`、`5176`，或者页面出现 `Failed to fetch`，说明旧服务占用了端口。请先在运行脚本的终端按 `Ctrl+C` 停止，再重新执行一键脚本。新版一键脚本会自动清理 `2255/5173/5174/5175/5176` 端口，并且 Vite 不会再自动换端口。

管理员账号：

- 用户名：`admin`
- 密码：首次部署时脚本会自动生成并在终端输出。如果忘记密码，请重新执行 `npm run security:reset`。

## OpenAI 配置

在 `backend/.env` 中填写：

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5-mini
OPENAI_BASE_URL=https://api.openai.com/v1
MAX_CONCURRENT_AI_RESPONSES=5
CORS_ORIGINS=https://example.com
```

也可以在管理员前端的 API 管理里新增或编辑 API 配置。未配置 API Key 时，后端会返回本地占位回复，方便先验证整套流程。

`MAX_CONCURRENT_AI_RESPONSES` 控制全站同时生成 AI 回复的最大数量，默认 5。超过后新聊天请求会在服务端排队，用户前端仍保持“AI 正在回复...”状态，不显示排队提示。

如果前端和后端不是同一个源，或临时使用了非默认端口，请把允许访问后端的前端地址写入 `CORS_ORIGINS`，多个地址用英文逗号分隔。

系统提示词、角色卡拼接、历史记录压缩、附件内容是否发送给模型等行为，可以在管理员前端的“提示词配置”里调整。

## 数据位置与清理

后端 SQL 数据库会自动写入：

```bash
backend/data/app.sqlite
```

这是 SQLite 数据库文件，包含：

- 普通用户账号、邮箱、余额
- 用户审核状态
- 管理员账号
- 角色卡
- API Key 配置
- 聊天会话
- 聊天消息
- 费用记录

如果存在旧版 JSON 数据：

```bash
backend/data/database.json
```

部署或启动时会自动迁移到 SQLite。迁移完成后，实际使用的是 `backend/data/app.sqlite`。

后端环境配置在：

```bash
backend/.env
```

这个文件用于保存端口、默认管理员、OpenAI Key、默认模型等配置。清空业务数据时通常不要删除它。

浏览器登录状态保存在浏览器 LocalStorage 中：

- 用户前端：`http://127.0.0.1:5173`
- 管理员前端：`http://127.0.0.1:5174`

清空后端业务数据：

```bash
rm -f backend/data/app.sqlite backend/data/app.sqlite-shm backend/data/app.sqlite-wal
```

然后重新部署或启动项目，后端会自动创建表结构，并重新创建默认管理员和默认角色卡。

如果还想清除浏览器登录状态，请在浏览器对应页面打开开发者工具 Console，执行：

```js
localStorage.clear()
```

也可以在浏览器设置里清除 `127.0.0.1` 的站点数据。

## 注册审核

用户注册后不会立刻登录。注册请求会进入后台审核状态：

```text
pending -> active / rejected
```

管理员进入：

```text
http://127.0.0.1:5174/admin/users
```

在用户管理里点击“通过”或“拒绝”。只有状态为“已通过”的用户才能登录和发起聊天请求。

## 安全初始化

如果你准备填写或已经填写 OpenAI API Key，请先重置安全配置：

```bash
npm run security:reset
```

这会自动：

- 生成强 `JWT_SECRET`
- 重置管理员密码
- 更新 `backend/.env`
- 如果已有 `backend/data/app.sqlite`，同步更新数据库里的管理员密码哈希

脚本会在终端输出新的管理员密码，请保存好。

也可以自己指定管理员密码：

```bash
node scripts/security-reset.mjs "你的强密码至少12位"
```

公网部署前必须满足：

- `JWT_SECRET` 至少 32 位，不能使用默认值
- 管理员密码不能是 `admin123`
- 不要把 `backend/data/app.sqlite`、`backend/.env` 暴露到 Web 静态目录
- API 地址支持 OpenAI 官方地址，也支持第三方兼容接口地址。请只填写你信任的服务商地址，避免 API Key 泄露。

## 生产部署

Debian 12 / Ubuntu 22.04+ 生产环境推荐使用：

```bash
sudo bash scripts/install-production-debian12.sh https://example.com --yes
```

脚本默认使用：

- 后端目录：`/opt/ai-tavern/backend`
- 静态文件目录：`/var/www/ai-tavern`
- systemd 服务：`ai-tavern-backend`
- Nginx 站点：`ai-tavern`

如果从 Git 克隆部署，脚本会在服务器上自动执行 `npm ci` 和 `npm run build` 生成前端静态文件。
