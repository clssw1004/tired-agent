# ── Stage 1: Build protocol + web SPA ────────────────────────────
FROM node:20-alpine AS web-builder
WORKDIR /app

RUN apk add --no-cache build-base python3

# Copy entire monorepo (npm ci needs all workspaces present)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/

RUN npm ci
RUN npm run build:protocol && npm run build:web

# ── Stage 2: Build manager ───────────────────────────────────────
FROM node:20-alpine AS manager-builder
WORKDIR /app

RUN apk add --no-cache build-base python3

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/

RUN npm ci
RUN npm run build:protocol && npm run build:manager

# ── Stage 3: Runtime ─────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache build-base python3

# Copy only what's needed at runtime
COPY --from=web-builder     /app/packages/web/dist       ./packages/web/dist
COPY --from=manager-builder /app/packages/manager/dist   ./packages/manager/dist
COPY --from=manager-builder /app/packages/manager/package.json ./packages/manager/
COPY --from=manager-builder /app/node_modules            ./node_modules
COPY --from=manager-builder /app/packages/protocol/dist  ./packages/protocol/dist

ENV CLSSW_MANAGER_HOST=0.0.0.0
ENV CLSSW_MANAGER_PORT=8443
ENV CLSSW_MANAGER_DATA=/data
ENV CLSSW_MANAGER_WEB_DIST=/app/packages/web/dist
ENV CORS_ORIGIN=*

EXPOSE 8443

WORKDIR /app/packages/manager
CMD ["node", "dist/index.js"]
