# s-35 — Final Hardening, Demo Readiness & Release: Implementation Explanation

This document explains, in complete depth, everything done to implement
`specs/steps/s-35.md` — the v0.1.0 release gate. It is written so a developer
(or future agent) who was not present can understand every file, every decision,
every deviation, and every problem debugged along the way. It closes the
`s-XX-explanation.md` series (s-02…s-35; s-01 has no explainer by convention).

Release record: [`../RELEASE-v0.1.0.md`](../RELEASE-v0.1.0.md) ·
Demo runbook: [`../demo-script.md`](../demo-script.md) ·
Changelog: [`../../CHANGELOG.md`](../../CHANGELOG.md)

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Coverage re-audit method](#2-coverage-re-audit-method)
3. [Quality sweep: TODO burn-down + boundary audit gate](#3-quality-sweep-todo-burn-down--boundary-audit-gate)
4. [Fix-now F1: seed reset on lived-in tenants (migration 0010)](#4-fix-now-f1-seed-reset-on-lived-in-tenants-migration-0010)
5. [Fix-now F3: backend/unified image build (`loader-utils`)](#5-fix-now-f3-backendunified-image-build-loader-utils)
6. [Security sweep triage (2 hits allowlisted)](#6-security-sweep-triage-2-hits-allowlisted)
7. [Frontend bundle budget proof](#7-frontend-bundle-budget-proof)
8. [Demo rehearsal: 3 live cycles + measured script](#8-demo-rehearsal-3-live-cycles--measured-script)
9. [The L1 seam: live Temporal execution not wired (deferred)](#9-the-l1-seam-live-temporal-execution-not-wired-deferred)
10. [Release mechanics + sign-off artifact](#10-release-mechanics--sign-off-artifact)
11. [README + TRACEABILITY + ADR index finalization](#11-readme--traceability--adr-index-finalization)
12. [Problems discovered during verification and their fixes](#12-problems-discovered-during-verification-and-their-fixes)
13. [Verification evidence (Definition of Done)](#13-verification-evidence-definition-of-done)
14. [Deviations and judgment calls](#14-deviations-and-judgment-calls)

---

## 1. What the step required

Step s-35 converts “features exist” into “demonstrable, auditable, signed off”
and freezes v0.1.0. Six requirements:

1. **Coverage re-audit**: regenerate TRACEABILITY from code/tests; every row
   evidenced or explicitly deferred (ML/voice/multi-agent/experimentation → Phase 2+).
2. **Quality sweep**: zero bare TODO/FIXME; boundary lint audit (no AI→adapter
   paths, no creds outside integrations, no raw SQL outside repos); `strict`
   green incl. frontend; frontend initial-route JS < 300KB gz.
3. **Documentation finalization**: root README rewrite (quickstart ≤10
   commands), docs index, ADR index.
4. **Demo readiness**: finalized `docs/demo-script.md` (exact commands/clicks/
   timings/expected numbers for 9 scenes), 3 dry-runs by a non-builder with
   friction log resolved, fallback plan for no-LLM demos.
5. **Release mechanics**: v0.1.0 tags, changelog, image promotion, prod deploy
   via pipeline, post-deploy smoke + alert-silence check.
6. **Sign-off artifact**: `docs/RELEASE-v0.1.0.md` (§29 + §12 checklists,
   known limitations, deferral register).

The step’s own DoD is the release gate (six boxes). Its fine print matters:
“gaps become either fix-now items or **documented deferrals**”, “any API change
discovered now goes through a **patch step** — freeze discipline stated”, and
the DoD itself demands a published deferral register — i.e. DONE-with-deferrals
is a designed terminal state, not a failure mode. That distinction drives
several decisions below (L1/L2).

Prerequisites (s-01…s-34 DONE) held: `specs/steps/progress.md` showed 34/35
complete, G1–G6 ticked, only G7 (Shipped) open.

---

## 2. Coverage re-audit method

Rather than re-asserting the matrix from memory, every TRACEABILITY section was
re-verified against executable evidence on 2026-09-10:

- §1 MVP matrix: 16/16 Yes rows confirmed shipped (imports/routes/tests exist
  per prior steps); 4 deferral rows unchanged with spec-00-§10 pointers.
- §2 DoD-18: each item mapped to its proving step **plus** fresh evidence —
  15 items re-proven live during rehearsal (webhook ACCEPT, 60/HIGH risk,
  single case, FALLBACK badge, ALLOWED verdict, SUCCEEDED payment, outcome
  row, dashboard delta, audit spine) and 3 items (DOD-10/11/12) marked
  L1-bounded (workflow row + service-level proofs live; Temporal task
  execution deferred — §9).
- §3 acceptance: `bun run test:e2e:coverage` → 18/18 §29 markers + 7/7 §8 blocks.
- §4 switches, §5 metrics: confirmed via s-31/s-34 artifacts (no code change).
- New §8 appended to TRACEABILITY.md recording the re-audit table itself.

---

## 3. Quality sweep: TODO burn-down + boundary audit gate

**TODO burn-down**: `grep TODO|FIXME|HACK|XXX` across apps/packages/services/
scripts → **zero hits**. Nothing to link; the gate below enforces this
permanently.

**New gate: `scripts/audit-boundaries.ts`** (`bun run boundaries:audit`,
registered in root `package.json`, exit 0 pass / 1 fail). Six rules over
git-tracked sources (528 files; tests excluded from rules 1–3 since fixtures
intentionally cross boundaries):

1. `ai-boundary` (ERROR): `modules/ai/**` importing adapters/SDKs,
   Temporal dispatch (`workflow.start`, `getHandle`), or direct-send methods.
   Result: **0 hits** — the AI module’s only “actions” are catalog *data*.
2. `cred-confine` (ERROR): provider credential reads outside
   `packages/config` + `packages/integrations`. Result: **0 hits** — creds
   live only in the typed loader and adapters. Webhook *verification* secrets
   at the gateway + demo loopback signer are INFO-vetted by path allowlist
   (CONVENTIONS §12 design, not leaks).
3. `sql-confine` (ERROR): raw SQL execution outside `packages/db`.
   Result: **0 hits**.
4. `todo-link` (ERROR): bare markers without `(#nn)` or `s-nn` pointer.
   Result: **0 hits**.
5. `workflow-determinism` (WARN): `Date.now()`/`Math.random()` in non-test
   workflow code → exactly the 3 known `invoice-overdue.ts` fallback lines
   (L4).
6. `env-confine` (WARN): `process.env` outside config → 35 grandfathered
   bootstrap/edge reads inventoried (L3); vetted CLI/edge files are INFO.

Final: **0 ERROR, 38 WARN, 30 INFO — PASS**. WARNs are tracked tech debt,
none blocking, all pointed at in RELEASE L3/L4.

---

## 4. Fix-now F1: seed reset on lived-in tenants (migration 0010)

**Symptom** (first cold-reset attempt): `bun run db:seed --reset` aborted with
`ai_decisions_case_id…_fk` RESTRICT violation — `reset.ts` never deleted
`ai_decisions`. After adding that delete, the **immutability trigger**
(`prevent_audit_modification`, migration 0007) aborted the run: it bans ALL
`DELETE` on `audit_logs`/`case_events`/`audit_archive`, and `case_events`
cascades from `recovery_cases`. No delete ordering can fix that — the trigger
has no escape hatch. Net: reset worked on pristine seeds but failed on any
tenant where real journeys ran (decisions + timeline rows exist) — which is
exactly when a demo operator needs reset most.

**Fix** (two parts, both additive, freeze-safe):

- `packages/db/drizzle/0010_audit_reset_hatch.sql` (+ journal idx 10): the
  trigger function now returns `OLD` (allow) when transaction-local
  `app.allow_audit_delete = 'on'`; otherwise identical default-deny.
  Application roles still lack UPDATE/DELETE grants; no production code sets
  the flag.
- `packages/db/src/seeds/reset.ts`: full reverse-FK ordering (delivery
  events → messages → responses → case_events → audit_logs → audit_archive →
  evaluations → costs → outcomes → tasks → PTPs → actions → **decisions** →
  workflow_events → workflows → cases → risks → invoice/checkout/payment core →
  events → customers), wrapped in **one transaction** opening with
  `SET LOCAL app.allow_audit_delete = 'on'`. Explicit deletes everywhere so
  the reset never depends on cascade-into-immutable-table behavior.
  Tenants/users/sessions/keys/policy-config deliberately untouched.

**Regression**: `packages/db/src/seeds/reset.test.ts` (2 live-DB tests) —
reset after decisions + append-only rows succeeds and empties all 7 tables
while preserving tenant+customer shells; direct `DELETE` on `audit_logs`
outside reset still raises (default-deny proven). Both green; cold
reset+seed verified ×2 end-to-end (identical determinism hash).

---

## 5. Fix-now F3: backend/unified image build (`loader-utils`)

**Symptom**: `docker … build worker` (and local `bun run --cwd apps/backend
build`) failed resolving `loader-utils` from `swc-loader`. Root-cause chain:
backend imports `@repo/worker` **root** (`infra-sampler.ts` dynamic import for
`getTemporalClient`) → root index re-exports `./registry` + `./worker` →
`@temporalio/worker` → webpack + `swc-loader` → unresolvable webpack peer.
Pre-existing (reproduces without s-35 changes; the worker image, being opt-in,
had likely never been built on this machine).

**Fix** (one line, behavior-identical): `infra-sampler.ts` now imports
`@repo/worker/client` (existing subpath export; `getTemporalClient` lives in
`client.ts`, which needs only `@temporalio/client`). Verified: local
`bun build` bundles 1670 modules clean; `worker` image builds; `deploy:check`
PASS. No Dockerfile changes → twin-sync untouched.

---

## 6. Security sweep triage (2 hits allowlisted)

`s
...[truncated 8184 chars]