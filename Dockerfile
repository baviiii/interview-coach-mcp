# interview-coach-mcp — single-process Express server (MCP + REST).
#
# Compiled to plain JavaScript at build time. The image used to run src/*.ts
# through tsx, which transpiled every file on every cold start — seconds of
# each scale-from-zero spent compiling the same unchanged code.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://localhost:${PORT:-8787}/health" || exit 1

USER node
CMD ["node", "--enable-source-maps", "dist/server.js"]
