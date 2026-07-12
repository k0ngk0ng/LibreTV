FROM node:22-alpine

LABEL maintainer="LibreTV Team"
LABEL description="LibreTV - 免费在线视频搜索与观看平台"

ARG APP_VERSION=""
ARG GIT_COMMIT=""

# 设置环境变量
ENV PORT=8080
ENV DEBUG=false
ENV REQUEST_TIMEOUT=15000
ENV MAX_RETRIES=2
ENV CACHE_MAX_AGE=1d
ENV DATA_DIR=/app/data
ENV TRUST_PROXY=true
ENV COOKIE_SECURE=auto
ENV APP_VERSION=${APP_VERSION}
ENV GIT_COMMIT=${GIT_COMMIT}

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖
RUN npm ci --omit=dev && npm cache clean --force

# 复制应用文件
COPY --chown=node:node . .

# 在镜像中固化 tag/commit，并移除 Git 历史。
RUN node scripts/write-build-version.mjs && rm -rf /app/.git

# 账户和观看记录保存在独立数据卷中
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

# 暴露端口
EXPOSE 8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/healthz', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# 启动应用
CMD ["npm", "start"]
