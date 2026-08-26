# @repo/db — Database Schema, Migrations & Repository Layer

The central data package providing Drizzle ORM schemas, migration runners, and typed repository modules for the AI Revenue Recovery platform.

---

## 1. Architecture & Layering

Per **Spec 02 §16** and **CONVENTIONS.md §1**, services and application controllers must **never** write raw SQL or interact with the `db` client directly. All SQL, transaction boundaries, and conditional-update concurrency guards are strictly encapsulated in `packages/db/src/repositories/`.

- `src/schema/`: Drizzle PostgreSQL schemas for financial core and recovery domain entities.
- `src/repositories/`: 23 aggregate repositories enforcing tenant scoping and guarded transitions.
- `src/client.ts`: Pooled PostgreSQL connection client and healthcheck utilities.
- `src/migrate.ts`: Advisory-locked DDL migration runner and CI check gate.

---

## 2. Transaction Boundaries

Every business operation that mutates state spans an explicit transaction boundary. Provider API calls and external network I/O are **never** executed inside a database transaction (ADR-004, CONVENTIONS §9).

| Operation | Boundary | Rationale |
|---|---|---|
| **Webhook Ingestion** | Single `INSERT`, autocommit | High-throughput entry point; duplicates caught by `(source, external_event_id)` anchor. |
| **Case Creation** | **ONE transaction** (`withTransaction`) | Atomically generates monotonic `case_number` (`pg_advisory_xact_lock`), inserts `recovery_cases` row, links `revenue_risks`, and appends initial `case_events`. |
| **AI Decision Persistence** | Single `INSERT` | Captures LLM prompt/output snapshot without locking case state. |
| **Action Execution** | Claim is its own tx; Completion is its own tx | **Claim Phase**: Conditional `UPDATE ... WHERE status IN ('PROPOSED', 'APPROVED')` locks action to `EXECUTING`.<br>**Provider Call**: Runs outside DB transaction.<br>**Completion Phase**: Conditional `UPDATE ... WHERE status = 'EXECUTING'` commits result or error. |
| **Outcome Recording** | **ONE transaction** (`withTransaction`) | Inserts `recovery_outcomes` (`ON CONFLICT (case_id) DO NOTHING`), computes `net_recovered` via generated column, records cost entries, and transitions case to `RECOVERED`. |
| **Policy Rule Update** | **ONE transaction** (`withTransaction`) | Inserts immutable snapshot in `policy_versions` and updates active rule definition in `policy_rules`. |

---

## 3. Connection Pooling & Pooler Compatibility

- **Application Pool**: Configured via `postgres.js` with `prepare: false` for full compatibility with transaction poolers (PgBouncer, Supavisor, and Neon serverless poolers).
- **Pool Sizing**: Default 10 connections per API instance.
- **Worker Sizing**: Sized according to Temporal activity concurrency using the formula:
  $$\text{pool\_size} \approx \text{concurrent\_activities} + \text{headroom}$$
- **Migrations**: Always executed over a dedicated single-connection `DIRECT_URL` (bypassing poolers to ensure session-level advisory locks and DDL run cleanly).

---

## 4. Concurrency Primitives & State Guards

- **Atomic Sequence Generation (`nextCaseNumber`)**:
  Uses PostgreSQL transaction-scoped advisory locks:
  ```sql
  SELECT pg_advisory_xact_lock(hashtext(tenant_id || ':case_seq'));
  SELECT COALESCE(MAX(case_number), 0) + 1 AS next_seq FROM recovery_cases WHERE tenant_id = :tenant_id;
  ```
  Guarantees contiguous, collision-free per-tenant case numbers under concurrent ingestion.

- **Guarded Transitions**:
  State changes on cases and actions use atomic conditional updates:
  ```sql
  UPDATE recovery_cases
  SET status = :to, status_reason = :reason, updated_at = now()
  WHERE id = :case_id AND tenant_id = :tenant_id AND status IN (:from_statuses)
  RETURNING *;
  ```
  Returns `null` on race conditions or illegal jumps, allowing caller services to throw typed domain errors without crashing with database exceptions.

- **Append-Only Tables**:
  `audit_logs`, `case_events`, `checkout_events`, `invoice_events`, `workflow_events`, `message_delivery_events`, `policy_versions`, `policy_evaluations`, and `recovery_cost_entries` expose **only** insert and select operations at both runtime and type levels.
