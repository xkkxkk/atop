# ATOP

ATOP 是一个自动化测试编排与调度平台，面向 Jenkins 集成、流水线编排、测试集管理、运行观测和平台治理等场景。

## 技术栈

- 后端：Go 1.23、Gin、GORM、MySQL 8、JWT、Zap
- 前端：React 18、Vite 5、TypeScript、Ant Design 5、SWR、Zustand
- 部署：Docker、Docker Compose、Nginx

## 目录结构

```text
.
├── backend/                 # Go 后端服务
│   ├── cmd/server/           # 服务入口与路由
│   ├── internal/             # 配置、数据库、业务处理器、中间件、调度器
│   ├── pkg/                  # 公共包
│   ├── scripts/              # 初始化 SQL 与 Jenkins 示例脚本
│   ├── deploy/               # Docker Compose 部署配置
│   └── Dockerfile
├── frontend/                # React 前端应用
│   ├── src/                  # 前端源码
│   ├── public/               # 静态资源
│   ├── nginx.conf            # 前端容器 Nginx 配置
│   └── Dockerfile
├── DEPLOYMENT.md            # 部署文档
└── USER_MANUAL.md           # 使用手册
```

## 文档入口

- [部署文档](DEPLOYMENT.md)：服务器准备、环境变量、Docker Compose 启动、升级、备份和排障。
- [使用手册](USER_MANUAL.md)：登录、仪表盘、流水线、运行记录、Jenkins、通知、权限和平台治理操作说明。

## 本地开发

### 后端

```bash
cd backend
cp .env.example .env
# 按需修改 .env 中的 DB、JWT_SECRET、AES_KEY 等配置
go mod download
go run ./cmd/server
```

默认后端端口为 `8080`，健康检查地址为 `http://localhost:8080/health`。

### 前端

```bash
cd frontend
npm install
npm run dev
```

默认前端开发端口为 `3000`，`/api` 会代理到 `VITE_BACKEND_URL`，未设置时代理到 `http://localhost:8080`。

## 生产部署速览

```bash
git clone git@github.com:xkkxkk/atop.git
cd atop/backend/deploy
cp .env.example .env
# 修改 .env 中的密码、密钥、管理员账号和公网地址
docker compose up -d --build
```

部署完成后访问 `http://服务器IP:8888`。初始管理员账号来自 `backend/deploy/.env` 中的 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`，首次登录后请立即修改密码。

## 安全提醒

- 不要提交真实 `.env`、数据库密码、JWT 密钥、Jenkins Token 或 SMTP 授权码。
- 生产环境必须修改 `JWT_SECRET`、`AES_KEY`、`WEBHOOK_HMAC_SECRET`、`MYSQL_ROOT_PASSWORD`、`DB_PASSWORD`。
- 建议只对公网开放前端入口端口或反向代理端口；MySQL 不应暴露到公网。
