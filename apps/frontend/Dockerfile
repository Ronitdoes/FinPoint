# Multi-stage Dockerfile for Next.js Frontend (apps/frontend)
FROM oven/bun:1.4-alpine AS base
WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock turbo.json ./
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json

RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build Next.js standalone application
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN mkdir -p /app/apps/frontend/public
RUN bun run --cwd apps/frontend build

# Slim production runner
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output and static assets
COPY --from=base --chown=nextjs:nodejs /app/apps/frontend/.next/standalone ./
COPY --from=base --chown=nextjs:nodejs /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=base --chown=nextjs:nodejs /app/apps/frontend/public ./apps/frontend/public

USER nextjs

EXPOSE 3000

CMD ["node", "apps/frontend/server.js"]
