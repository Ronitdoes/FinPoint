# ADR-001 — Runtime: Bun for API and worker services

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §3, repo `package.json` (`devEngines.packageManager` = bun 1.4.0, `bun.lock`)

## Context

The repository is already Bun-locked: the root manifest pins Bun as package manager via `devEngines` and commits a `bun.lock`. The original backend stub ran on `Bun.serve` (historical; replaced by Fastify in s-07 per ADR-002). The frontend is Next.js and runs on its own runtime regardless of this decision.

## Decision

1. Bun ≥ 1.4 is the runtime for all long-running TypeScript services in this repo: `apps/backend` (Fastify event gateway + internal APIs) and `services/worker` (Temporal worker).
2. Application code stays Node-compatible: standard Web/Node APIs only. Bun-specific APIs (`Bun.serve`, `Bun.file`, bun:sqlite, etc.) are allowed **only inside entrypoint files** (`server.ts`, CLI scripts) where they are trivially swappable.
3. The Next.js app (`apps/frontend`) keeps its own runtime; no assumption about Bun is made inside its code.
4. Package manager is Bun for install/run/script execution across the monorepo.

## Consequences

- Single toolchain for dev, test, and script execution; fast cold starts for workers.
- Any library choice must be compatible with running under Bun (verified per step; Temporal SDK usage is confined to worker activities/workflows which run under Bun; see ADR-013 for why workflow *tests* run under Vitest/Node instead).
- Porting to plain Node remains cheap because application code avoids Bun-only APIs outside entrypoints.

## Alternatives considered

- **Node.js everywhere:** rejected; would discard the existing lockfile/runtime investment without functional gain for this workload.
- **Deno/Bun split by service:** rejected; two runtimes double CI surface for zero product benefit at MVP scale.
