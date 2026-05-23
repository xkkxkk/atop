# ATOP 部署文档

本文档面向首次部署、后续升级和基础运维。推荐使用 Docker Compose 部署 MySQL、后端和前端。

## 1. 部署架构

```text
浏览器 / Jenkins
        |
        v
前端 Nginx 容器 :8888
        |
        | /api、/ws 反向代理
        v
Go 后端容器 :8080
        |
        v
MySQL 8 容器 :3306
```

默认 Compose 会暴露：

| 端口 | 服务 | 默认用途 |
| --- | --- | --- |
| `8888` | 前端 Nginx | 用户访问入口，内置 `/api` 反向代理 |
| `8080` | 后端 API | Jenkins 回调或调试，可按安全策略改成内网访问 |
| `3306` | MySQL | 默认只绑定 `127.0.0.1` |

## 2. 服务器要求

- Linux 服务器，建议 Ubuntu 22.04/24.04 或同类发行版。
- Docker 24+ 与 Docker Compose v2。
- 建议配置：2 核 CPU、4 GB 内存、20 GB 可用磁盘起步。
- 服务器能访问镜像源、npm registry、Go module proxy。

安装 Docker：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
newgrp docker
docker --version
docker compose version
```

## 3. 获取代码

```bash
git clone git@github.com:xkkxkk/atop.git
cd atop
```

如果服务器未配置 GitHub SSH Key，也可以使用 HTTPS 克隆：

```bash
git clone https://github.com/xkkxkk/atop.git
cd atop
```

## 4. 配置环境变量

```bash
cd backend/deploy
cp .env.example .env
vi .env
```

必须修改的配置：

| 变量 | 说明 | 建议 |
| --- | --- | --- |
| `MYSQL_ROOT_PASSWORD` | MySQL root 密码 | 使用高强度随机密码 |
| `DB_PASSWORD` | ATOP 应用数据库密码 | 与 root 密码不同 |
| `JWT_SECRET` | JWT 签名密钥 | 至少 32 字节随机值 |
| `AES_KEY` | Jenkins Token 加密种子 | 至少 32 字节随机值 |
| `WEBHOOK_HMAC_SECRET` | Jenkins 回调签名密钥 | 至少 32 字节随机值 |
| `ADMIN_EMAIL` | 初始超级管理员邮箱 | 用真实管理员邮箱 |
| `ADMIN_PASSWORD` | 初始超级管理员密码 | 首次登录后立即修改 |
| `EXTERNAL_URL` | 平台对外访问地址 | 如 `https://atop.example.com` 或 `http://服务器IP:8888` |
| `WEBHOOK_BASE_URL` | Jenkins 可访问的回调地址前缀 | 通常与 `EXTERNAL_URL` 一致；也可用后端直连地址 |
| `CORS_ALLOW_ORIGINS` | 允许跨域的前端来源 | 同域部署可留空；分离部署填前端域名 |

生成随机密钥：

```bash
openssl rand -hex 32
```

生产建议：

- 使用 HTTPS 时，`EXTERNAL_URL` 填 HTTPS 地址。
- `COOKIE_SECURE=auto` 会根据 HTTPS 自动设置安全 Cookie；跨站部署时参考 `backend/deploy/AUTH_COOKIE_DEPLOY.md`。
- 如果 Jenkins 只能访问内网后端，可将 `WEBHOOK_BASE_URL` 设置为后端内网地址，例如 `http://10.0.0.10:8080`。

## 5. 首次启动

在 `backend/deploy` 目录执行：

```bash
docker compose up -d --build
```

Compose 会构建：

- `atop-backend`：从 `backend/Dockerfile` 构建 Go 后端。
- `atop-frontend`：从 `frontend/Dockerfile` 构建 React 前端并打包进 Nginx。
- `atop-mysql`：启动 MySQL 8 并执行 `backend/scripts/init.sql`。

查看状态：

```bash
docker compose ps
docker compose logs -f
```

期望三个服务均为 `Up`，并通过健康检查。

## 6. 验证部署

```bash
curl http://localhost:8080/health
curl http://localhost:8888/nginx-health
```

浏览器访问：

```text
http://服务器IP:8888
```

登录账号：

- 邮箱：`backend/deploy/.env` 中的 `ADMIN_EMAIL`
- 密码：`backend/deploy/.env` 中的 `ADMIN_PASSWORD`

首次登录后系统会要求修改密码。

## 7. 域名和反向代理

如果使用外层 Nginx 或云负载均衡，建议只暴露标准 HTTP/HTTPS 端口，然后转发到前端容器端口 `8888`。

示例：

```nginx
server {
    listen 80;
    server_name atop.example.com;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

使用域名后同步修改 `backend/deploy/.env`：

```env
EXTERNAL_URL=https://atop.example.com
WEBHOOK_BASE_URL=https://atop.example.com
CORS_ALLOW_ORIGINS=https://atop.example.com
```

## 8. 升级发布

```bash
cd atop
git pull
cd backend/deploy
docker compose up -d --build
docker compose ps
```

如只更新前端：

```bash
docker compose up -d --build atop-frontend
```

如只更新后端：

```bash
docker compose up -d --build atop-backend
```

后端启动时会执行 GORM 自动迁移和默认数据补齐。升级前仍建议先备份数据库。

## 9. 备份与恢复

创建备份目录：

```bash
mkdir -p /opt/atop-backup
```

备份数据库：

```bash
docker exec atop-mysql mysqldump -u atop -p"$DB_PASSWORD" atop \
  > /opt/atop-backup/atop-$(date +%Y%m%d-%H%M%S).sql
```

如果当前 shell 没有 `DB_PASSWORD`，可从 `backend/deploy/.env` 中读取后再执行。

恢复数据库：

```bash
docker exec -i atop-mysql mysql -u atop -p"$DB_PASSWORD" atop \
  < /opt/atop-backup/atop-YYYYMMDD-HHMMSS.sql
```

## 10. 日志与运维命令

```bash
# 查看全部日志
docker compose logs --tail=200

# 跟随后端日志
docker logs -f atop-backend

# 跟随前端 Nginx 日志
docker logs -f atop-frontend

# 重启单个服务
docker compose restart atop-backend

# 停止全部服务
docker compose down

# 停止并删除 MySQL 数据卷，危险操作，仅测试环境使用
docker compose down -v
```

## 11. 常见问题

### 后端启动失败并提示 JWT_SECRET 或 AES_KEY

生产环境必须设置 `JWT_SECRET` 和 `AES_KEY`。编辑 `backend/deploy/.env` 后重新启动：

```bash
docker compose up -d --build atop-backend
```

### 前端能打开但接口报错

检查后端健康状态：

```bash
docker compose ps
curl http://localhost:8080/health
docker logs --tail=200 atop-backend
```

如果使用域名或前后端分离部署，确认 `CORS_ALLOW_ORIGINS` 和 Cookie 配置正确。

### Jenkins 任务无法回调 ATOP

确认 Jenkins 能访问：

```text
${WEBHOOK_BASE_URL}/api/webhook/task/<taskId>
```

如果 Jenkins 在内网，`WEBHOOK_BASE_URL` 应填写 Jenkins 可达的内网或公网地址。

### MySQL 初始化慢

首次启动 MySQL 会初始化数据目录和执行 SQL，可能需要几十秒。等待健康检查通过后后端会自动启动。

### 忘记管理员密码

如果已配置 SMTP，可在登录页走忘记密码流程。未配置 SMTP 时，可临时通过数据库重置用户状态和密码哈希，建议由运维人员在备份后处理。
