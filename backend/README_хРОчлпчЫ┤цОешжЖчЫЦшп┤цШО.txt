在服务器进入 atop-backend 目录后执行：
unzip -o ATOP_backend_overlay_direct_20260519.zip

说明：
1. 本包不包含 deploy/.env，不会覆盖你的运行配置。
2. 覆盖后进入 deploy 目录执行：
   docker compose up -d --build atop-backend
