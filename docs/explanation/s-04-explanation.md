# s-04 — Database Schema: Financial Core Entities: Implementation Explanation

This document explains, in complete depth, everything implemented in `specs/steps/s-04.md`. It is written so that any developer or agent can understand every schema definition, table layout, PostgreSQL enum binding, foreign key constraint, index strategy, unique deduplication anchor, migration pipeline, and test suite in `@repo/db`.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Workspace architecture & schema layout](#2-workspace-architecture--schema-layout)
3. [Shared schema utilities & column helpers (`_shared.ts`)](#3-shared-schema-utilities--column-helpers-_sharedts)
4. [PostgreSQL enum bindings & domain parity (`enums.ts`)](#4-postgresql-enum-bindings--domain-parity-enumsts)
5. [Tenancy & administrative entities (`tenants.ts`, `users.ts`)](#5-tenancy--administrative-entities-tenantsts-usersts)
6. [Customer profile & opt-out tracking (`customers.ts`)](#6-customer-profile--opt-out-tracking-customersts)
7. [Payments & gateway attempts (`payments.ts`)](#7-payments--gateway-attempts-paymentsts)
8. [Recurring subscriptions (`subscriptions.ts`)](#8-recurring-subscriptions-subscriptionsts)
9. [Checkout sessions & append-only events (`checkouts.ts`)](#9-checkout-sessions--append-only-events-checkoutsts)
10. [Invoices & append-only events (`invoices.ts`)](#10-invoices--append-only-events-invoicests)
11. [Migration pipeline & DDL execution (`drizzle/`, `migrate.ts`)](#11-migration-pipeline--ddl-execution-drizzle-migratets)
12. [Testing strategy & constraint verification](#12-testing-strategy--constraint-verification)
13. [Verification evidence (Definition of Done)](#13-verification-evidence-definition-of-done)
14. [Design decisions & judgment calls](#14-design-decisions--judgment-calls)

---

## 1. What the step required

Step s-04 implements the canonical relational persistence layer for the platform's core financial and operational entities using **Drizzle ORM** on PostgreSQL.

Per Spec 01 §5 and Spec 02 §1, PostgreSQL is the single source of truth for all business and financial records. The financial core represents the source data upon which revenue recovery operates (payments, payment attempts, subscriptions, checkouts, and invoices). This step also introduces the tenant boundary (`tenants`), authentication operators (`users`, `api_keys`), and audit infrastructure (`created_at`, `updated_at`).

### Definition of Done Checklist (from `specs/steps/s-04.md`):

- All 11 tables exist with exact columns, constraints, unique keys, and spec-mandated indexes
- `bun run db:generate` produces a clean SQL migration; `bun run db:migrate` applies it to PostgreSQL
- Enum parity tests green against `@repo/domain`
- Database constraint violation tests green against live PostgreSQL
- `db:studio` displays schemas and relations properly
- Schema reviewed against Spec 03 §4 field lists (superset allowed, no contradictions)

---

## 2. Workspace architecture & schema layout

**Directory:** `packages/db`

```text
packages/db/
├── drizzle/
│   ├── meta/
│   │   └── _journal.json            # Drizzle Kit migration journal
│   └── 0000_curly_james_howlett.sql # Generated DDL migration (with citext extension)
├── drizzle.config.ts                # Drizzle Kit configuration (multi-path .env resolution)
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                     # Package entrypoint (re-exports schema, client, migrate)
    ├── client.ts                    # Pooled postgres.js client (prepare: false)
    ├── migrate.ts                   # Direct unpooled DDL migration runner
    └── schema/
        ├── index.ts                 # Barrel export for all tables, enums, and helpers
        ├── _shared.ts               # Audit timestamps, money columns, citext type, payload interfaces
        ├── enums.ts                 # Drizzle pgEnum definitions mirroring @repo/domain
        ├── tenants.ts               # Tenancy root entity
        ├── users.ts                 # User operators & hashed API keys
        ├── customers.ts             # Customer profiles with opt-out & soft delete
        ├── payments.ts              # Payments & payment_attempts
        ├── subscriptions.ts         # Recurring subscription states
        ├── checkouts.ts             # Checkouts & checkout_events (append-only)
        ├── invoices.ts              # Invoices & invoice_events (append-only)
        ├── enum-parity.test.ts      # 11 unit tests ensuring 100% DB enum parity with @repo/domain
        └── constraints.test.ts      # 11 integration tests verifying DB checks, FKs, and indexes
```

---

## 3. Shared schema utilities & column helpers (`_shared.ts`)

To enforce consistent auditability, money representation, and text normalization across all tables, `_shared.ts` exports reusable column bundles:

### 3.1 PostgreSQL `citext` Custom Type
```typescript
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});
```
Provides case-insensitive email matching at the database layer (e.g. `User@Example.com` matches `user@example.com` without lowercase transformations).

### 3.2 Audit Timestamps Helper
```typescript
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};
```
Guarantees every business table maintains UTC `timestamptz` records with Drizzle `$onUpdate` support for optimistic concurrency guards.

### 3.3 ADR-009 Money Column Helper
```typescript
export const moneyColumns = {
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
};
```

---

## 4. PostgreSQL enum bindings & domain parity (`enums.ts`)

PostgreSQL `pgEnum` objects are defined directly from the frozen string arrays exported by `@repo/domain`:

| PostgreSQL Enum | Values | Domain Source |
|---|---|---|
| `tenant_status` | `ACTIVE`, `SUSPENDED` | `TENANT_STATUSES` |
| `user_role` | `ADMIN`, `FINANCE`, `OPERATIONS`, `SUPPORT`, `VIEWER` | `USER_ROLES` |
| `user_status` | `ACTIVE`, `DISABLED` | `USER_STATUSES` |
| `customer_status` | `ACTIVE`, `CHURNED`, `BLOCKED` | `CUSTOMER_STATUSES` |
| `payment_status` | `CREATED`, `PENDING`, `FAILED`, `SUCCEEDED`, `REFUNDED`, `DISPUTED` | `PAYMENT_STATUSES` |
| `provider` | `STRIPE`, `RAZORPAY`, `MOCK` | `PROVIDERS` |
| `payment_attempt_initiated_by` | `PROVIDER_AUTO`, `RECOVERY_WORKFLOW`, `MANUAL` | `PAYMENT_ATTEMPT_INITIATED_BY` |
| `payment_attempt_status` | `REQUESTED`, `SUCCEEDED`, `FAILED`, `UNKNOWN` | `PAYMENT_ATTEMPT_STATUSES` |
| `subscription_status` | `ACTIVE`, `PAST_DUE`, `PAUSED`, `CANCELLED`, `INCOMPLETE` | `SUBSCRIPTION_STATUSES` |
| `checkout_status` | `STARTED`, `PAYMENT_STARTED`, `COMPLETED`, `ABANDONED`, `EXPIRED` | `CHECKOUT_STATUSES` |
| `invoice_status` | `DRAFT`, `SENT`, `DUE`, `OVERDUE`, `PAID`, `DISPUTED`, `CANCELLED` | `INVOICE_STATUSES` |

Parity is enforced by unit tests in `enum-parity.test.ts` (fails CI if any enum drifts).

---

## 5. Tenancy & administrative entities (`tenants.ts`, `users.ts`)

### 5.1 `tenants` Table
The tenancy root boundary (Spec 02 §15). Every business table holds a non-nullable foreign key to `tenants.id`.
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `name`: `TEXT NOT NULL`
- `slug`: `TEXT NOT NULL UNIQUE`
- `status`: `tenant_status NOT NULL DEFAULT 'ACTIVE'`
- `settings`: `JSONB NOT NULL DEFAULT '{}'` (attribution window hours, timezone, contact preference defaults)
- `created_at`, `updated_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`

### 5.2 `users` Table
Dashboard operators and administrative users.
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `email`: `CITEXT NOT NULL`
- `name`: `TEXT NOT NULL`
- `role`: `user_role NOT NULL`
- `password_hash`: `TEXT NULL` (argon2id hash, s-09)
- `status`: `user_status NOT NULL DEFAULT 'ACTIVE'`
- `last_login_at`: `TIMESTAMPTZ NULL`
- **Constraints / Indexes:** UNIQUE `(tenant_id, email)`, INDEX `tenant_id`

### 5.3 `api_keys` Table
Programmatic API credentials for webhook ingestion and integrations.
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `name`: `TEXT NOT NULL`
- `key_hash`: `TEXT NOT NULL UNIQUE` (SHA-256 hash; raw secret shown only once upon creation)
- `scopes`: `TEXT[] NOT NULL DEFAULT '{events:write}'`
- `revoked_at`, `last_used_at`: `TIMESTAMPTZ NULL`
- `created_by`: `UUID FK→users(id) ON DELETE SET NULL`
- **Indexes:** INDEX `tenant_id`

---

## 6. Customer profile & opt-out tracking (`customers.ts`)

Canonical customer directory record across billing providers.
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `external_ref`: `TEXT NULL` (provider customer ID, e.g. `cus_xxx`)
- `name`: `TEXT NOT NULL`, `email`: `CITEXT NULL`, `phone`: `TEXT NULL`
- `status`: `customer_status NOT NULL DEFAULT 'ACTIVE'`
- `lifetime_value`: `BIGINT NOT NULL DEFAULT 0` (minor units)
- `opted_out`: `BOOLEAN NOT NULL DEFAULT false`, `opted_out_at`: `TIMESTAMPTZ NULL` (enforces hard policy: no outbound after opt-out)
- `metadata`: `JSONB NOT NULL DEFAULT '{}'`
- `deleted_at`: `TIMESTAMPTZ NULL` (soft delete; financial tables never cascade delete)
- **Constraints / Indexes:**
  - Partial Unique Index `(tenant_id, external_ref)` WHERE `external_ref IS NOT NULL`
  - INDEX `(tenant_id, email)`
  - INDEX `(tenant_id, phone)`
  - INDEX `tenant_id`

---

## 7. Payments & gateway attempts (`payments.ts`)

### 7.1 `payments` Table
Authoritative payment attempt root (Spec 01 §5, Spec 02 §1).
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `customer_id`: `UUID FK→customers(id) ON DELETE RESTRICT NOT NULL`
- `subscription_id`: `UUID FK→subscriptions(id) ON DELETE RESTRICT NULL`
- `amount`: `BIGINT NOT NULL`, `currency`: `CHAR(3) NOT NULL`
- `status`: `payment_status NOT NULL DEFAULT 'CREATED'`
- `provider`: `provider NOT NULL` (`STRIPE`, `RAZORPAY`, `MOCK`)
- `provider_payment_id`: `TEXT NOT NULL`
- `failure_code`, `failure_message`: `TEXT NULL`
- `method_metadata`: `JSONB NOT NULL DEFAULT '{}'` (card network, last4 only — never PAN)
- `occurred_at`: `TIMESTAMPTZ NOT NULL`, `paid_at`, `refunded_at`, `disputed_at`: `TIMESTAMPTZ NULL`
- **Constraints & Indexes:**
  - CHECK `amount > 0` (`payments_amount_positive_check`)
  - UNIQUE `(tenant_id, provider, provider_payment_id)` (webhook deduplication anchor)
  - INDEX `(customer_id, created_at)`
  - INDEX `(status, created_at)`
  - INDEX `(tenant_id, occurred_at)`
  - INDEX `tenant_id`

### 7.2 `payment_attempts` Table
Individual gateway retry records.
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `payment_id`: `UUID FK→payments(id) ON DELETE RESTRICT NOT NULL`
- `attempt_number`: `INT NOT NULL`
- `initiated_by`: `payment_attempt_initiated_by NOT NULL`
- `idempotency_key`: `TEXT NOT NULL UNIQUE` (format `{tenant_id}:{case_id}:RETRY_PAYMENT:{attempt}`)
- `status`: `payment_attempt_status NOT NULL`
- `provider_reference`, `failure_code`: `TEXT NULL`, `error`: `JSONB NULL`
- `requested_at`: `TIMESTAMPTZ NOT NULL`, `resolved_at`: `TIMESTAMPTZ NULL`
- **Constraints & Indexes:**
  - UNIQUE `(payment_id, attempt_number)`
  - UNIQUE `idempotency_key`
  - INDEX `tenant_id`

---

## 8. Recurring subscriptions (`subscriptions.ts`)

Subscriptions table anchoring renewal failures and recurring recovery workflows.
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `customer_id`: `UUID FK→customers(id) ON DELETE RESTRICT NOT NULL`
- `plan_name`: `TEXT NULL`
- `amount`: `BIGINT NOT NULL`, `currency`: `CHAR(3) NOT NULL`
- `status`: `subscription_status NOT NULL DEFAULT 'ACTIVE'`
- `provider`: `provider NOT NULL`, `provider_subscription_id`: `TEXT NOT NULL`
- `current_period_start`, `current_period_end`, `cancelled_at`: `TIMESTAMPTZ NULL`
- **Constraints & Indexes:**
  - UNIQUE `(tenant_id, provider, provider_subscription_id)`
  - INDEX `(customer_id, status)`
  - INDEX `tenant_id`

---

## 9. Checkout sessions & append-only events (`checkouts.ts`)

### 9.1 `checkouts` Table
E-commerce checkout sessions driving Workflow B (abandonment recovery).
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `customer_id`: `UUID FK→customers(id) ON DELETE RESTRICT NOT NULL`
- `cart_value`: `BIGINT NOT NULL DEFAULT 0`, `currency`: `CHAR(3) NOT NULL`
- `items`: `JSONB NOT NULL DEFAULT '[]'` (sku, name, quantity, unit_amount_minor)
- `status`: `checkout_status NOT NULL DEFAULT 'STARTED'`
- `source_ref`: `TEXT NULL` (Shopify cart token / Stripe Checkout session ID)
- `started_at`, `last_activity_at`: `TIMESTAMPTZ NOT NULL`
- `completed_at`, `abandoned_at`, `expires_at`: `TIMESTAMPTZ NULL`
- **Constraints & Indexes:**
  - Partial Unique Index `(tenant_id, source_ref)` WHERE `source_ref IS NOT NULL`
  - INDEX `(status, last_activity_at)`
  - INDEX `(tenant_id, customer_id, status)`
  - INDEX `tenant_id`

### 9.2 `checkout_events` Table (Append-Only)
- `id`: `BIGSERIAL PK` (monotonic ordering ADR-010)
- `checkout_id`: `UUID FK→checkouts(id) ON DELETE CASCADE NOT NULL`
- `type`: `TEXT NOT NULL` (e.g. `checkout.started`, `item_added`, `payment_started`, `completed`, `abandoned`)
- `payload`: `JSONB NOT NULL DEFAULT '{}'`
- `occurred_at`: `TIMESTAMPTZ NOT NULL`, `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes:** INDEX `(checkout_id, occurred_at)`

---

## 10. Invoices & append-only events (`invoices.ts`)

### 10.1 `invoices` Table
B2B & recurring invoices driving Workflow C (overdue recovery & promise-to-pay).
- `id`: `UUID PK DEFAULT gen_random_uuid()`
- `tenant_id`: `UUID FK→tenants(id) ON DELETE RESTRICT NOT NULL`
- `customer_id`: `UUID FK→customers(id) ON DELETE RESTRICT NOT NULL`
- `number`: `TEXT NOT NULL`
- `amount`: `BIGINT NOT NULL`, `amount_paid`: `BIGINT NOT NULL DEFAULT 0`, `currency`: `CHAR(3) NOT NULL`
- `status`: `invoice_status NOT NULL DEFAULT 'DRAFT'`
- `issued_at`: `TIMESTAMPTZ NULL`, `due_at`: `TIMESTAMPTZ NOT NULL`, `paid_at`, `disputed_at`: `TIMESTAMPTZ NULL`
- `provider`: `provider NULL`, `provider_invoice_id`: `TEXT NULL`
- **Constraints & Indexes:**
  - UNIQUE `(tenant_id, number)`
  - Partial Unique Index `(tenant_id, provider, provider_invoice_id)` WHERE `provider_invoice_id IS NOT NULL`
  - INDEX `(status, due_at)`
  - INDEX `(tenant_id, customer_id, status)`
  - INDEX `tenant_id`

### 10.2 `invoice_events` Table (Append-Only)
- `id`: `BIGSERIAL PK` (monotonic ordering ADR-010)
- `invoice_id`: `UUID FK→invoices(id) ON DELETE CASCADE NOT NULL`
- `type`: `TEXT NOT NULL`, `payload`: `JSONB NOT NULL DEFAULT '{}'`
- `occurred_at`: `TIMESTAMPTZ NOT NULL`, `created_at`: `TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Indexes:** INDEX `(invoice_id, occurred_at)`

---

## 11. Migration pipeline & DDL execution (`drizzle/`, `migrate.ts`)

Migrations follow **ADR-004** forward-only principles:
1. `drizzle.config.ts` points to `./src/schema/index.ts` and outputs SQL files to `./drizzle/`.
2. `bun run db:generate` compiles schema differences into immutable `.sql` migrations with `_journal.json`.
3. `CREATE EXTENSION IF NOT EXISTS "citext";` is executed at the top of the migration to ensure case-insensitive text support.
4. `migrate.ts` connects via `DIRECT_URL` with a single unpooled connection (`max: 1`) to execute migrations safely without transaction pooler interference.
5. Migration application is completely idempotent — re-running `bun run db:migrate` succeeds with zero errors.

---

## 12. Testing strategy & constraint verification

Testing is divided into pure TypeScript unit tests and live PostgreSQL integration tests:

| Test File | Test Count | Scope |
|---|---|---|
| `packages/db/src/schema/enum-parity.test.ts` | 11 | Asserts 100% equivalence between every Drizzle `pgEnum` and `@repo/domain` string array |
| `packages/db/src/schema/constraints.test.ts` | 11 | Integration tests against live PostgreSQL: duplicate webhook rejection, CHECK constraint `amount > 0`, FK cascade deletion, user/tenant uniqueness, idempotency uniqueness, customer soft delete, and `pg_indexes` presence verification |
| `packages/domain/src/enums/enums.test.ts` | 10 | Snapshot and drift guards for domain enums |
| Existing domain/config suites | 193 | Limits, money, envelopes, state machines, catalog, config |
| **Total Test Suite** | **225 tests** | **100% passing across the workspace** |

---

## 13. Verification evidence (Definition of Done)

```bash
bun run check-types   # 6/6 workspace packages pass cleanly (TypeScript 5.9 strict)
bun run lint          # ESLint passes with zero warnings
bun run test          # 225 unit & DB integration tests pass in ~12s
bun run check-docs    # 19 relative markdown links verified
bun run db:migrate    # Applied cleanly and idempotently to PostgreSQL
```

---

## 14. Design decisions & judgment calls

1. **Foreign Key Deletion Discipline:**
   All core business records (`payments`, `payment_attempts`, `subscriptions`, `checkouts`, `invoices`, `customers`, `users`) use `ON DELETE RESTRICT`. Financial history must never be silently or cascaded-deleted. Child event log tables (`checkout_events`, `invoice_events`) use `ON DELETE CASCADE` because they are strictly subsidiary timeline records of their parent entity.
2. **Partial Unique Indexes for Nullable External References:**
   Columns like `customers.external_ref`, `checkouts.source_ref`, and `invoices.provider_invoice_id` are nullable (for internal/pre-gateway entities). We used partial unique indexes with `WHERE column IS NOT NULL` so multiple rows with `NULL` external references do not conflict with each other while maintaining strict tenant-scoped uniqueness for non-null provider IDs.
3. **Database-Level CHECK Constraints for Money Invariants:**
   `payments.amount > 0` is enforced via a PostgreSQL check constraint (`payments_amount_positive_check`), guaranteeing that negative or zero payments are rejected before application logic even touches them.
4. **Case-Insensitive Emails via `citext`:**
   Using Postgres `citext` ensures that queries and unique constraints on customer and user emails are naturally case-insensitive without requiring error-prone manual `LOWER()` calls in repository queries.
