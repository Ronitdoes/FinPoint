# s-28 — Dashboard UI (Next.js Financial Control Plane): Implementation Explanation

This document explains in complete technical depth everything implemented for `specs/steps/s-28.md`. It covers the Next.js App Router structure, authenticated layout shell, middleware route guards, 8 core pages, client-side RBAC gating, integer minor unit Indian money formatting, interactive modals, Recharts visualizations, virtualized timeline with polling, and verification evidence.

---

## Table of Contents

1. [What the Step Required](#1-what-the-step-required)
2. [Architecture & Technology Stack](#2-architecture--technology-stack)
3. [Client Infrastructure & Utilities (`apps/frontend/src/lib/`)](#3-client-infrastructure--utilities)
4. [Middleware Route Guard (`apps/frontend/src/middleware.ts`)](#4-middleware-route-guard)
5. [UI Components & Design System (`apps/frontend/src/components/ui/`)](#5-ui-components--design-system)
6. [Visualization & Chart Components (`apps/frontend/src/components/charts/`)](#6-visualization--chart-components)
7. [Case Detail & Relation Components (`apps/frontend/src/components/cases/`)](#7-case-detail--relation-components)
8. [Case Event Timeline Feed (`apps/frontend/src/components/timeline/`)](#8-case-event-timeline-feed)
9. [Action & Admin Modals (`apps/frontend/src/components/modals/`)](#9-action--admin-modals)
10. [Pages Implementation (`apps/frontend/src/app/`)](#10-pages-implementation)
11. [Unit & Component Testing](#11-unit--component-testing)
12. [Definition of Done Compliance Matrix](#12-definition-of-done-compliance-matrix)

---

## 1. What the Step Required

Step 28 delivers the complete operator frontend in `apps/frontend`. As established in Spec 00 §6, Spec 01 §16, Spec 02 §1, and Spec 03 §7, the dashboard serves as an autonomous financial control plane. The frontend is observation-only — it never computes business state client-side beyond display formatting.

### Core Acceptance Contracts:
1. **Authentication & Route Protection**:
   - Operator login card at `/login` setting HTTP-only `rr_session` cookie.
   - Next.js middleware guarding all `/dashboard`, `/cases`, `/risk`, `/recovery`, `/policies`, `/audit`, `/tasks`, `/settings` routes with automatic 401 redirect.
   - Client API wrapper with automatic unauthenticated session handling.
2. **8 Dashboard Pages (App Router)**:
   - `/dashboard`: 7 core overview cards (Revenue at Risk, Recovered, Recovery Rate, Recovery Cost, Net Recovered, Active Cases, Escalations), recovery trajectory area chart, risk surface mix, AI performance telemetry, active cases preview.
   - `/cases`: Filterable operations table with status chips, risk surfaces, amount thresholds, customer search, saved-filter chips, and cursor pagination.
   - `/cases/[id]`: Full canonical detail: obligation summary, risk factors breakdown ("Why at Risk"), AI decision card (diagnosis, confidence bar, prompt/model metadata, fallback badge), policy verdict card (clearance, rejections, latency), actions ledger, outcome attribution card, and real-time event timeline.
   - `/risk`: Open risks table by type/band with factor drill-down explainability modal.
   - `/recovery`: 5-stage progression funnel visualization, intervention channel performance table with inline success bars, AI decisioning and policy rejection telemetry.
   - `/policies`: Platform policy rule list grouped by category, toggle switch (FINANCE+), rule creation modal, and version history diff viewer.
   - `/audit`: Admin-only compliance audit trail search with date filters, actor filters, and JSON metadata inspector (with 403 guard view for non-admins).
   - `/tasks`: Human escalation desk with pending/overdue badges and interactive Approve (optional notes) and Reject (mandatory notes) modals.
   - `/settings`: Tenant profile overview, Team management (ADMIN), API key issuing with one-time copy modal (ADMIN), and Mock provider demo controls.
3. **Interactive Timeline Component**:
   - Chronological event feed matching `GET /cases/:id/timeline`.
   - Auto-refresh polling (30s countdown) with manual refresh and pause controls.
   - Screen-share demo mode support (`?demo=1`) for enlarged typography and highlights.
4. **Indian Currency & Number System Formatting**:
   - Minor units (paise) converted to ₹ formatted string with Lakh/Crore grouping (e.g. ₹12,999 / ₹4,80,000 / ₹12.8L / ₹8.4L / ₹72K / ₹7.68L).
5. **Role-Based Access Control (RBAC) UX Gating**:
   - Exact client-side mirror of `@repo/domain` matrix for gating control buttons while backend remains the enforcement authority.
6. **Zero XSS & Secret Safety**:
   - No `dangerouslySetInnerHTML` in the entire frontend bundle.
   - No secrets bundled in client assets (only `NEXT_PUBLIC_API_URL`).

---

## 2. Architecture & Technology Stack

The frontend application is structured inside `apps/frontend`:
- **Framework**: Next.js 16 (App Router with Turbopack)
- **Language**: TypeScript 5
- **Styling**: Tailwind CSS v4 with custom dark financial control plane palette (`#0B0F17`, `#0F172A`, `#1E293B`, `#10B981`, `#06B6D4`, `#6366F1`)
- **Icons**: `lucide-react`
- **Charts**: `recharts` for responsive area and metric charts
- **Package Manager**: Bun 1.4

---

## 3. Client Infrastructure & Utilities (`apps/frontend/src/lib/`)

### `lib/api.ts`
- Universal typed fetch client wrapping backend endpoints from steps 09–27.
- Sets `credentials: "include"` on every request to pass the `rr_session` cookie.
- Normalizes backend error envelopes (`{ error: { code, message, details } }`) into strongly-typed `ApiError` instances.
- Automatically handles HTTP 401 by redirecting the browser to `/login?from=...`.

### `lib/money.ts`
- `formatMoney(minorUnits, currency, options)`: Formats minor units (paise/cents) into currency strings with Indian number system grouping (`12,34,567`).
- `formatCompactNumber(majorUnits, currency)`: Supports Indian compact format (`₹12.8L`, `₹8.4L`, `₹72K`, `₹4.8Cr`).
- `toMinorUnits(majorUnits)`: Safely parses rupee/dollar inputs into integer minor units.

### `lib/format.ts`
- `formatDate`: Formats ISO timestamps to standard localized dates.
- `formatRelativeTime`: Generates human-friendly relative strings (`just now`, `15m ago`, `2h ago`).
- `formatPercent`: Formats rate floats to single-decimal percentages (`65.4%`).
- `formatLatency`: Formats millisecond latencies (`1.8s`, `142ms`).
- `getCaseStatusColor` & `getRiskBandColor`: Centralized palette definitions for badges and status indicators.

### `lib/rbac.ts`
- Mirrors the backend permission matrix for UI element gating:
  - `hasPermission(role, action)`
  - `canPauseResume(role)` (OPERATIONS, FINANCE, ADMIN)
  - `canEscalate(role)` (SUPPORT, OPERATIONS, FINANCE, ADMIN)
  - `canStop(role)` (FINANCE, ADMIN)
  - `canApproveTasks(role)` (OPERATIONS, FINANCE, ADMIN)
  - `canManagePolicies(role)` (FINANCE, ADMIN)
  - `canManageAdmin(role)` (ADMIN)

---

## 4. Middleware Route Guard (`apps/frontend/src/middleware.ts`)

- Guards all authenticated dashboard paths (`/dashboard`, `/cases`, `/risk`, `/recovery`, `/policies`, `/audit`, `/tasks`, `/settings`).
- Inspects incoming requests for the `rr_session` cookie.
- If unauthenticated, immediately redirects to `/login?from=${encodeURIComponent(pathname)}`.
- If visiting `/login` with an existing session, redirects to `/dashboard`.
- Automatically bypasses Next.js static assets and API routes.

---

## 5. UI Components & Design System (`apps/frontend/src/components/ui/`)

- `Badge.tsx`: Pill indicators for statuses, risk bands, roles, and priority tags with variants (`success`, `warning`, `danger`, `info`, `secondary`, `outline`).
- `Button.tsx`: Accessible buttons with loading spinners, icon placement, and variant styles (`primary`, `secondary`, `outline`, `danger`, `warning`, `success`, `ghost`).
- `Card.tsx`: Glassmorphism containers with hover states, headers, titles, and descriptions.
- `Modal.tsx`: Accessible dialog overlays with keyboard escape support and focus locking.
- `Input.tsx` & `Textarea`: Dark-themed form inputs with validation error states and helper text.
- `Select.tsx`: Form selects with custom dark styling.
- `Tabs.tsx`: Tabbed navigation bar with count badges.
- `Alert.tsx`: Inline contextual feedback banners with dismiss actions.

---

## 6. Visualization & Chart Components (`apps/frontend/src/components/charts/`)

### `RecoveryTimeseriesChart.tsx`
- Recharts `AreaChart` rendering Revenue at Risk vs. Recovered Revenue over time.
- Custom dark tooltip formatting values in Indian currency notation.

### `RecoveryFunnelChart.tsx`
- 5-stage progression funnel representing conversion drops from `At Risk` → `Qualified` → `Contacted` → `Attempted` → `Recovered`.
- Displays stage counts, rupee volumes, and stage-to-stage conversion percentages.

### `RiskMixChart.tsx`
- Surface and risk band breakdown with proportional progress bars and band pills.

### `InterventionSuccessChart.tsx`
- Table of action types (`Payment Retry`, `WhatsApp Outreach`, `Email Reminder`, `Alternate Payment Link`, `Recovery Incentive`, `Human Escalation`) with attempts, successes, total recovered amount, and inline success rate progress bars.

---

## 7. Case Detail & Relation Components (`apps/frontend/src/components/cases/`)

- `DecisionCard.tsx`: AI diagnosis cause, confidence bar (color-coded for high vs moderate confidence), model/prompt version metadata, fallback badge if `status=FALLBACK_RULE_BASED`, rationale, recommended actions, and stop conditions.
- `PolicyVerdictCard.tsx`: Policy evaluation result (`ALLOWED`, `REJECTED`, `REQUIRE_APPROVAL`), evaluation latency, violation rules, and effective allowed actions.
- `ActionsLedger.tsx`: Execution attempts ledger with idempotency keys, statuses, and timestamps.
- `OutcomeCard.tsx`: Financial recovery outcome card with attribution method, recovered amount, and payment link.
- `RiskFactorsCard.tsx`: Risk band, score, and "Why at Risk" rule contributions breakdown.

---

## 8. Case Event Timeline Feed (`apps/frontend/src/components/timeline/`)

- `CaseTimeline.tsx`: Virtualized chronological feed matching `GET /cases/:id/timeline`.
- Auto-refresh polling every 30 seconds with countdown badge and pause/refresh controls.
- Distinct icons and badges for all event types (`PAYMENT_FAILED`, `RISK_CALCULATED`, `AI_DECISION_CREATED`, `POLICY_ALLOWED`, `WORKFLOW_STARTED`, `WHATSAPP_SENT`, `PAYMENT_RETRY_STARTED`, `PAYMENT_SUCCEEDED`, `RECOVERY_RECORDED`).
- Metadata payload inspector drawer.
- Scale typography in demo mode (`?demo=1`).

---

## 9. Action & Admin Modals (`apps/frontend/src/components/modals/`)

- `ApproveTaskModal.tsx`: Confirm human task approval with optional operator notes.
- `RejectTaskModal.tsx`: Reject human task with **mandatory** rejection reason validation.
- `CaseControlModals.tsx`: Confirmation dialogs for Pause, Resume, Escalate (notes), and Stop (**mandatory reason**).
- `CreateUserModal.tsx`: Admin dialog to provision operator users and assign roles.
- `CreateApiKeyModal.tsx`: Admin dialog to issue scoped API keys with one-time copy modal.
- `CreatePolicyModal.tsx`: Finance dialog to create platform policy rules with JSON parameter editing.

---

## 10. Pages Implementation (`apps/frontend/src/app/`)

| Route | Purpose | Key Elements |
|---|---|---|
| `/login` | Operator login | Email/password form, demo quick-fill persona buttons (Admin, Finance, Ops, Support, Viewer) |
| `/dashboard` | Executive overview | 7 core summary cards, recovery trajectory chart, risk surface mix, AI telemetry, recent cases |
| `/cases` | Operations case list | Filterable table, saved filter chips (High Value, Escalated, Invoices), cursor pagination |
| `/cases/[id]` | Canonical case detail | Relation cards (Obligation, Risk, Decision, Policy, Actions, Outcome), live 30s timeline, control action buttons |
| `/risk` | Risk intelligence view | Open risks table, band and type filtering, factor drill-down explainability modal |
| `/recovery` | Recovery analytics | 5-stage funnel, intervention performance table with inline success bars, AI governance panel |
| `/policies` | Policy management | Rule list by category, enable/disable toggles (FINANCE+), rule creator, version history diff viewer |
| `/tasks` | Human task inbox | Escalation inbox, priority badges, approve/reject modals with mandatory note enforcement |
| `/audit` | Compliance audit trail | Admin-only audit log search, actor/event filters, JSON metadata inspector (403 guard for non-admins) |
| `/settings` | Settings & administration | Tenant profile, Team management (ADMIN), API key management (ADMIN), mock provider simulation controls |

---

## 11. Unit & Component Testing

Test suites located in `apps/frontend/src/tests/`:
1. `money.test.ts`:
   - Validates standard Indian number grouping (`₹12,999`, `₹4,80,000`).
   - Validates executive compact notation (`₹12.8L`, `₹8.4L`, `₹72K`, `₹7.68L`, `₹4.8Cr`).
   - Validates multi-currency formatting (`USD`, `EUR`, `GBP`) and minor unit conversion.
2. `rbac.test.ts`:
   - Validates role permissions for `VIEWER`, `SUPPORT`, `OPERATIONS`, `FINANCE`, and `ADMIN`.
3. `timeline.test.ts`:
   - Validates chronological event ordering matching Spec 00 §6 Scenario A.
4. `decision-card.test.ts`:
   - Validates confidence percentage formatting, policy latency formatting, and fallback badge logic.
5. `funnel.test.ts`:
   - Validates 5-stage funnel progression and intervention success math.
6. `route-guard.test.ts`:
   - Validates protected vs public routes.
7. `overview-cards.test.ts`:
   - Reconciles all 7 overview cards (Revenue at Risk, Recovered Revenue, Recovery Rate, Net Recovered, Recovery Cost, Active Cases, Escalated Cases) exactly against Spec 00 §6 targets.
   - Verifies net recovered arithmetic (`Recovered - Cost = Net`).
   - Validates VIEWER role cost data redaction handling (`recoveryCost: null` -> `"—"`).
   - Snapshot test of reconciled presentation data.

**Test Run Output:**
```text
 ✓  unit  apps/frontend/src/tests/timeline.test.ts (2 tests)
 ✓  unit  apps/frontend/src/tests/funnel.test.ts (2 tests)
 ✓  unit  apps/frontend/src/tests/route-guard.test.ts (2 tests)
 ✓  unit  apps/frontend/src/tests/rbac.test.ts (5 tests)
 ✓  unit  apps/frontend/src/tests/money.test.ts (5 tests)
 ✓  unit  apps/frontend/src/tests/decision-card.test.ts (3 tests)
 ✓  unit  apps/frontend/src/tests/overview-cards.test.ts (4 tests)

 Test Files  7 passed (7)
      Tests  23 passed (23)
```

---

## 12. Definition of Done Compliance Matrix

| Definition of Done Requirement | Status | Evidence |
|---|---|---|
| All eight pages + login implemented per spec layouts | ✅ COMPLIANT | Implemented `/login`, `/dashboard`, `/cases`, `/cases/[id]`, `/risk`, `/recovery`, `/policies`, `/audit`, `/tasks`, `/settings`. |
| Timeline matches spec 00 §6 example content for seeded Scenario A case | ✅ COMPLIANT | `CaseTimeline.tsx` and `timeline.test.ts` verify full 9-step event flow. |
| Overview cards reconcile exactly with `/analytics/summary` (fixture snapshot test) | ✅ COMPLIANT | `overview-cards.test.ts` validates exact card metrics reconciliation against `/analytics/summary` fixture and snapshot. |
| Role gating matrix mirrored correctly; server remains authority | ✅ COMPLIANT | `rbac.ts` mirrors matrix and tested in `rbac.test.ts`. |
| No dangerouslySetInnerHTML / no secrets in bundle | ✅ COMPLIANT | Grep audit confirmed 0 instances; only `NEXT_PUBLIC_API_URL` referenced. |
| Lint/typecheck/build green; smoke test passes locally | ✅ COMPLIANT | `bun run check-types` green, `bun run lint` green (0 errors, 0 warnings), `bun vitest run apps/frontend` green (23/23 tests), `next build` production bundle compiled successfully (13 routes). |
