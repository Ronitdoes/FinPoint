# ==============================================================================
# AI Revenue Recovery — canonical production image for the Next.js dashboard.
#
# Policies enforced here (mirrored by s-30 dependency-audit gate + s-33 CI):
#   - Base images pinned by digest (tag kept for readability; digest wins).
#   - `bun install --frozen-lockfile` only.
#   - Next.js `output: "standalone"` bundle served by node:20-alpine.
#   - Non-root runtime user (nextjs:1001).
#   - HEALTHCHECK probes GET / (dashboard root redirects to /dashboard).
#   - Build args MUST be NEXT_PUBLIC_* only. Next.js inlines NEXT_PUBLIC_*
#     into the client bundle at build time, so any other ARG would bake a
#     secret into the image layers — forbidden (CONVENTIONS §12). The s-33
#     deploy-check script fails the build on any non-NEXT_PUBLIC_* ARG.
#
# Twin: infra/docker/frontend.Dockerfile is the canonical production image —
# this file carries identical content for historical references (compose,
# README, audit script). Keep the two in sync (CI deploy-check verifies).
# Build context is always the repository root.
# ==============================================================================

FROM oven/bun:1.4-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS base
WORKDIR /app

# Copy dependency manifests.
# Every workspace in the root dependency graph must exist on disk or
# `bun install --frozen-lockfile` fails on the pruned checkout (keep this
# list in sync with root package.json workspace deps).
COPY package.json bun.lock turbo.json ./
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/policy/package.json ./packages/policy/package.json
COPY packages/orchestration/package.json ./packages/orchestration/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
COPY packages/testing/package.json ./packages/testing/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY services/eval/package.json ./services/eval/package.json
COPY services/worker/package.json ./services/worker/package.json

RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build Next.js standalone application.
# NEXT_PUBLIC_API_URL is the ONLY permitted build arg (public by design).
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN mkdir -p /app/apps/frontend/public
RUN bun run --cwd apps/frontend build

# Slim production runner
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner
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

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/ || exit 1

CMD ["node", "apps/frontend/server.js"]
