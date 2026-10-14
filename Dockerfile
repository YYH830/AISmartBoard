# AI智能看板 —— Docker 镜像
#
# 构建：docker build -t work-task-board .
# 运行：docker run -d --name work-board -p 8765:8765 \
#         -e WTK_USER=admin -e WTK_PASS=你的密码 \
#         -v "$PWD/data:/app/data" work-task-board
#
# 也可以直接用同目录的 docker-compose.yml：docker compose up -d

FROM node:20-alpine

WORKDIR /app

# 程序本体（零依赖，不需要 npm install）
COPY app/ ./app/

# 时区设为北京时间，让日志和页面时间正确
ENV TZ=Asia/Shanghai

# 对外监听；密码请在运行时用 -e WTK_PASS=... 指定
ENV WTK_HOST=0.0.0.0 \
    WTK_PORT=8765

EXPOSE 8765

# 台账数据目录，挂载出来才能持久化，否则容器重建后数据会丢
VOLUME ["/app/data"]

# --no-open：容器里没有浏览器，不要尝试打开
CMD ["node", "app/server.js", "--no-open"]
