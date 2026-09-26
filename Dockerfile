# syntax=docker/dockerfile:1

# ---- 基础层：源码与脚本（零依赖，无需 npm install） ----
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests

# ---- 构建层：测试 + 构建检查，产出 dist/（构建期失败即中断） ----
FROM base AS build
RUN node --test && node scripts/build.mjs

# ---- 运行层：nginx 托管静态产物，内置健康检查 ----
FROM nginx:1.27-alpine AS serve
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

# ---- 验证层：一次性 verify 服务（测试 + 构建检查 + 健康地址冒烟） ----
FROM base AS verify
ENV HEALTH_URL=http://web/healthz \
    WEB_URL=http://web/
CMD ["node", "scripts/verify.mjs"]
