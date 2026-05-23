# ATOP 部署文档

## 目录结构要求

部署前确保目录结构如下（两个仓库并排）：

```
/opt/ATOP/
├── atop-backend/        ← 后端代码
│   ├── Dockerfile
│   ├── cmd/
│   ├── internal/
│   ├── scripts/
│   │   └── init.sql
│   └── deploy/
│       ├── docker-compose.yml
│       └── .env.example
└── atop-frontend/       ← 前端代码
    ├── Dockerfile
    ├── nginx.conf
    ├── src/
    └── package.json
```

---

## 一键部署步骤

### 1. 安装 Docker 和 Docker Compose

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# 验证
docker --version
docker compose version
```

### 2. 上传代码到服务器

```bash
# 在本地解压两个包到 /opt/ATOP/
mkdir -p /opt/ATOP
cd /opt/ATOP

tar -xzf atop-backend-batch1.tar.gz
tar -xzf atop-backend-batch2.tar.gz  # 覆盖 scheduler + main.go
tar -xzf atop-frontend-*.tar.gz      # 前端代码
```

### 3. 配置环境变量

```bash
cd /opt/ATOP/atop-backend/deploy
cp .env.example .env

# 编辑以下必填项
vi .env
```

**必须修改的配置项：**

| 变量 | 说明 | 示例 |
|------|------|------|
| `MYSQL_ROOT_PASSWORD` | MySQL root 密码 | `RootPass@2025!` |
| `DB_PASSWORD` | 应用数据库密码 | `AtopDB@2025` |
| `JWT_SECRET` | JWT 签名密钥（64位随机串） | `openssl rand -base64 64` |
| `AES_KEY` | Jenkins Token 加密密钥 | `openssl rand -base64 32` |
| `ADMIN_EMAIL` | 首次登录的管理员邮箱 | `admin@company.com` |
| `ADMIN_PASSWORD` | 管理员初始密码 | `#PassW0rd` |
| `WEBHOOK_BASE_URL` | 后端对外地址（Jenkins 能访问） | `http://192.168.1.100:8080` |

生成随机密钥：
```bash
# JWT_SECRET
openssl rand -base64 64 | tr -d '\n'

# AES_KEY
openssl rand -base64 32 | tr -d '\n'
```

### 4. 启动服务

```bash
cd /opt/ATOP/atop-backend/deploy

# 首次启动（构建镜像，需要几分钟）
docker compose up -d --build

# 查看启动日志
docker compose logs -f

# 验证所有服务健康
docker compose ps
```

期望输出：
```
NAME              STATUS
atop-mysql        Up (healthy)
atop-backend      Up (healthy)
atop-frontend     Up (healthy)
```

### 5. 验证部署

```bash
# 后端健康检查
curl http://localhost:8080/health
# 返回: {"code":"OK","message":"success","data":{"status":"ok","db":"ok"}}

# 前端访问
curl http://localhost/nginx-health
# 返回: ok

# 浏览器访问
http://服务器公网IP
```

**默认管理员账号：** 使用 `.env` 中配置的 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 登录

---

## 日常运维

### 查看日志

```bash
# 查看后端实时日志
docker logs -f atop-backend

# 查看所有服务最近 100 行
docker compose logs --tail=100

# 查看 MySQL 慢查询日志
docker exec atop-mysql tail -f /var/lib/mysql/slow.log
```

### 重启服务

```bash
# 重启单个服务
docker restart atop-backend
docker restart atop-frontend

# 重启全部
docker compose restart
```

### 更新部署（上线新代码）

```bash
cd /opt/ATOP/atop-backend/deploy

# 重新构建并更新（零停机秒级）
docker compose up -d --build atop-backend
docker compose up -d --build atop-frontend
```

### 数据库备份

```bash
# 全量备份
docker exec atop-mysql mysqldump -u atop -p${DB_PASSWORD} atop \
  > /backup/atop-$(date +%Y%m%d).sql

# 定时备份（加入 crontab）
# crontab -e
# 0 2 * * * docker exec atop-mysql mysqldump -u atop -p${DB_PASSWORD} atop > /backup/atop-$(date +\%Y\%m\%d).sql
```

### 查看磁盘使用

```bash
# Docker 整体占用
docker system df

# 清理无用镜像（谨慎）
docker image prune -f
```

---

## 开放端口

| 端口 | 服务 | 说明 |
|------|------|------|
| 80 | Nginx (前端) | 对外开放 |
| 8080 | Go (后端) | 仅本机，不对外 |
| 3306 | MySQL | 仅本机，不对外 |

**阿里云安全组只需开放 80 端口**（8080 由 Nginx 反代，不需要对外）

---

## 阿里云安全组配置

| 规则 | 协议 | 端口 | 来源 | 说明 |
|------|------|------|------|------|
| 允许 | TCP | 80 | 0.0.0.0/0 | 前端访问 |
| 允许 | TCP | 22 | 你的IP | SSH 管理（建议限制来源IP） |

> **不要开放 8080 和 3306 给公网**

---

## 常见问题

**Q: `docker compose up` 后后端立刻退出**
```bash
docker logs atop-backend
# 通常是 DB 连接失败，检查 DB_PASSWORD 是否和 mysql 服务一致
```

**Q: 前端打开后 API 请求 404**
- 检查 nginx.conf 中 proxy_pass 是否为 `http://atop-backend:8080`
- 查看 nginx 日志：`docker logs atop-frontend`

**Q: MySQL 启动慢导致后端 health check 失败**
- 正常现象，MySQL 首次初始化需要 30-60 秒
- 后端会等待 MySQL `service_healthy` 后才启动
- 等待即可

**Q: 前端 build 时内存不足**
```bash
# 给 Node 分配更多内存
# 修改 atop-frontend/Dockerfile 中的 npm run build 为:
NODE_OPTIONS=--max_old_space_size=2048 npm run build
```

---

## 目录说明

```
atop-backend/
├── cmd/server/main.go      # 入口
├── internal/
│   ├── config/             # 配置读取
│   ├── database/           # DB 连接、迁移、种子
│   ├── handler/            # HTTP 处理器（业务逻辑）
│   ├── middleware/         # JWT、CORS、日志
│   ├── model/              # 数据库模型（14张表）
│   ├── scheduler/          # Jenkins 调度引擎
│   └── util/               # 工具函数
├── pkg/
│   ├── jwt/                # JWT 生成验证
│   ├── logger/             # zap 日志封装
│   └── response/           # 统一响应格式
├── scripts/init.sql        # MySQL 初始化
├── deploy/
│   ├── docker-compose.yml  # 全栈部署
│   └── .env.example        # 配置模板
└── Dockerfile
```

