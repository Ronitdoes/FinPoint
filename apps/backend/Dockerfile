# ==============================================================================
# AI Revenue Recovery — canonical production image for API + worker (s-33).
#
# ONE image, two entries (cuts build surface per the step):
#   docker run ... arr-backend:<tag> api      # Fastify API (default CMD)
#   docker run ... arr-backend:<tag> worker   # Temporal worker
#   docker run ... arr-backend:<tag> migrate  # pre-deploy migration job
#
# Policies enforced here (mirrored by s-30 dependency-audit gate + s-33 CI):
#   - Base images pinned by digest (tag kept for readability; digest wins).
#   - `bun install --frozen-lockfile` only — stale lockfiles fail the build.
#   - Dev dependencies pruned in the runner (prod-deps stage).
#   - Non-root runtime user (appuser:1001).
#   - HEALTHCHECK probes GET /health (API mode). Worker containers MUST
#     disable it (compose `test: ["NONE"]`) — workers expose no HTTP port and
#     are supervised via Temporal + /metrics instead. See docs/deploy/.
#   - No secrets in build args or layers: GIT_SHA/APP_VERSION are metadata
#     only; all credentials arrive at runtime from the platform secret store.
#   - Startup fails LOUDLY: backend-entrypoint.sh validates required env and
#     lists every missing key (exit 2) before bun boots.
#   - Glibc base (Debian slim): @temporalio/core-bridge ships a glibc-linked
#     native module, so the image is Debian-based, NOT Alpine/musl.
#     Rebasing back to Alpine WILL re-break `worker` mode (ERR_DLOPEN_FAILED).
#
# Twin: infra/docker/backend.Dockerfile is the canonical production image —
# this file carries identical content for historical references (compose,
# README, audit script). Keep the two in sync (CI deploy-check verifies).
# Build context is always the repository root.
# ==============================================================================

# ---- deps: full workspace install for building -------------------------------
FROM oven/bun:1.4-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS deps
WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/policy/package.json ./packages/policy/package.json
COPY packages/orchestration/package.json ./packages/orchestration/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
COPY services/eval/package.json ./services/eval/package.json
COPY services/worker/package.json ./services/worker/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY packages/testing/package.json ./packages/testing/package.json

# NOTE (bun ≥1.4): the default linker is "isolated", so workspace-exclusive
# deps (e.g. dotenv) land in <workspace>/node_modules instead of the root.
# The stages below transport only the root /app/node_modules across
# (see COPY --from), so installs here pin `--linker hoisted` to keep one
# complete tree at /app/node_modules. Verified failure without it:
# `bun build` cannot resolve "dotenv" in the build stage.
# Every workspace manifest must be present or bun prints
# `skipped 1 workspace listed in bun.lock but not on disk` and re-resolves;
# keep this list in sync with the root workspaces (apps/*, packages/*,
# services/*). The bun tarball cache is BuildKit-mounted so rebuilds do not
# re-download every package (the prod-deps install is ~4min cold, silent
# under BuildKit until the final summary — that silence is expected, not a
# hang; use --progress=plain to watch it).
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --linker hoisted

# ---- build: compile what has a build step ------------------------------------
FROM oven/bun:1.4-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN bun run --cwd apps/backend build

# ---- prod-deps: production-only install (devDependencies pruned) -------------
FROM oven/bun:1.4-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS prod-deps
WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/policy/package.json ./packages/policy/package.json
COPY packages/orchestration/package.json ./packages/orchestration/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
COPY services/eval/package.json ./services/eval/package.json
COPY services/worker/package.json ./services/worker/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY packages/testing/package.json ./packages/testing/package.json

# Slim runtime tree: the runner boots workspace SOURCE (see entrypoint:
# `bun apps/backend/src/server.ts`, `bun services/worker/src/worker.ts`,
# `bun --filter @repo/db db:migrate`), so prod-deps installs ONLY the
# runtime closure below. Deliberately excluded: `frontend` (~80 pkgs,
# Next/React — measured 973MB -> ~430MB node_modules), `@repo/eval`
# (its only prod dep, zod, is already present), and the zero-prod-dep
# workspaces (testing/eslint-config/typescript-config).
# ADDING A WORKSPACE? If backend/worker imports it at runtime, append its
# --filter here AND keep the COPY list above covering every workspace
# (frozen-lockfile validity). The boot smoke test catches a missed entry
# (MODULE_NOT_FOUND instead of a connection error).
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --frozen-lockfile --linker hoisted \
      --filter backend \
      --filter @repo/config \
      --filter @repo/db \
      --filter @repo/domain \
      --filter @repo/integrations \
      --filter @repo/observability \
      --filter @repo/orchestration \
      --filter @repo/policy \
      --filter @repo/worker

# ---- runner: slim non-root runtime -------------------------------------------
# Debian slim (glibc) — `worker` mode loads @temporalio/core-bridge natively.
# Compose still disables the image HEALTHCHECK for workers (`test: ["NONE"]`).
FROM oven/bun:1.4-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runner
WORKDIR /app

# Release metadata only — never secrets (docs/deploy/environments.md).
ARG GIT_SHA=dev
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    GIT_SHA=$GIT_SHA \
    APP_VERSION=$APP_VERSION

RUN groupadd -r -g 1001 appgroup && \
    useradd -r -u 1001 -g appgroup -s /usr/sbin/nologin -M appuser && \
    apt-get update -qq && apt-get install -y -qq --no-install-recommends wget && \
    rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=prod-deps --chown=appuser:appgroup /app/package.json ./package.json
COPY --from=prod-deps --chown=appuser:appgroup /app/bun.lock ./bun.lock
COPY --from=build --chown=appuser:appgroup /app/apps/backend ./apps/backend
COPY --from=build --chown=appuser:appgroup /app/packages ./packages
COPY --from=build --chown=appuser:appgroup /app/services/worker ./services/worker
COPY --from=build --chown=appuser:appgroup /app/infra/docker/backend-entrypoint.sh ./infra/docker/backend-entrypoint.sh

# Strip CR so Windows (CRLF) checkouts can never break the shebang again;
# without this, `#!/bin/sh\r` fails exec with "no such file or directory".
RUN sed -i 's/\r$//' ./infra/docker/backend-entrypoint.sh && chmod +x ./infra/docker/backend-entrypoint.sh

USER appuser

EXPOSE 4000

# API liveness probe (LB target: GET /health; readiness gate: GET /ready).
# Worker-mode containers must override with `test: ["NONE"]` — see header.
HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:${PORT:-4000}/health || exit 1

ENTRYPOINT ["/app/infra/docker/backend-entrypoint.sh"]
CMD ["api"]
