# ATOP Backend — Development Progress

## Status: 全部完成 ✅

---

## 已完成功能清单

### 后端（Go + Gin + GORM）
- ✅ 认证：JWT登录/刷新/登出/改密，auto refresh
- ✅ 数据字典：六维坐标 CRUD（project/environment/product/silicon/os/run_type）
- ✅ Jenkins 实例：CRUD/Ping/SyncAgents（真实同步 agent_labels + agent_nodes）
- ✅ 公共变量池：CRUD
- ✅ 函数库：CRUD + 版本历史 + 回滚
- ✅ 测试集：CRUD + 复制 + 批量状态 + 预览JSON + 单独触发 + 批量导入（兼容公司格式）
- ✅ 流水线：CRUD + 触发运行（Jenkins分发）+ Cron定时触发
- ✅ 运行记录：列表/详情/中止 + 项目分组统计
- ✅ 任务：中止 + Stage View + 日志检测（5分钟冷却）+ Webhook回调 + HMAC验证
- ✅ 用户管理：CRUD + 状态 + 重置密码 + CSV批量导入
- ✅ 审计日志：列表
- ✅ 调度引擎：goroutine池 + Jenkins分发 + 队列轮询 + 崩溃恢复
- ✅ 定时任务：Cron触发 + 日志存活扫描 + 180天数据清理

### 前端（React + TypeScript + Ant Design）
- ✅ 登录/登出，401 auto token refresh
- ✅ 数据字典管理（六Tab）
- ✅ Jenkins实例 + Agent标签
- ✅ 公共变量池
- ✅ 函数库（Monaco编辑器 + 版本历史）
- ✅ 测试集列表（六维筛选 + 复制 + 批量导入）
- ✅ 测试集编辑（五Tab + 内部Docker:git clone+script）
- ✅ 流水线列表 + 编辑（Jenkins参数对应parameters{}）+ 触发
- ✅ 运行大盘 + 运行详情 + Stage View + 日志检测
- ✅ 用户管理（CRUD + CSV批量导入）
- ✅ 审计日志

### 部署
- ✅ Docker Compose 三服务（MySQL + Backend + Frontend）
- ✅ nginx 反代 + SPA fallback
- ✅ 完整部署文档（DEPLOY.md）
- ✅ Smoke 测试脚本（38个接口断言）

---

## 关键设计决策

1. **响应格式**：`{code, message, data}`，分页：`data.{items,total,page,pageSize}`
2. **内部Docker**：git clone repo → repo内shell脚本 → 脚本处理docker pull+run
3. **流水线参数**：对应Jenkins `parameters{}` 块，触发时作为构建参数传入
4. **测试集复制**：名称加`_copy`，状态强制disabled，名称自动去重
5. **批量导入**：兼容公司格式（new_project/exec_cmd/set_up）和ATOP原生格式
6. **Webhook HMAC**：`X-Atop-Signature: sha256=xxx`，未配置时跳过验证
7. **用户CSV导入**：初始密码=邮箱前缀@123456，projects用`|`分隔
8. **Docker网络**：三容器同在atop-net，前端nginx通过hostname反代后端

---

## Smoke 测试

```bash
chmod +x /opt/ATOP/atop-backend/scripts/smoke_test.sh
./scripts/smoke_test.sh http://localhost:8080 admin@atop.local Admin@123456
```

## 下次继续

如需继续开发，发送本文件说明需求即可。
