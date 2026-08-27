# Multi-stage Dockerfile for Fastify Backend (apps/backend)
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock turbo.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json

RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build backend application
ENV NODE_ENV=production
RUN bun run --cwd apps/backend build

# Slim production runner
FROM oven/bun:1.4-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

RUN addgroup -S -g 1001 appgroup && \
    adduser -S -u 1001 -G appgroup appuser

# Copy installed dependencies and workspace files
COPY --from=base --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=base --chown=appuser:appgroup /app/package.json ./package.json
COPY --from=base --chown=appuser:appgroup /app/apps/backend ./apps/backend
COPY --from=base --chown=appuser:appgroup /app/packages ./packages

USER appuser

EXPOSE 4000

CMD ["bun", "apps/backend/src/server.ts"]
