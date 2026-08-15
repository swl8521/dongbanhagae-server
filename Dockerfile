# better-sqlite3는 네이티브 애드온이라 빌드 스테이지에서 컴파일 도구로 미리 빌드해두고,
# 런타임 이미지에는 컴파일된 결과물만 옮겨 이미지 용량을 줄인다.
FROM node:24.19.0-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.19.0-slim
WORKDIR /app
ENV NODE_ENV=production

RUN useradd --create-home --shell /bin/bash appuser

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN mkdir -p /app/data && chown -R appuser:appuser /app

USER appuser
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/index.js"]
