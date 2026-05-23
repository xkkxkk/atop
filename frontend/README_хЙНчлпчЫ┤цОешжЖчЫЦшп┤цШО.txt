在服务器进入 atop-frontend 目录后执行：
unzip -o ATOP_frontend_overlay_direct_20260519.zip

覆盖后重新构建前端：
cd /opt/ATOP/atop-backend/deploy
docker compose up -d --build atop-frontend
