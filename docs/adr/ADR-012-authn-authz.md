# ADR-012 — Authentication, authorization, and tenant context

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Engineering (step s-01)
- **Related specs:** `specs/01-implementation-0-to-100.md` §22; `specs/03-mvp-build-spec.md` §11

## Context

Three caller classes hit the system: dashboard users (interactive), machine clients (internal APIs), and payment providers (webhooks). Multi-tenant isolation is mandatory (spec 02 §15) and security acceptance requires role checks on admin endpoints and mandatory tenant context (spec 03 §11).

## Decision

1. **Dashboard users:** email + password authentication; server-side session records referenced by an httpOnly cookie. Passwords hashed with a modern KDF (argon2id preferred). Sessions revocable server-side.
2. **Machine clients:** tenant-scoped bearer API keys (`Authorization: Bearer rr_…`), stored hashed, with tenant binding and optional scope/role metadata. Key issuance/rotation lives in the admin module.
3. **Webhooks:** verified by provider signature (Stripe `stripe-signature`, Razorpay HMAC) before any processing; unsigned/replayed requests rejected (s-10).
4. **RBAC roles are exactly:** `ADMIN`, `FINANCE`, `OPERATIONS`, `SUPPORT`, `VIEWER`. Role checks are enforced by a Fastify pre-handler plugin with per-route required roles; no ad-hoc role checks in controllers.
5. **Tenant context is mandatory** for every authenticated request: resolved from session/API key into request context (`tenant_id`), propagated to repositories; requests without tenant context fail with stable error code `TENANT_CONTEXT_MISSING`.
6. Audit log writes record actor type/id for every sensitive action (spec 01 §18).

## Consequences

- One consistent authn story across HTTP surfaces; Temporal activities re-establish context from workflow payloads rather than ambient state.
- RBAC matrix per endpoint is declared in route schemas, making security review mechanical.

## Alternatives considered

- **OAuth/OIDC SSO:** deferred post-MVP; sessions/API keys satisfy spec 03 §11 now.
- **JWT-only stateless auth:** rejected for dashboard because instant revocation is required for financial tooling.
