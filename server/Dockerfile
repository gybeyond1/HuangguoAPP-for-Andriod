# 橙子短剧（接手版）轻量后端镜像
FROM node:22-alpine

# 下载/合并依赖：ffmpeg（concat 合并 + ffprobe 编码探测），alpine 官方包含两件套
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./
COPY downloader.js ./
COPY hongguo-decrypt.js ./

ENV PORT=8080
EXPOSE 8080
VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "index.js"]
