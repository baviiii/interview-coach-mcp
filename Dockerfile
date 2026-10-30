# interview-coach-mcp — single-process Express server (MCP + REST).
#
# Compiled to plain JavaScript at build time. The image used to run src/*.ts
# through tsx, which transpiled every file on every cold start — seconds of
# each scale-from-zero spent compiling the same unchanged code.
#
# Node 22 or later: supabase-js needs the built-in WebSocket that Node 22 added,
# and on Node 20 it throws while creating a client — so every signed-in request
# failed with a 500 while /health stayed green.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Lambda Web Adapter. Inside Lambda it turns each invocation into an HTTP
# request to this server; anywhere else (docker run, CI) it is an unused file.
# Its settings (port, readiness path, response streaming) are env vars on the
# function, in horus-platform's infrastructure/tofu/envs/aws-dev/mcp.tf.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.1.0 /lambda-adapter /opt/extensions/lambda-adapter
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://localhost:${PORT:-8787}/health" || exit 1

USER node
CMD ["node", "--enable-source-maps", "dist/server.js"]
