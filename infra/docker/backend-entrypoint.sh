#!/bin/sh
# ==============================================================================
# AI Revenue Recovery — unified backend/worker image entrypoint (s-33).
#
# Modes:
#   api            Start the Fastify API server (default)
#   worker         Start the Temporal worker (same image, different entry)
#   migrate        Run pending Drizzle migrations as a pre-deploy job (DIRECT_URL)
#   migrate:check  Verify no pending migrations (CI gate; exits 1 when behind)
#
# Startup self-check: every mode validates its required env vars FIRST and
# fails LOUDLY (exit 2) listing every missing key, before bun boots. Deeper
# validation (provider keys when MOCK_PROVIDERS=false, bus consistency) stays
# in @repo/config, which throws ConfigValidationError with the same loud list.
#
# No secrets are read from files here; everything comes from the runtime
# environment (platform secret store in staging/prod — never baked images).
# ==============================================================================
set -eu

MODE="${1:-api}"
shift 2>/dev/null || true

APP_VERSION="${APP_VERSION:-dev}"
GIT_SHA="${GIT_SHA:-dev}"
DEPLOY_ENV="${DEPLOY_ENV:-local}"
MOCK_PROVIDERS="${MOCK_PROVIDERS:-true}"

log() {
  echo "entrypoint: $1"
}

fail_missing() {
  # $1 = space-separated list of missing keys
  echo "FATAL: missing required config:$1" >&2
  echo "FATAL: refusing to boot ${MODE} without complete configuration (s-33 image-smoke contract)" >&2
  exit 2
}

# Collects missing vars from "$@" into a space-separated list (POSIX sh).
require_vars() {
  missing=""
  for name in "$@"; do
    value=""
    eval "value=\${$name:-}" || true
    if [ -z "${value}" ]; then
      missing="${missing} ${name}"
    fi
  done
  if [ -n "${missing}" ]; then
    fail_missing "${missing}"
  fi
}

case "${MODE}" in
  api)
    require_vars DATABASE_URL REDIS_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE
    ;;
  worker)
    require_vars DATABASE_URL REDIS_URL TEMPORAL_ADDRESS TEMPORAL_NAMESPACE
    ;;
  migrate|migrate:check)
    # DIRECT_URL falls back to DATABASE_URL inside @repo/config; the runner
    # needs at least the pooled URL, and warns when no dedicated direct URL
    # is set (pooler-transparent DDL risk — see docs/deploy/migrations.md).
    require_vars DATABASE_URL
    if [ -z "${DIRECT_URL:-}" ]; then
      log "WARN: DIRECT_URL unset — migrations will run over DATABASE_URL (fine locally; staging/prod must set a direct unpooled URL)"
    fi
    ;;
  *)
    echo "FATAL: unknown mode '${MODE}' (expected: api | worker | migrate | migrate:check)" >&2
    exit 2
    ;;
esac

if [ "${MOCK_PROVIDERS}" = "false" ]; then
  log "live-provider mode (MOCK_PROVIDERS=false): provider keys enforced by @repo/config fail-fast; /demo routes omitted from prod-shape"
else
  log "mock-provider mode (MOCK_PROVIDERS=${MOCK_PROVIDERS}): /demo simulation routes enabled"
fi
log "booting mode=${MODE} version=${APP_VERSION} sha=${GIT_SHA} env=${DEPLOY_ENV}"

case "${MODE}" in
  api)
    exec bun apps/backend/src/server.ts "$@"
    ;;
  worker)
    exec bun services/worker/src/worker.ts "$@"
    ;;
  migrate)
    exec bun --filter @repo/db db:migrate "$@"
    ;;
  migrate:check)
    exec bun --filter @repo/db db:migrate:check "$@"
    ;;
esac
