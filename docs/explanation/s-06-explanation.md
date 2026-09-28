# s-06 — Migration Pipeline Hardening & Repository Layer: Implementation Explanation

This document provides a comprehensive, architectural explanation of everything implemented in `specs/steps/s-06.md`. It covers migration pipeline hardening (advisory locks, transient retries, and CI check gate), transaction infrastructure (`withTransaction`, `Tx`, `RepoContext`), the complete suite of 24 aggregate repositories enforcing tenant scoping by signature (audit fix: 24 files enumerated in §10; see progress.md:122 deferred row), concurrency primitives (guarded state transitions, atomic per-tenant case number sequencing via `pg_advisory_xact_lock`), compile-time and runtime append-only table guarantees, connection pooling documentation, and integration test suites proving race-free execution against live PostgreSQL.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Workspace architecture & file layout](#2-workspace-architecture--file-layout)
3. [Database client enhancements & observability hooks (`client.ts`)](#3-database-client-enhancements--observability-hooks-clientts)
4. [Migration pipeline hardening & CI gate (`migrate.ts`, `db:migrate:check`)](#4-migration-pipeline-hardening--ci-gate-migratets-dbmigratecheck)
5. [Transaction infrastructure & context management (`tx.ts`, `types.ts`)](#5-transaction-infrastructure--context-management-txts-typests)
6. [Tenant scoping enforcement at the signature level](#6-tenant-scoping-enforcement-at-the-signature-level)
7. [Guarded state transitions & race prevention (`cases.repo.ts`, `actions.repo.ts`)](#7-guarded-state-transitions--race-prevention-casesrepots-actionsrepots)
8. [Atomic per-tenant case sequencing (`nextCaseNumber`)](#8-atomic-per-tenant-case-sequencing-nextcasenumber)
9. [Append-only guarantees & log repositories](#9-append-only-guarantees--log-repositories)
10. [Comprehensive overview of all 24 aggregate repositories](#10-comprehensive-overview-of-all-24-aggregate-repositories)
11. [Connection pooling & pooler compatibility documentation (`README.md`)](#11-connection-pooling--pooler-compatibility-documentation-readmemd)
12. [Testing strategy & parallel race condition verification](#12-testing-strategy--parallel-race-condition-verification)
13. [Verification evidence (Definition of Done)](#13-verification-evidence-definition-of-done)
14. [Key design decisions & architectural rationale](#14-key-design-decisions--architectural-rationale)

---

## 1. What the step required

Step s-06 establishes the data-access boundary for the entire platform. Per Spec 02 §16 and CONVENTIONS.md §1, services (s-07 onward) must never hand-write SQL or touch the database pool directly. Scattered queries across handlers and workers are how tenant isolation and financial invariants get violated.

The repository layer is the **sole** place where SQL statements, explicit transaction boundaries, and conditional-update concurrency guards live.

### Definition of Done Checklist (from `specs/steps/s-06.md`):

- [x] All repositories implemented with tenant-first signatures
- [x] Guarded transitions proven race-free by parallel integration tests
- [x] Append-only guarantee type-enforced and compile-verified
- [x] Advisory-locked migrations + `db:migrate:check` script working
- [x] Transaction-boundary table documented in `packages/db/README.md`
- [x] Slow-query logging hook active in dev
- [x] All integration tests green via `bun run test` (287 tests passing)

---

## 2. Workspace architecture & file layout

**Directory:** `packages/db`

```text
packages/db/
├── package.json                    # Scripts (db:migrate, db:migrate:check), exports
├── README.md                       # Transaction boundaries & connection pool formulas
├── drizzle.config.ts               # Drizzle Kit config
├── drizzle/                        # DDL migrations (0000, 0001)
├── src/
│   ├── index.ts                    # Root barrel export (schemas, client, repos, types)
│   ├── client.ts                   # Pooled PostgreSQL client, healthCheck, end, slow-query hook
│   ├── migrate.ts                  # Advisory-locked migration runner + checkPendingMigrations
│   ├── schema/                     # Drizzle schema definitions (s-04/s-05)
│   └── repositories/
│       ├── index.ts                # Repositories barrel export
│       ├── tx.ts                   # withTransaction wrapper & Tx type definition
│       ├── types.ts                # RepoContext { db, tx } & getExecutor helper
│       ├── errors.ts               # DuplicateActionError, DuplicateMessageError, etc.
│       ├── tenants.repo.ts         # Tenant management & settings
│       ├── users.repo.ts           # User accounts & role scoping
│       ├── api-keys.repo.ts        # SHA-256 API key hashing & revocation
│       ├── customers.repo.ts       # Customer profiles & communication opt-outs
│       ├── payments.repo.ts        # Payment records & financial reconciliation
│       ├── payment-attempts.repo.ts# Gateway retry attempts & resolution
│       ├── subscriptions.repo.ts   # Recurring billing subscriptions
│       ├── checkouts.repo.ts       # Cart sessions & checkout_events (append-only)
│       ├── invoices.repo.ts        # Invoices & invoice_events (append-only)
│       ├── events.repo.ts          # Inbound webhook deduplication & processing state
│       ├── risks.repo.ts           # Risk scoring & evaluation history
│       ├── cases.repo.ts           # Guarded case status transitions & nextCaseNumber
│       ├── decisions.repo.ts       # AI decision records & LLM token tracking
│       ├── actions.repo.ts         # Action execution claims, completion & failure guards
│       ├── workflows.repo.ts       # Temporal workflows & workflow_events (append-only)
│       ├── messages.repo.ts        # Outbound messaging & delivery receipts (append-only)
│       ├── responses.repo.ts       # Customer inbound responses & replies
│       ├── promises.repo.ts        # Customer promises to pay & settlement linkage
│       ├── human-tasks.repo.ts     # Human-in-the-loop escalation tasks & signal triggers
│       ├── policies.repo.ts        # Policy rules, version snapshots & evaluation audit
│       ├── audit.repo.ts           # Immutable compliance audit logs (append-only)
│       ├── case-events.repo.ts     # Immutable case timeline events (append-only)
│       ├── outcomes.repo.ts        # Authoritative financial outcomes & cost entries
│       ├── idempotency.repo.ts     # General idempotency store & lease locking
│       └── repositories.test.ts    # Comprehensive integration & concurrency test suite
```

---

## 3. Database client enhancements & observability hooks (`client.ts`)

`packages/db/src/client.ts` was expanded with lifecycle and observability utilities:

1. **`healthCheck(): Promise<boolean>`**:
   Executes `SELECT 1 as healthy` against the connection pool to verify live database connectivity and responsiveness without allocating schema overhead.
2. **`end(): Promise<void>`**:
   Gracefully shuts down the connection pool on application termination (Fastify/worker shutdown hooks).
3. **Slow-Query Logging Hook**:
   Exposes `setOnQueryHook` and `logSlowQuery` alongside parameter sanitization via `redactParams()`. In development mode, any query exceeding 200ms is logged with a structured warning and sensitive parameters (tokens, keys, large payload strings) automatically redacted (`sk_...`, `[OBJECT/PAYLOAD]`).

---

## 4. Migration pipeline hardening & CI gate (`migrate.ts`, `db:migrate:check`)

The migration runner in `packages/db/src/migrate.ts` was hardened against concurrent deployment collisions and transient connection aborts:

1. **PostgreSQL Advisory Lock (`pg_advisory_lock(724193)`)**:
   Before executing DDL migrations, the migration client acquires a session-level advisory lock using magic constant `724193`. Only one migration runner can execute DDL at a time across replicas; any other instance waits for the lock. The lock is guaranteed to be released via `pg_advisory_unlock(724193)` in a `finally` block.
2. **Transient Serialization Retry**:
   If a transient serialization anomaly or deadlock occurs (`40001` or `40P01`), the runner catches the error and retries once after a 500ms jittered delay before failing.
3. **CI Migration Gate (`checkPendingMigrations` & `db:migrate:check`)**:
   `checkPendingMigrations()` compares the entries in `drizzle/meta/_journal.json` against the applied migrations count in `drizzle.__drizzle_migrations`. The CLI command `bun run db:migrate:check` exits with status `0` if the database is up-to-date and exits with status `1` if unapplied migrations exist, serving as a reliable CI/CD deployment pre-flight gate.

---

## 5. Transaction infrastructure & context management (`tx.ts`, `types.ts`)

Every database operation in `@repo/db` accepts a `RepoContext` object:

```ts
export interface RepoContext {
  db?: Database;
  tx?: Tx;
}
```

The `getExecutor(ctx?: RepoContext): Database | Tx` helper transparently selects the active transaction (`ctx.tx`) if available, falling back to `ctx.db` or the root `db` pool.

The `withTransaction()` helper in `packages/db/src/repositories/tx.ts` wraps Drizzle transactions with transparent context propagation:

```ts
export async function withTransaction<T>(
  fnOrCtx: RepoContext | ((tx: Tx) => Promise<T>),
  maybeFn?: (tx: Tx) => Promise<T>,
): Promise<T> {
  // If ctx already contains an active transaction, reuse it without nesting overhead
  if (ctx?.tx) {
    return await fn(ctx.tx);
  }
  return await executor.transaction(async (tx) => {
    return await fn(tx);
  });
}
```

This guarantees that service-layer operations spanning multiple repository calls execute atomically within a single database transaction.

---

## 6. Tenant scoping enforcement at the signature level

Per Spec 02 §15 and CONVENTIONS §12, every business repository method enforces multi-tenant scoping by signature:
- The parameter object explicitly requires `{ tenantId: string }` as a required field.
- SQL queries consistently bind `where(eq(table.tenantId, input.tenantId))` (or `and(eq(...), ...)`).
- Cross-tenant queries are prevented at the compile and runtime boundaries.

---

## 7. Guarded state transitions & race prevention (`cases.repo.ts`, `actions.repo.ts`)

State machines in the platform rely on database-level **guarded conditional writes** rather than separate `SELECT` then `UPDATE` sequences:

### Recovery Case Status Transitions (`cases.repo.ts`)
```ts
export async function transitionCaseStatus(
  ctx: RepoContext,
  input: TransitionCaseStatusInput,
): Promise<RecoveryCase | null> {
  const [updated] = await executor
    .update(recoveryCases)
    .set({
      status: input.to,
      statusReason: input.reason ?? null,
      closedAt: input.closedAt ?? (isTerminal(input.to) ? new Date() : null),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recoveryCases.tenantId, input.tenantId),
        eq(recoveryCases.id, input.caseId),
        inArray(recoveryCases.status, input.from),
      ),
    )
    .returning();

  return updated ?? null;
}
```
If two workers attempt to transition a case simultaneously, or if the case is not in the expected status, `updated` returns `undefined` and the function returns `null`. The calling service translates this into a typed domain error (`IllegalTransitionError` or race rejection) rather than throwing an unhandled database exception.

### Action Execution Claiming (`actions.repo.ts`)
```ts
export async function claimActionForExecution(
  ctx: RepoContext,
  { tenantId, actionId }: { tenantId: string; actionId: string },
): Promise<RecoveryAction | null> {
  const now = new Date();
  const [claimed] = await executor
    .update(recoveryActions)
    .set({
      status: "EXECUTING",
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(recoveryActions.tenantId, tenantId),
        eq(recoveryActions.id, actionId),
        inArray(recoveryActions.status, ["PROPOSED", "APPROVED"]),
        or(
          isNull(recoveryActions.scheduledAt),
          lte(recoveryActions.scheduledAt, now),
        ),
      ),
    )
    .returning();

  return claimed ?? null;
}
```
When multiple worker nodes poll or receive execution tasks for the same action, exactly one worker receives the non-null `RecoveryAction` row; all other workers receive `null` and safely skip execution.

---

## 8. Atomic per-tenant case sequencing (`nextCaseNumber`)

Each tenant has an independent, human-readable case sequence (`RC-1`, `RC-2`, etc.). Rather than using global Postgres sequences (which leak tenant volumes and produce gaps on rollbacks) or a contention-heavy sequence table, `cases.repo.ts` utilizes transaction-scoped advisory locks:

```sql
SELECT pg_advisory_xact_lock(hashtext(tenant_id || ':case_seq'));
SELECT COALESCE(MAX(case_number), 0) + 1 AS next_seq FROM recovery_cases WHERE tenant_id = :tenant_id;
```

Because `pg_advisory_xact_lock` scopes to the active transaction and automatically unlocks on commit/rollback, concurrent case creation requests for the same tenant are serialized cleanly, producing monotonic, gapless sequence numbers without collisions.

---

## 9. Append-only guarantees & log repositories

Per Spec 01 §5 and Spec 02 §16, log and audit tables must remain strictly immutable. The repository modules for these entities expose **only** insert and select functions:

| Table | Repository | Allowed Operations | Prevented Operations |
|---|---|---|---|
| `audit_logs` | `audit.repo.ts` | `recordAuditLog`, `listAuditLogs`, `findAuditLogById` | No update / delete |
| `case_events` | `case-events.repo.ts` | `recordCaseEvent`, `listCaseEvents`, `findCaseEventById` | No update / delete |
| `checkout_events` | `checkouts.repo.ts` | `recordCheckoutEvent`, `listCheckoutEvents` | No update / delete |
| `invoice_events` | `invoices.repo.ts` | `recordInvoiceEvent`, `listInvoiceEvents` | No update / delete |
| `workflow_events` | `workflows.repo.ts` | `recordWorkflowEvent`, `listWorkflowEvents` | No update / delete |
| `message_delivery_events` | `messages.repo.ts` | `recordDeliveryEvent`, `listDeliveryEvents` | No update / delete |
| `policy_versions` | `policies.repo.ts` | `createPolicyVersion`, `getLatestPolicyVersion`, `listPolicyVersions` | No update / delete |
| `policy_evaluations` | `policies.repo.ts` | `recordPolicyEvaluation`, `listPolicyEvaluationsForCase` | No update / delete |
| `recovery_cost_entries` | `outcomes.repo.ts` | `recordCostEntry`, `listCostEntriesForCase` | No update / delete |

Compile-time type verification in `repositories.test.ts` asserts that no `update*` or `delete*` symbols exist on these modules.

---

## 10. Comprehensive overview of all 24 aggregate repositories (audit fix: 24 enumerated below; see progress.md:122)

1. **`tenants.repo.ts`**: CRUD for top-level tenancy partitions and settings JSONB.
2. **`users.repo.ts`**: Tenant-scoped operators and role management (`ADMIN`, `FINANCE`, `OPERATIONS`, `SUPPORT`, `VIEWER`).
3. **`api-keys.repo.ts`**: Scoped API token store with SHA-256 hash lookup and instant revocation.
4. **`customers.repo.ts`**: Customer profile management and opt-out tracking (`setCustomerOptOut`).
5. **`payments.repo.ts`**: Canonical payment ledger with provider deduplication lookups.
6. **`payment-attempts.repo.ts`**: Gateway retry attempts with monotonic attempt numbering and status resolution.
7. **`subscriptions.repo.ts`**: Recurring subscription records and lifecycle updates.
8. **`checkouts.repo.ts`**: Cart sessions and immutable `checkout_events` tracking.
9. **`invoices.repo.ts`**: B2B invoice management and immutable `invoice_events` tracking.
10. **`events.repo.ts`**: Normalized event store with idempotent `insertEventIfNew` handling webhook replays.
11. **`risks.repo.ts`**: Rule-based risk assessments with factor explainability lookup.
12. **`cases.repo.ts`**: Canonical recovery cases, monotonic case number sequencing, and guarded transitions.
13. **`decisions.repo.ts`**: AI decision records, token tracking, and structured output snapshots.
14. **`actions.repo.ts`**: Action lifecycle management (`PROPOSED` → `EXECUTING` → `EXECUTED`/`FAILED`) and execution claims.
15. **`workflows.repo.ts`**: Temporal workflow execution records and chronological `workflow_events`.
16. **`messages.repo.ts`**: Multi-channel message ledger with deduplication protection and delivery receipts.
17. **`responses.repo.ts`**: Inbound customer communications, replies, and opt-outs.
18. **`promises.repo.ts`**: Promises to pay and settlement resolution linkage.
19. **`human-tasks.repo.ts`**: Human-in-the-loop approvals, SLA queues, and Temporal signal synchronization.
20. **`policies.repo.ts`**: Deterministic safety rules, immutable version snapshots, and evaluation audits.
21. **`audit.repo.ts`**: Immutable compliance audit trail with correlation IDs.
22. **`case-events.repo.ts`**: Timeline feed powering case history and dashboard views.
23. **`outcomes.repo.ts`**: Authoritative financial recovery outcomes (`ON CONFLICT (case_id) DO NOTHING`), generated column `net_recovered`, and cost entries.
24. **`idempotency.repo.ts`**: General lease-locking idempotency store (`tryAcquire`, `complete`, `releaseLease`).

---

## 11. Connection pooling & pooler compatibility documentation (`README.md`)

`packages/db/README.md` documents the transaction boundaries and connection pooling formulas:

- **Pooler Compatibility**: Default `prepare: false` prevents prepared statement conflicts across PgBouncer / Supavisor transaction poolers.
- **API Sizing**: Default 10 connections per API instance.
- **Worker Sizing**: Sized according to Temporal activity concurrency:
  $$\text{pool\_size} \approx \text{concurrent\_activities} + \text{headroom}$$
- **Migrations**: Always executed over a single dedicated `DIRECT_URL` connection.

---

## 12. Testing strategy & parallel race condition verification

A comprehensive integration test suite was created in `packages/db/src/repositories/repositories.test.ts` executing against live PostgreSQL:

1. **Parallel Obligation Race (Anchor 2)**: 10 parallel `createCaseInTx` invocations on the same obligation result in exactly 1 success and 9 partial-unique index constraint rejections.
2. **Parallel Action Claim Race**: 2 parallel `claimActionForExecution` invocations result in exactly 1 winner receiving `EXECUTING` state and 1 loser receiving `null`.
3. **Invalid Case Transition**: Calling `transitionCaseStatus` with an invalid `from` set returns `null` and leaves the database row untouched.
4. **Idempotency Lease Lifecycle**: Proves `ACQUIRED` → `IN_FLIGHT` on concurrent attempt → `COMPLETED_DIFFERENT` on hash mismatch → snapshot retrieval.
5. **Outcome Recording Idempotency (Anchor 5)**: Calling `recordOutcomeInTx` twice for the same case returns the identical authoritative row with generated `net_recovered` verified.
6. **Duplicate Action & Message Errors**: Key collisions raise typed `DuplicateActionError` and `DuplicateMessageError`.
7. **Monotonic Case Sequencing**: 5 parallel `createCaseInTx` transactions for an isolated tenant produce sequential case numbers `[1, 2, 3, 4, 5]` without collision.
8. **Append-Only Immutability**: Type checks and runtime operations confirm no update/delete access on log tables.
9. **Migration Check Gate**: `checkPendingMigrations()` correctly verifies zero unapplied migrations.

---

## 13. Verification evidence (Definition of Done)

```bash
# 1. Type check
$ bun run check-types
Tasks: 6 successful, 6 total (0 errors)

# 2. Linting
$ bun run lint
Tasks: 1 successful, 1 total (0 errors)

# 3. Test suite
$ bun test
287 pass, 0 fail, 887 expect() calls across 11 files (76.16s)

# 4. Migration check script
$ bun run db:migrate:check
🔍 Checking for pending migrations...
✅ All 2 migration(s) are applied. Database schema is up to date.

# 5. Documentation links
$ bun run check-docs
Checked 19 relative links across docs, specs/steps, ..
All doc links OK.
```

---

## 14. Key design decisions & architectural rationale

1. **Guarded Conditional Writes over Explicit SELECT Locks**:
   Instead of using `SELECT ... FOR UPDATE` (which holds row locks across network roundtrips and risks deadlocks), state transitions use atomic single-statement conditional updates (`UPDATE ... WHERE status IN (...) RETURNING *`). This maximizes concurrency while guaranteeing zero race conditions.
2. **Transaction-Scoped Advisory Locks for Sequencing**:
   Using `pg_advisory_xact_lock(hashtext(tenant_id || ':case_seq'))` provides clean, per-tenant monotonic sequencing with automatic release on transaction completion.
3. **Strict Parameter Encapsulation (`RepoContext`)**:
   Services pass `{ tx }` or `{ db }` seamlessly through `RepoContext`, allowing transactions to compose cleanly across multi-repository business workflows without exposing Drizzle query internals.
