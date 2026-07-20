# interview-coach-mcp — single-process Express server (MCP + REST).
# tsx is a runtime dependency; the server runs TypeScript directly.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://localhost:${PORT:-8787}/health" || exit 1

USER node
CMD ["npx", "tsx", "src/server.ts"]
