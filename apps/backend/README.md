# AI Revenue Recovery — Fastify Backend API & Event Gateway (`apps/backend`)

Production Fastify 5 application hosting the Event Gateway (webhooks, event ingestion) and internal REST APIs for AI decisions, policy rules, customer context, and recovery cases.

---

## 1. Architecture & Capabilities

- **Framework**: Fastify v5 on Bun runtime (ADR-001, ADR-002).
- **App Factory**: `buildApp(opts)` in `src/app.ts` enables fast in-memory testing (`app.inject()`) without network port binding.
- **Request Context**: Correlation tracking (`x-correlation-id`, W3C `traceparent`, `x-request-id`) bound to child Pino loggers.
- **Canonical Error Envelope**: Strict JSON format `{ error: { code, message, details } }` across all status codes (400, 401, 403, 404, 409, 413, 422, 429, 500).
- **Graceful Shutdown**: Signal-aware teardown (`SIGTERM`/`SIGINT`) draining in-flight requests (20s timeout), database connection pools, and Redis clients.
- **Rate Limiting**: Redis-backed global rate limiting (`rr:global:ratelimit:`) with graceful in-memory fallback.
- **Health & Readiness**: `/health` (process liveness) and `/ready` (PostgreSQL + Redis dependency evaluation cached for 5s).

---

## 2. Local Development

### Prerequisites
- Bun ≥ 1.4
- Running local infrastructure (`bun run infra:up` from repo root)

### Running Locally

```bash
# Start backend in watch mode (auto-reloads on file changes)
bun run dev --filter backend
# or inside apps/backend:
bun run dev

# Run type check
bun run check-types

# Run backend test suite
bun test src/app.test.ts
```

---

## 3. Docker Containerization

The backend includes a multi-stage `Dockerfile` based on `oven/bun:1.4-alpine`.

### Building the Docker Image

```bash
# From repository root
docker build -f apps/backend/Dockerfile -t arr-backend:latest .
```

### Running with Docker Compose

The backend is configured in `infra/docker/docker-compose.yml`:

```bash
# Start full stack including backend, frontend, postgres, redis, temporal, redpanda
bun run infra:up

# Check logs
docker logs -f arr-backend

# Stop full stack
bun run infra:down
```

### Healthcheck

The container exposes a health check endpoint:
```bash
wget -q --spider http://127.0.0.1:4000/health || exit 1
```

---

## 4. Endpoints

| Method | Path | Description | Auth Required |
|---|---|---|---|
| `GET` | `/health` | Process liveness check | No |
| `GET` | `/api/health` | Backward-compatibility health check alias | No |
| `GET` | `/ready` | Dependency readiness probe (Postgres, Redis, Temporal) | No |
| `GET` | `/version` | Application name, version, gitSha, environment | No |
| `GET` | `/` & `/api` | Root discovery and running status | No |
