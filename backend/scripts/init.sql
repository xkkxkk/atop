-- ============================================================
-- ATOP 数据库初始化脚本
-- 运行方式: mysql -u root -p < scripts/init.sql
-- 或 Docker 启动时自动执行（挂载到 /docker-entrypoint-initdb.d/）
-- ============================================================

CREATE DATABASE IF NOT EXISTS `atop`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 创建应用专用用户（如果使用 root 则跳过）
CREATE USER IF NOT EXISTS 'atop'@'%' IDENTIFIED BY 'atop123';
GRANT ALL PRIVILEGES ON `atop`.* TO 'atop'@'%';
FLUSH PRIVILEGES;

USE `atop`;

-- ────────────────────────────────────────────────────────────
-- 注意：以下建表语句由 GORM AutoMigrate 自动执行
-- 此脚本仅确保数据库和用户存在，以及插入必要的初始数据
-- ────────────────────────────────────────────────────────────

-- 等待 backend 完成 AutoMigrate 后插入初始数据的脚本
-- 实际初始数据由 Go 程序的 Seed() 函数插入

SELECT 'ATOP database initialized successfully' AS status;
