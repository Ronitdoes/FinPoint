# AGENTS.md — AI Revenue Recovery

Monorepo building an AI revenue-recovery platform. Work is executed as a sequence of roadmap steps; this file tells you how to execute them without re-discovering context.

## Executing a step (standard workflow)

1. Read the step file for the current step: `specs/steps/s-XX.md` — fully, before writing any code. Its `## Definition of Done` is the acceptance contract.
2. Implement **only** what that step requires. No features from later steps, no drive-by refactors.
3. Verify: run the checks listed in the step + the root commands below.
4. Finish by updating:
   - `specs/steps/progress.md` — status row, "Current position", completion log (rules are at its top)
   - `docs/TRACEABILITY.md` — confirm/append rows your step implements
   - `docs/explanation/s-XX-explanation.md` (or `s-X-explanation.md`) — **MANDATORY**: write a comprehensive explanation file for the completed step (following the structure in `docs/explanation/s-2-explanation.md` and `docs/explanation/s-3-explanation.md`)

## Which docs to read when

| Document | When |
|---|---|
| `docs/CONVENTIONS.md` | Binding on every step. Read once per session; apply throughout. |
| `docs/ARCHITECTURE.md` | Before creating directories/files or wiring components. §4 target layout, §5 gap review (which step owns what). |
| `docs/adr/ADR-*.md` | On demand only (see triggers below). Decisions there are settled — do not re-litigate in code review or implementation. |
| `specs/*.md` | Source of truth referenced by steps (`00`=vision, `01`=build plan, `02`=domain/architecture, `03`=MVP scope). Read the section a step cites, not whole files. |

ADR read triggers:

- Money/amounts/currency → ADR-009
- New table/column/id → ADR-010
- Time/durations/timers → ADR-011
- HTTP routes/plugins → ADR-002
- DB queries/migrations/pooler issues → ADR-003, ADR-004
- Events/bus/webhooks → ADR-006
- Redis usage → ADR-007
- Anything LLM-related → ADR-008
- Auth/sessions/API keys/roles → ADR-012
- Tests/test runner setup → ADR-013
- Observability/metrics/tracing/logs → ADR-014
- RLS/tenant-isolation hardening → ADR-015
- Dashboard data/pushgateway/KPI snapshot → ADR-016

## Hard rules

- Never modify anything under `specs/` except `specs/steps/progress.md`.
- No application behavior change outside the current step's scope.
- All state machines live in `packages/domain`; DB writes use guarded conditional updates (see CONVENTIONS §9).
- Secrets never enter code, logs, or git (CONVENTIONS §12).
- Commit messages use the step prefix, e.g. `s-07: ...`; branches `feat/<step-id>-<slug>`.
- An explanation document in `docs/explanation/s-XX-explanation.md` (or `s-X-explanation.md`) is mandatory for every step before marking it DONE.

## Verification commands (repo root)

```bash
bun run check-types   # must pass before finishing any step
bun run lint          # when touching packages with lint configs
bun run test          # vitest workspace; add tests per the step's Tests section
bun run check-docs    # after editing any docs/*.md links
```

## Environment notes

- Runtime is Bun ≥ 1.4 (ADR-001); Node-compatible code style outside entrypoints. Package manager: `bun install` only.
- Windows dev machines: paths in scripts are POSIX-style; run commands from repo root.
