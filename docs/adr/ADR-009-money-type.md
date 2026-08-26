# ADR-009 — Money representation: integer minor units + ISO-4217 currency

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §5; `specs/02-architecture-and-domain.md` §3, §8

## Context

The system computes amounts at risk, recovered totals, costs, ROI, and discount caps. Floating-point money produces rounding drift that is unacceptable for financial records.

## Decision

1. All monetary values are stored as **integers in minor units** (paise for INR, cents for USD) in PostgreSQL `bigint` columns.
2. Every monetary column is accompanied by `currency CHAR(3)` holding an ISO-4217 code; amounts are meaningless without their currency.
3. Arithmetic happens in integer domain (or a vetted decimal library for ratios); conversion to display strings occurs only at the presentation edge via a single formatting utility in `@repo/domain`.
4. Floats/doubles/`numeric`-with-float-parsing are forbidden for money anywhere in the stack (DB columns, TS types use `bigint`/branded integer types, JSON payloads carry integers).
5. Ratios (recovery rate, ROI) are computed from integer inputs and rendered as rounded percentages at the edge.

## Consequences

- Exact sums and comparisons across tenants, providers, and currencies.
- TypeScript domain layer exposes branded types (e.g., `MinorUnits`) to prevent accidental float mixing.

## Alternatives considered

- **Postgres `numeric`:** acceptable precision but invites float parsing in JS; rejected in favor of integers end-to-end.
