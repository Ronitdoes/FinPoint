# ADR-013 — Test runner: Vitest primary, `bun test` for pure domain units

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §23 (four test layers)

## Context

Spec 01 §23 requires unit, integration, workflow, and E2E layers from Week 1 onward. The Temporal SDK's testing utilities (`TestEnvironment`, workflow interceptors) are battle-tested under Node; their behavior under Bun's test runner is unproven. The repo runs Bun (ADR-001).

## Decision

1. **Vitest** is the primary test runner for all packages/apps/services: unit, integration, and Temporal workflow tests.
2. A root Vitest workspace configuration (`vitest.config.ts` with project globs) plus the `packages/testing` skeleton are created in s-01 so later steps add tests into an existing structure rather than inventing one.
3. `bun test` is permitted only for pure domain units inside `packages/domain` (no I/O, no SDK dependencies) where speed matters and compatibility risk is zero.
4. Workflow tests use the official Temporal SDK testing environment executed by Vitest; integration/E2E suites run against Docker Compose infrastructure (s-31/s-32).

## Consequences

- One runner to configure coverage/reporting for; CI (s-33) wires a single command per layer.
- Bun-only test APIs may not be used outside allowed pure-domain tests.

## Alternatives considered

- **`bun test` everywhere:** rejected; Temporal TestEnvironment reliability under Bun is unproven — do not bet the durability layer's test suite on it.
- **Jest:** rejected; slower TS/ESM setup, no advantage over Vitest here.
