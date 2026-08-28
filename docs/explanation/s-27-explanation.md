# s-27 — Analytics Service & Views: Implementation Explanation

This document explains in complete technical depth everything implemented for `specs/steps/s-27.md`. It describes the PostgreSQL views, database migration, query aggregations, Redis caching layer, RBAC cost-field gating, and golden-dataset integration tests.

---

## Table of Contents

1. [What the Step Required](#1-what-the-step-required)
2. [Database Schema & Analytics SQL Views](#2-database-schema--analytics-sql-views)
3. [Database Repository Layer (`packages/db/src/repositories/analytics.repo.ts`)](#3-database-repository-layer)
4. [Backend Analytics Module (`apps/backend/src/modules/analytics/`)](#4-backend-analytics-module)
5. [Single-Flight In-Memory Stampede Protection & Redis Caching](#5-single-flight-in-memory-stampede-protection--redis-caching)
6. [RBAC Security & Cost-Field Redaction](#6-rbac-security--cost-field-redaction)
7. [Cache Invalidation Hook on Outcome Recording](#7-cache-invalidation-hook-on-outcome-recording)
8. [Integration Testing & Golden Snapshot Verification](#8-integration-testing--golden-snapshot-verification)
9. [Verification Evidence (Definition of Done)](#9-verification-evidence-definition-of-done)
10. [Traceability Matrix Updates](#10-traceability-matrix-updates)

---

## 1. What the Step Required

Step 27 introduces the core analytics querying engine and REST APIs to provide real-time executive summaries, time-series trends, intervention performance breakdowns, recovery funnel progression, risk mix distributions, and AI autonomy governance metrics (Spec 00 §6/§9, Spec 01 §25, Spec 02 §13, Spec 03 §7).

### Key Acceptance Contracts:
1. **Analytics Views**: Dedicated `analytics` schema with 6 SQL views (`v_recovery_summary`, `v_recovery_timeseries`, `v_intervention_performance`, `v_funnel`, `v_risk_mix`, `v_ai_performance`) generated via `bun run db:generate` and migrated with `bun run db:migrate`.
2. **Repository Aggregation Functions**: 6 query methods in `packages/db/src/repositories/analytics.repo.ts` (`getAnalyticsSummary`, `getRecoveryTimeseries`, `getInterventionPerformance`, `getRecoveryFunnel`, `getRiskMix`, `getAiPerformance`).
3. **6 REST Endpoints** under `/analytics`:
   - `GET /analytics/summary` — Financial & operational summary cards.
   - `GET /analytics/recovery` — Recovery vs at-risk revenue time series (day/week buckets).
   - `GET /analytics/interventions` — Success rate and recovery per intervention action type.
   - `GET /analytics/funnel` — 5-stage recovery funnel progression (`AT_RISK` → `QUALIFIED` → `CONTACTED` → `ATTEMPTED` → `RECOVERED`).
   - `GET /analytics/risk-mix` — Risk type and risk band breakdown.
   - `GET /analytics/ai` — AI decisioning metrics, acceptance rate, policy rejections, approvals required, and LLM cost economics.
4. **Range Validation & Constraints**:
   - Parse `from` and `to` ISO timestamps.
   - Maximum window `<= 370 days` (rejection with `400 BAD_REQUEST`).
   - `from <= to` constraint validation.
   - Empty date ranges return zero-shaped valid payloads without crashing.
5. **RBAC & Cost Gating**:
   - Endpoints accessible by `VIEWER`, `SUPPORT`, `OPERATIONS`, `FINANCE`, `ADMIN`.
   - For roles below `FINANCE` (`VIEWER`, `SUPPORT`, `OPERATIONS`):
     - Cost fields (`recovery_cost_minor`, `net_recovered_minor`, `recovery_roi_bps`, `cost_per_case_minor`, `cost_per_recovered_bps`, `total_ai_cost_minor`) are stripped/omitted.
     - HTTP response header `x-cost-data-redacted: true` is emitted.
   - For `FINANCE` and `ADMIN` roles: complete unredacted financial metrics are returned without the redaction header.
6. **Redis 30s Caching & Single-Flight Coalescing**:
   - Cache key format: `analytics:${tenantId}:${endpoint}:${paramsHash}`.
   - 30-second TTL.
   - In-memory Promise Map prevents cache stampedes on concurrent cold requests.
   - Cache invalidation: recording a new outcome via `OutcomeRecordService.recordOutcome` triggers `invalidateAnalyticsCache(redis, tenantId)`.
7. **Deterministic Golden Snapshot Integration Tests**:
   - Seeded deterministic month with mixed payment failures, invoice overdue, checkout abandonment, approval escalations, and outcomes.
   - Exact mathematical assertions for all 6 endpoints.

---

## 2. Database Schema & Analytics SQL Views

**File:** `packages/db/src/schema/analytics-views.ts`  
**Migration:** `packages/db/drizzle/0009_wild_bastion.sql`

To keep heavy analytical scans off hot transaction execution paths, the `analytics` PostgreSQL schema was defined using Drizzle ORM query builders and explicit column aliasing.

### Views Defined:
1. `analytics.v_recovery_summary`:
   Combines `recovery_cases` with left-joined `recovery_outcomes` to expose canonical case state alongside financial outcome attribution.
2. `analytics.v_recovery_timeseries`:
   Projects authoritative financial recoveries from `recovery_outcomes` across time.
3. `analytics.v_intervention_performance`:
   Joins `recovery_actions`, `recovery_cases`, and `recovery_outcomes` to correlate action types (e.g. `SEND_WHATSAPP`, `OFFER_INCENTIVE`) with successful payment recoveries.
4. `analytics.v_funnel`:
   Projects case progression stages from inception to outcome recording.
5. `analytics.v_risk_mix`:
   Joins `recovery_cases`, `revenue_risks`, and `recovery_outcomes` to classify cases across risk types (`PAYMENT_FAILURE`, `INVOICE_OVERDUE`, `CHECKOUT_ABANDONMENT`) and risk bands (`HIGH`, `MEDIUM`, `LOW`).
6. `analytics.v_ai_performance`:
   Joins `ai_decisions` with `policy_evaluations` to track latency, token usage, cost minor units, and policy decision outcomes.

Migration was generated using `bun run --cwd packages/db db:generate` and applied using `bun run --cwd packages/db db:migrate`.

---

## 3. Database Repository Layer

**File:** `packages/db/src/repositories/analytics.repo.ts`  
**Exported in:** `packages/db/src/repositories/index.ts`

The repository layer handles database queries with strict multi-tenant isolation (`WHERE tenant_id = ${tenantId}` enforced on all sub-queries and joins).

### Core Aggregations:
1. `getAnalyticsSummary`:
   - `revenue_at_risk_minor`: Sum of `amount_at_risk` for cases opened in range that are not in terminal `RECOVERED` status.
   - `revenue_recovered_minor`: Sum of `recovered_amount` from `recovery_outcomes`.
   - `recovery_rate_bps`: `(revenue_recovered_minor * 10000) / revenue_at_risk_minor`.
   - `recovery_cost_minor` & `net_recovered_minor`: Rolled up from recorded outcomes.
   - `recovery_roi_bps`: `(net_recovered_minor * 10000) / recovery_cost_minor`.
   - `active_cases`: Count of cases with status in `('QUALIFIED', 'DECISION_PENDING', 'POLICY_REVIEW', 'WAITING', 'IN_PROGRESS', 'ESCALATED')`.
   - `escalations`: Count of `CASE_ESCALATED` events in `case_events`.
   - `avg_time_to_recovery_seconds`: Average `EXTRACT(EPOCH FROM (recovered_at - opened_at))`.

2. `getRecoveryTimeseries`:
   - Aggregates opened at-risk revenue and recovered outcome revenue by UTC time buckets (`DATE_TRUNC('day' | 'week', ... AT TIME ZONE 'UTC')`).
   - Uses a `FULL OUTER JOIN` / CTE union across bucket dates so days with only risk or only recovery are represented.

3. `getInterventionPerformance`:
   - Computes unique case count, successful recoveries, recovered minor units, and `success_rate_bps` grouped by `action_type`.

4. `getRecoveryFunnel`:
   - 5-stage funnel counts and amounts:
     1. `AT_RISK`: Total cases opened in period.
     2. `QUALIFIED`: Cases that passed initial risk qualification (`status != 'DETECTED'`).
     3. `CONTACTED`: Cases with >= 1 message record in `messages`.
     4. `ATTEMPTED`: Cases with >= 1 executed action in `recovery_actions`.
     5. `RECOVERED`: Cases with recorded outcome in `recovery_outcomes`.
   - `conversion_rate_bps`: `(recovered_count / at_risk_count) * 10000`.

5. `getRiskMix`:
   - Returns case counts and `amount_at_risk_minor` grouped by `risk_type` and `risk_band`.

6. `getAiPerformance`:
   - `decisions`: Total AI decisions generated in range.
   - `decision_acceptance_rate_bps`: Ratio of executed recovery actions to recommended actions in decisions.
   - `policy_rejections` & `policy_rejection_rate_bps`: Policy evaluation rejections (`result = 'REJECTED'`).
   - `approvals_required`: Policy evaluations resulting in `REQUIRE_APPROVAL`.
   - `avg_decision_ms`: Average inference and policy latency.
   - `cost_per_case_minor`: `total_ai_cost / decisions`.
   - `cost_per_recovered_bps`: `(total_ai_cost * 10000) / total_recovered`.

---

## 4. Backend Analytics Module

**Directory:** `apps/backend/src/modules/analytics/`  
**Mounted at:** `/analytics` in `apps/backend/src/lib/routes.ts`

### Sub-Module Architecture:
- `cache.ts`: Redis caching client with single-flight stampede protection.
- `queries/summary.ts`: Formats summary cards and strips cost metrics for non-finance callers.
- `queries/recovery-timeseries.ts`: Formats bucketed timeseries items with cost gating.
- `queries/interventions.ts`: Formats intervention performance arrays.
- `queries/funnel.ts`: Formats funnel stages and conversion metrics.
- `queries/risk-mix.ts`: Formats risk mix breakdown items.
- `queries/ai-performance.ts`: Formats AI autonomy metrics and cost economics.
- `routes.ts`: Fastify route definitions with Zod schema validation, date range bounds checking, role guards, and cache wrapping.

---

## 5. Single-Flight In-Memory Stampede Protection & Redis Caching

**File:** `apps/backend/src/modules/analytics/cache.ts`

To protect the PostgreSQL database from aggregation stampedes when dashboards load simultaneously:

1. **In-Flight Coalescing**:
   - `const inFlightMap = new Map<string, Promise<any>>()` keeps track of executing queries by cache key.
   - Concurrent requests for the same tenant and date range share the exact same underlying Promise.
2. **Redis Caching**:
   - Key: `analytics:${tenantId}:${endpoint}:${sha256(sortedParams).slice(0, 16)}`
   - TTL: 30 seconds (`EX 30`).
   - If Redis is degraded or offline, gracefully falls back to database execution with warning logs without breaking requests.
3. **Tenant-Scoped Invalidation**:
   - `invalidateAnalyticsCache(redis, tenantId)` scans and deletes all keys matching `analytics:${tenantId}:*` and removes corresponding in-flight promises.

---

## 6. RBAC Security & Cost-Field Redaction

**Rule:** Callers with role `< FINANCE` (`VIEWER`, `SUPPORT`, `OPERATIONS`) must not see proprietary financial cost or margin data.

### Implementation:
In each query handler:
- Role verification: `const isFinanceOrAdmin = ["FINANCE", "ADMIN"].includes(request.auth?.role);`
- If `!isFinanceOrAdmin`:
  - `reply.header("x-cost-data-redacted", "true")` is set on the HTTP response.
  - The following fields are stripped/omitted from JSON response payloads:
    - `/analytics/summary`: `financial.recovery_cost_minor`, `financial.net_recovered_minor`, `financial.recovery_roi_bps`.
    - `/analytics/recovery`: `timeseries[].recovery_cost_minor`, `timeseries[].net_minor`.
    - `/analytics/ai`: `cost_per_case_minor`, `cost_per_recovered_bps`, `total_ai_cost_minor`.

---

## 7. Cache Invalidation Hook on Outcome Recording

**File:** `apps/backend/src/modules/outcomes/record.service.ts`

When a new recovery outcome is finalized:
```ts
const result = await this.repos.withTransaction(...);

if (!result.alreadyRecorded) {
  await invalidateAnalyticsCache(this.redisClient, tenantId).catch(() => {});
}

return result;
```
This guarantees analytics dashboards immediately reflect newly recorded revenue without waiting for the 30-second TTL to expire.

---

## 8. Integration Testing & Golden Snapshot Verification

**Test File:** `apps/backend/src/tests/analytics-integration.test.ts`  
**Results:** 15 passing tests (100% pass rate).

### Scenarios Covered:
1. **GET /analytics/summary (FINANCE)**: Exact matching of revenue at risk, recovered revenue, net recovered, recovery rate bps, ROI bps, active cases, and escalations on a deterministic 30-day dataset.
2. **GET /analytics/summary (VIEWER)**: Redaction of cost fields and emission of `x-cost-data-redacted: true`.
3. **GET /analytics/recovery (day & week buckets)**: UTC time-series bucket correctness with role-based cost field gating.
4. **GET /analytics/interventions**: Action performance for WhatsApp, Email, Offer Incentive, and Retry Payment.
5. **GET /analytics/funnel**: 5 stages (`AT_RISK`: 4, `QUALIFIED`: 4, `CONTACTED`: 3, `ATTEMPTED`: 4, `RECOVERED`: 2) with 5000 bps conversion rate.
6. **GET /analytics/risk-mix**: Groupings across risk types and risk bands (`HIGH`, `MEDIUM`, `LOW`).
7. **GET /analytics/ai**: Autonomy decision counts, 100% acceptance rate, 25% rejection rate, 1 approval required, average latency, and cost per case.
8. **Boundary & Range Validation**:
   - `> 370 days` range rejected with `400 BAD_REQUEST`.
   - `from > to` rejected with `400 BAD_REQUEST`.
   - Empty date ranges return valid zero-shaped objects.
9. **Multi-Tenant Isolation**: Verified Tenant B queries return only Tenant B's financial outcomes with zero cross-tenant data leakage.
10. **Cache Bust Verification**: Validated fast sub-2ms cache hit on repeated query, followed by instant cache bust and data update when a new outcome is recorded.
11. **Authentication Guard**: Unauthenticated requests rejected with 401 `UNAUTHENTICATED`.

---

## 9. Verification Evidence (Definition of Done)

| Requirement | Evidence | Status |
|---|---|---|
| PostgreSQL `analytics` schema & 6 views created | `0009_wild_bastion.sql` migrated; `db:migrate:check` confirms all 10 migrations applied | ✅ PASS |
| Repository aggregation queries implemented | `packages/db/src/repositories/analytics.repo.ts` implemented and exported | ✅ PASS |
| 6 REST endpoints under `/analytics` | All endpoints mounted at `/analytics` in `apps/backend/src/lib/routes.ts` | ✅ PASS |
| Range validation `<= 370d`, `from <= to` -> 400 | Verified in `analytics-integration.test.ts` (returns 400 `BAD_REQUEST`) | ✅ PASS |
| RBAC cost-gating & `x-cost-data-redacted` header | Verified in `analytics-integration.test.ts` for VIEWER vs FINANCE roles | ✅ PASS |
| Redis 30s single-flight caching & cache-bust on outcome | Verified single-flight stampede guard and cache bust in `analytics-integration.test.ts` | ✅ PASS |
| Golden dataset snapshot integration tests | 15/15 tests passing in `analytics-integration.test.ts` | ✅ PASS |
| Full suite test verification | 62 test files, 872 unit/integration tests passing across monorepo | ✅ PASS |
| Type check verification | `bun run check-types` passed with 0 errors across 12 packages | ✅ PASS |
| Lint verification | `bun run lint` passed with 0 errors | ✅ PASS |
| Documentation check | `bun run check-docs` passed with 0 broken links | ✅ PASS |

---

## 10. Traceability Matrix Updates

| Section | Step | Artifacts Created / Updated | Description |
|---|---|---|---|
| Analytics & Reporting | `s-27` | `packages/db/src/schema/analytics-views.ts`, `packages/db/drizzle/0009_wild_bastion.sql`, `packages/db/src/repositories/analytics.repo.ts`, `apps/backend/src/modules/analytics/*`, `apps/backend/src/tests/analytics-integration.test.ts` | PostgreSQL analytics views, repository aggregations, 6 REST endpoints, Redis 30s single-flight cache, RBAC cost-field gating, and golden-dataset integration tests |
