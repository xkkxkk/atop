# ATOP 生产部署注意事项

本文档用于正式上线前检查，重点覆盖真实域名、HTTPS、MySQL、端口暴露、密钥、Jenkins 回调、备份和升级。

## 1. 推荐生产架构

推荐使用单域名同源部署：

```text
https://atop.example.com
        |
        v
外层 Nginx / 云负载均衡 / 宝塔 HTTPS
        |
        v
ATOP 前端容器 127.0.0.1:8888
        |
        | /api 和 /ws 由前端容器 Nginx 反向代理
        v
ATOP 后端容器 8080
        |
        v
MySQL 容器 3306
```

单域名部署的好处是 Cookie、CORS、HTTPS 和前端 API 调用最简单，生产故障点也最少。

## 2. 域名与 HTTPS

生产环境建议使用真实域名和 HTTPS，例如：

```text
https://atop.example.com
```

外层 Nginx 示例：

```nginx
server {
    listen 80;
    server_name atop.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name atop.example.com;

    ssl_certificate     /etc/letsencrypt/live/atop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/atop.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

对应 `backend/deploy/.env` 建议：

```env
EXTERNAL_URL=https://atop.example.com
WEBHOOK_BASE_URL=https://atop.example.com
CORS_ALLOW_ORIGINS=https://atop.example.com
CORS_ALLOW_CREDENTIALS=true
COOKIE_DOMAIN=
COOKIE_SAME_SITE=lax
COOKIE_SECURE=auto
```

如果必须拆成前后端不同域名，例如前端 `https://atop.example.com`、后端 `https://api.example.com`，再使用：

```env
CORS_ALLOW_ORIGINS=https://atop.example.com
COOKIE_DOMAIN=.example.com
COOKIE_SAME_SITE=none
COOKIE_SECURE=true
```

不建议在公网生产环境使用纯 HTTP，除非只在内网 VPN 中访问。

## 3. 端口暴露

公网建议只开放：

| 端口 | 用途 | 建议 |
| --- | --- | --- |
| `80` | HTTP 跳转 HTTPS | 可开放 |
| `443` | HTTPS 正式入口 | 必须开放 |
| `22` | SSH 运维 | 只允许固定办公 IP 或堡垒机 |

不建议公网开放：

| 端口 | 风险 |
| --- | --- |
| `8080` | 后端 API 暴露后会绕过外层入口策略 |
| `3306` | MySQL 暴露公网风险极高 |
| `8888` | 如果有外层 HTTPS 代理，前端容器端口不需要公网直连 |

如果 Jenkins 不需要公网直连后端，可以把后端端口改为仅本机监听：

```yaml
ports:
  - "127.0.0.1:8080:8080"
```

如果宿主机不需要直接访问 MySQL，可以移除 MySQL 的 `ports` 映射，只让容器网络内部访问。

## 4. MySQL 部署注意事项

### 4.1 密码

生产环境必须修改：

```env
MYSQL_ROOT_PASSWORD=强随机密码
DB_PASSWORD=强随机密码
```

建议 `root` 密码和 ATOP 应用数据库密码不同。不要把真实 `.env` 提交到 Git。

### 4.2 数据卷

Compose 使用 `mysql_data` 持久化数据。生产环境不要执行：

```bash
docker compose down -v
```

这个命令会删除数据库卷，等同于删除生产数据。

### 4.3 字符集

当前 compose 已设置 `utf8mb4`，适合中文、英文和 emoji 等字符。不要改回 `latin1` 或旧字符集。

### 4.4 备份

建议每天自动备份，至少保留 7 到 30 天。示例：

```bash
mkdir -p /opt/atop-backup
set -a
. /opt/atop/backend/deploy/.env
set +a
docker exec atop-mysql mysqldump -u atop -p"$DB_PASSWORD" atop \
  > /opt/atop-backup/atop-$(date +%Y%m%d-%H%M%S).sql
```

备份后要定期抽查恢复。没有验证过恢复的备份，不算可靠备份。

### 4.5 资源和监控

上线后关注：

- 数据盘剩余空间。
- MySQL 容器是否频繁重启。
- 慢查询数量。
- 备份文件是否持续生成。
- 日志和 Docker 镜像是否占满磁盘。

数据量增长后，可以考虑将 MySQL 迁移到云数据库 RDS 或独立数据库服务器。

## 5. 关键密钥和账号

生产前必须替换：

```env
JWT_SECRET=至少 32 字节随机值
AES_KEY=至少 32 字节随机值
WEBHOOK_HMAC_SECRET=至少 32 字节随机值
ADMIN_PASSWORD=高强度初始密码
```

生成密钥：

```bash
openssl rand -hex 32
```

注意：

- `AES_KEY` 用于加密 Jenkins Token 等敏感信息，上线后不要随意修改。
- `JWT_SECRET` 修改后，已有登录会话会失效。
- `WEBHOOK_HMAC_SECRET` 应与 Jenkins 回调脚本配置保持一致。
- 初始管理员登录后应立即修改密码。

## 6. Jenkins 回调

Jenkins 必须能访问：

```text
${WEBHOOK_BASE_URL}/api/webhook/task/<taskId>
```

如果 Jenkins 在内网，`WEBHOOK_BASE_URL` 可以填 Jenkins 可达的内网地址，例如：

```env
WEBHOOK_BASE_URL=http://10.0.0.10:8080
```

如果 Jenkins 通过公网访问 ATOP，建议使用 HTTPS 域名：

```env
WEBHOOK_BASE_URL=https://atop.example.com
```

上线前检查：

- ATOP 后端能访问 Jenkins URL。
- Jenkins 能访问 ATOP 的 webhook URL。
- Jenkins Token 权限足够触发 Job、读取节点和查询构建结果。
- `WEBHOOK_HMAC_SECRET` 已设置，避免回调接口无签名运行。

## 7. SMTP 邮件

忘记密码和邮件通知依赖 SMTP。上线前至少测试：

- 登录页忘记密码。
- 通知规则测试发送。
- 邮件是否进入垃圾箱。
- SMTP 授权码是否长期有效。

不要使用邮箱登录密码，使用专用授权码或应用密码。

## 8. 发布与升级

推荐发布步骤：

```bash
cd /opt/atop
git pull
cd backend/deploy
docker compose up -d --build
docker compose ps
docker compose logs --tail=100
```

升级前检查：

- 已完成 MySQL 备份。
- `.env` 文件仍在服务器上，且没有被覆盖。
- 磁盘空间充足。
- 当前版本 commit 已记录，方便回滚。

如果只更新前端：

```bash
docker compose up -d --build atop-frontend
```

如果只更新后端：

```bash
docker compose up -d --build atop-backend
```

## 9. 回滚建议

代码回滚：

```bash
git log --oneline -5
git checkout <上一稳定提交>
cd backend/deploy
docker compose up -d --build
```

数据库回滚必须谨慎。只有在明确需要时，才从备份恢复数据库。恢复前建议先停服务并再次备份当前状态。

## 10. 上线前检查清单

| 检查项 | 期望结果 |
| --- | --- |
| GitHub 仓库权限 | 私有项目保持 private，仅授权必要成员 |
| `.env` | 只存在服务器，不进入 Git |
| 域名 | 解析到服务器或负载均衡 |
| HTTPS | 证书有效，支持自动续期 |
| `EXTERNAL_URL` | 使用正式访问地址 |
| `WEBHOOK_BASE_URL` | Jenkins 可访问 |
| MySQL | 不暴露公网，数据卷持久化 |
| 备份 | 可生成，也验证过恢复 |
| 端口 | 公网只开放 80/443 和受限 SSH |
| 管理员 | 初始密码已修改 |
| Jenkins | 连通性、Token、Agent 同步正常 |
| SMTP | 忘记密码和通知测试成功 |
| 健康检查 | `/health` 和 `/nginx-health` 正常 |
| 日志 | 后端、前端、MySQL 无持续报错 |

## 11. 上线后日常巡检

建议每天或每周固定检查：

```bash
docker compose ps
docker compose logs --tail=100
docker system df
df -h
```

重点关注：

- 服务是否健康。
- 磁盘是否接近满。
- MySQL 备份是否按时生成。
- Jenkins 回调是否存在失败。
- 是否有异常登录、权限变更或数据清理记录。
