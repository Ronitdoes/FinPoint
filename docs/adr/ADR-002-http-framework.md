# ADR-002 — HTTP framework: Fastify 5 on the Bun runtime

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §3, §7; `specs/02-architecture-and-domain.md` §13

## Context

Spec 01 §3 mandates Fastify as the backend HTTP framework. The current `apps/backend/src/index.ts` is a raw `Bun.serve` stub with hand-rolled routing. The system needs schema validation, hooks, lifecycle management, structured error mapping, rate limiting, and plugin encapsulation for webhook ingestion (spec 01 §7) and the internal API surface (spec 02 §13).

## Decision

1. Fastify v5 is the HTTP framework for `apps/backend`.
2. The raw `Bun.serve` stub in `apps/backend/src/index.ts` is replaced in step s-07 by:
   - `src/app.ts` — Fastify factory + plugin registration (buildable in tests without listening), and
   - `src/server.ts` — listen + graceful shutdown (replaces `index.ts`).
3. Fastify plugins carry cross-cutting concerns: JSON Schema validation, hooks, lifecycle, error handler mapping domain errors to HTTP status (see `docs/CONVENTIONS.md`), authn/RBAC/rate-limit/audit/otel plugins (implemented s-07…s-09).
4. Route modules follow the module layout in `docs/CONVENTIONS.md` (`*.controller.ts` / `*.service.ts` / `*.types.ts`).

## Consequences

- Request/response validation is declared once per route via JSON Schema and reused for docs/tests.
- Plugin encapsulation (`register` scoping) gives per-module dependency isolation.
- Fastify runs under Bun (ADR-001) using its Node-compatible server adapter; no Bun-only request APIs may be used inside controllers.

## Alternatives considered

- **Keep raw `Bun.serve`:** rejected; no schema validation, hook, or ecosystem story; every cross-cutting concern becomes bespoke middleware.
- **Express/NestJS:** rejected; Express lacks first-class schema validation, Nest adds heavy DI ceremony not warranted for an MVP gateway.
