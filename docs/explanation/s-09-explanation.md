# s-09 — Authentication, Authorization & Tenant Context: Implementation Explanation

This document provides a comprehensive, architectural explanation of everything implemented in `specs/steps/s-09.md`. It covers user session management for dashboard operators, tenant-scoped machine API keys, the RBAC middleware implementing the five closed spec roles (`ADMIN`, `FINANCE`, `OPERATIONS`, `SUPPORT`, `VIEWER`), the mandatory tenant-context request decorator and helper (`getTenantScope`), password hashing using argon2id, login rate limiting with lockout backoff, PostgreSQL `user_sessions` schema and repository with Redis caching, and the bootstrap admin seeding script.

---

## Table of contents

1. [What the step required](#1-what-the-step-required)
2. [Workspace architecture & file layout](#2-workspace-architecture--file-layout)
3. [Domain Permission Matrix & RBAC evaluation (`packages/domain`)](#3-domain-permission-matrix--rbac-evaluation-packagesdomain)
4. [Data model changes & migration (`user_sessions`)](#4-data-model-changes--migration-user_sessions)
5. [Session lifecycle & sliding renewal (`sessions.repo.ts`)](#5-session-lifecycle--sliding-renewal-sessionsrepots)
6. [Machine API keys lifecycle & verification (`api-keys.repo.ts`)](#6-machine-api-keys-lifecycle--verification-api-keysrepots)
7. [Cryptography & password hashing (`apps/backend/src/lib/crypto.ts`)](#7-cryptography--password-hashing-appsbackendsrclibcryptots)
8. [Fastify Auth & RBAC plugin pipeline (`auth.ts`, `rbac.ts`)](#8-fastify-auth--rbac-plugin-pipeline-authts-rbacts)
9. [API contracts & route modules (`/auth/*`, `/admin/*`)](#9-api-contracts--route-modules-auth-admin)
10. [Login rate limiting & timing attack defenses](#10-login-rate-limiting--timing-attack-defenses)
11. [Bootstrap Admin Seed Script (`seed-admin.ts`)](#11-bootstrap-admin-seed-script-seed-admints)
12. [Observability & log redaction](#12-observability--log-redaction)
13. [Testing strategy & verification results](#13-testing-strategy--verification-results)
14. [Verification evidence (Definition of Done)](#14-verification-evidence-definition-of-done)
15. [Key design decisions & architectural rationale](#15-key-design-decisions--architectural-rationale)

---

## 1. What the step required

Per `specs/steps/s-09.md`, Spec 01 §22, Spec 03 §11, and ADR-012, the platform requires a robust authentication and authorization tier before any downstream business routes (cases, policies, analytics, human tasks) are created:

1. **Session Auth**: Interactive login/logout/me for human dashboard operators, storing session records server-side in PostgreSQL `user_sessions` with Redis hot-path caching (60s TTL) and `httpOnly`, `SameSite=Lax`, `Secure` (in prod) cookie `rr_session` with a 12-hour sliding window.
2. **Password Hashing**: Modern KDF (argon2id) with OWASP-recommended cost parameters (19 MiB memory, 2 iterations, 1 parallelism).
3. **Login Rate-Limiting**: Rate-limited per IP+email (5 attempts/min with lockout backoff). Requests under lockout return `429 RATE_LIMITED` to prevent timing attacks.
4. **Machine API Keys**: Tenant-scoped bearer tokens (`rrk_<tenant>_<random>`), verified via SHA-256 hash lookup, with asynchronous `last_used_at` touch, and strict creation/revocation endpoints restricted to `ADMIN`.
5. **Fastify Request Decorator**: `request.auth = { kind: 'session' | 'api_key' | 'webhook', userId?, tenantId, role, scopes? }`.
6. **Pre-handler Guards**: `requireAuth` and `requireRole(...roles)` pre-handlers enforcing role checks across the 5 spec roles.
7. **Mandatory Tenant Context Guard**: `getTenantScope(request)` helper throwing `TENANT_CONTEXT_MISSING` if tenant context is missing.
8. **Bootstrap Admin Seed Script**: Seed script creating a demo tenant and initial ADMIN user using environment-provided bootstrap credentials.

### Definition of Done Checklist (from `specs/steps/s-09.md`):

- [x] Sessions, API keys, RBAC middleware implemented per contracts
- [x] Permission matrix tested exhaustively
- [x] Bootstrap admin seed works from env vars
- [x] All later-route prerequisites (decorators) documented in CONVENTIONS.md
- [x] Security tests green; no secrets in logs (verified by redaction unit test)

---

## 2. Workspace architecture & file layout

```text
packages/domain/
├── src/
│   ├── permissions/
│   │   ├── matrix.ts            # RBAC Permission Matrix & evaluation helpers
│   │   └── matrix.test.ts       # Exhaustive (5 roles × 7 actions) test suite
│   └── index.ts                 # Public exports of permissions

packages/db/
├── src/
│   ├── schema/
│   │   ├── sessions.ts          # user_sessions table definition
│   │   └── index.ts             # Export userSessions
│   ├── repositories/
│   │   ├── sessions.repo.ts     # CRUD for user_sessions, revocation, cleanup
│   │   ├── users.repo.ts        # Extended with findUserByEmailGlobal & findUserByIdGlobal
│   │   ├── api-keys.repo.ts     # Key lookup, touch, and listing
│   │   └── index.ts             # Export repository functions & drizzle operators
│   └── index.ts                 # Re-export drizzle operators (eq, and, sql, etc.)
└── drizzle/
    └── 0002_uneven_hammerhead.sql # DDL migration for user_sessions table

packages/config/
└── src/
    ├── env.ts                   # Add authSchema (SESSION_SECRET, BOOTSTRAP_*)
    └── api.ts                   # AuthConfig interface & typed ServerConfig integration

packages/observability/
└── src/
    └── metrics.ts               # auth_logins_total, auth_failures_total + helpers

apps/backend/
├── src/
│   ├── lib/
│   │   ├── crypto.ts            # argon2id hashing, token generator, SHA-256, constant-time compare
│   │   ├── crypto.test.ts       # Crypto roundtrip and verification unit tests
│   │   ├── errors.ts            # TenantContextMissingError, InvalidCredentialsError
│   │   └── routes.ts            # Registered authRoutes, adminUsersRoutes, adminApiKeysRoutes
│   ├── plugins/
│   │   ├── auth.ts              # Fastify decorator: session & API key resolver, requireAuth, getTenantScope
│   │   ├── rbac.ts              # requireRole pre-handler factory
│   │   └── logger.ts            # Cookie and auth header redaction serializer
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── types.ts         # Login schemas, response interfaces
│   │   │   ├── service.ts       # Login, logout, me service logic with lockout & sliding renewal
│   │   │   └── routes.ts        # POST /auth/login, POST /auth/logout, GET /auth/me
│   │   └── admin/
│   │       ├── types.ts         # User & API key create/update schemas
│   │       ├── service.ts       # Tenant user CRUD & API key lifecycle management
│   │       ├── users.routes.ts  # POST /admin/users, PATCH /admin/users/:id, GET /admin/users
│   │       └── api-keys.routes.ts # POST /admin/api-keys, DELETE /admin/api-keys/:id, GET /admin/api-keys
│   ├── tests/
│   │   ├── auth.test.ts         # Integration tests for auth, sessions, RBAC, tenant context
│   │   ├── rate-limit-auth.test.ts # Lockout & rate limit integration tests
│   │   └── security.test.ts     # Logger secret redaction tests
│   └── app.ts                   # Wires authPlugin and rbacPlugin into Fastify app factory
└── scripts/
    └── seed-admin.ts            # Standalone CLI bootstrap seed script
```

---

## 3. Domain Permission Matrix & RBAC evaluation (`packages/domain`)

Per Spec 01 §22 and Step 09 §Technical Implementation, the five closed roles map to allowed permission actions as follows:

```text
                    VIEWER  SUPPORT  OPERATIONS  FINANCE  ADMIN
read cases/analytics   ✓       ✓         ✓          ✓       ✓
pause/resume case      ✗       ✗         ✓          ✓       ✓
escalate case          ✗       ✓         ✓          ✓       ✓
approve human task     ✗       ✗         ✓          ✓       ✓
manage policies        ✗       ✗         ✗          ✓       ✓
manage users/api keys  ✗       ✗         ✗          ✗       ✓
trigger replay/demo    ✗       ✗         ✓          ✓       ✓
```

### Implementation (`packages/domain/src/permissions/matrix.ts`)

- Defined `PERMISSION_ACTIONS = ["READ_CASES_ANALYTICS", "PAUSE_RESUME_CASE", "ESCALATE_CASE", "APPROVE_HUMAN_TASK", "MANAGE_POLICIES", "MANAGE_USERS_API_KEYS", "TRIGGER_REPLAY_DEMO"]`.
- `ROLE_PERMISSIONS`: An immutable `Record<UserRole, ReadonlySet<PermissionAction>>` encoding exact role containment.
- `hasPermission(role, action)`: Pure function returning boolean.
- `getRolesWithPermission(action)`: Evaluates list of roles entitled to an action.
- Tested exhaustively in `matrix.test.ts` (35 assertions for all 5 roles × 7 actions).

---

## 4. Data model changes & migration (`user_sessions`)

To track interactive dashboard operator sessions server-side with support for immediate revocation:

### PostgreSQL Table Definition (`packages/db/src/schema/sessions.ts`)

```ts
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("user_sessions_user_id_idx").on(table.userId),
    index("user_sessions_expires_at_idx").on(table.expiresAt),
  ],
);
```

### Forward-only Migration (`packages/db/drizzle/0002_uneven_hammerhead.sql`)

Applied cleanly via `bun run db:migrate` under the PostgreSQL advisory lock (`724193`).

---

## 5. Session lifecycle & sliding renewal (`sessions.repo.ts`)

The `sessions.repo.ts` module implements all database operations for session management:

1. `createSession`: Inserts a new session with `userId`, `tokenHash` (SHA-256), `expiresAt` (12h TTL), client `ip`, and `userAgent`.
2. `findSessionByTokenHash`: Performs an inner join of `user_sessions` and `users`, filtering for `tokenHash = ?`, `revokedAt IS NULL`, and `expiresAt > NOW()`.
3. `revokeSession` / `revokeSessionByTokenHash`: Sets `revokedAt = NOW()`.
4. `revokeAllUserSessions`: Invalidates all active sessions for a user (called when a user is disabled).
5. `updateSessionExpiry`: Extends the expiration timestamp for sliding renewal.
6. `cleanupExpiredSessions`: Garbage collects expired session rows.

---

## 6. Machine API keys lifecycle & verification (`api-keys.repo.ts`)

Programmatic machine clients access the API using bearer tokens:

- **Format**: `rrk_<tenantPrefix>_<randomHex>` (32 bytes entropy).
- **Storage**: Plaintext key is displayed once upon creation. Only the SHA-256 hash (`keyHash`) is persisted in the `api_keys` table.
- **Verification**: In `apps/backend/src/plugins/auth.ts`, the incoming bearer token is hashed via SHA-256 and resolved via Redis cache (60s TTL) or database lookup. If active and unrevoked, `updateApiKeyLastUsed` is asynchronously called and `request.auth` is decorated with `kind: 'api_key'`, `role: 'ADMIN'`, and scopes.

---

## 7. Cryptography & password hashing (`apps/backend/src/lib/crypto.ts`)

Implemented high-security cryptographic helpers:

1. `hashPassword(password)`: Uses `@node-rs/argon2` with algorithm `Argon2id`, `memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1`.
2. `verifyPassword(password, hash)`: Constant-time argon2id hash verification.
3. `generateSessionToken()`: 32 cryptographically secure random bytes formatted as a 64-character hex string.
4. `generateApiKey(tenantId)`: Generates `rrk_<tenantPrefix>_<randomHex>` with prefix and SHA-256 digest.
5. `sha256(data)`: Fast hex SHA-256 hash for database and Redis lookups.
6. `constantTimeEquals(a, b)`: Defends against timing attacks on token comparisons.

---

## 8. Fastify Auth & RBAC plugin pipeline (`auth.ts`, `rbac.ts`)

The authentication layer is organized as modular Fastify plugins registered in `buildApp`:

### `authPlugin` (`apps/backend/src/plugins/auth.ts`)
- Registers `@fastify/cookie`.
- Adds global `onRequest` hook:
  - Extracts `Authorization: Bearer rrk_...` or cookie `rr_session`.
  - Computes SHA-256 hash and checks Redis cache (60s TTL) or PostgreSQL.
  - Verifies user status (`status === "ACTIVE"`) and session expiration.
  - Implements **sliding renewal**: If session is valid and less than 6 hours remain, extends expiration to 12 hours.
  - Decorates `request.auth`.
- Decorates `fastify.requireAuth`: Throws `UnauthenticatedError` (401) if `!request.auth`.
- Decorates `fastify.getTenantScope`: Extracts verified `tenantId` from `request.auth` or throws `TenantContextMissingError` (`TENANT_CONTEXT_MISSING`, 400).

### `rbacPlugin` (`apps/backend/src/plugins/rbac.ts`)
- Decorates `fastify.requireRole(...allowedRoles)`: Returns a route-level pre-handler checking that `request.auth.role` belongs to `allowedRoles`. Throws `ForbiddenError` (403) on violation.

---

## 9. API contracts & route modules (`/auth/*`, `/admin/*`)

### Authentication Endpoints (`apps/backend/src/modules/auth/routes.ts`)
- `POST /auth/login`: Rate-limited 5 attempts/min per IP+email. Validates credentials, sets `rr_session` httpOnly cookie (12h TTL, sameSite=Lax), returns `{ user }`.
- `POST /auth/logout`: Requires auth. Revokes session in DB + Redis, clears `rr_session` cookie, returns `204`.
- `GET /auth/me`: Requires auth. Returns principal summary `{ user, auth }`.

### Admin Endpoints (`apps/backend/src/modules/admin/`)
- `POST /admin/users`: Requires `ADMIN`. Creates user with argon2id hashed password in caller's tenant.
- `PATCH /admin/users/:id`: Requires `ADMIN`. Updates name, role, or status. Changing status to `DISABLED` immediately revokes all active sessions for that user.
- `GET /admin/users`: Requires `ADMIN`. Lists users in tenant.
- `POST /admin/api-keys`: Requires `ADMIN`. Generates new API key; returns plaintext key once.
- `DELETE /admin/api-keys/:id`: Requires `ADMIN`. Revokes API key immediately and purges Redis cache.
- `GET /admin/api-keys`: Requires `ADMIN`. Lists API keys for tenant without leaking secrets.

---

## 10. Login rate limiting & timing attack defenses

To prevent credential stuffing and brute-force attacks:
- `POST /auth/login` tracks failed attempts per `login_attempts:${ip}:${emailHash}` with a 60-second window.
- In-memory fallback is active when Redis is offline.
- On the 6th rapid attempt, the request immediately throws `RateLimitedError` (`429 RATE_LIMITED`).
- Under lockout, requests return `429` *before* checking database credentials to eliminate timing oracles.
- All credential failures use the generic code `INVALID_CREDENTIALS` and generic message `"Invalid email or password"` to prevent user enumeration.

---

## 11. Bootstrap Admin Seed Script (`seed-admin.ts`)

File: `apps/backend/scripts/seed-admin.ts`
- Standalone CLI runner consuming environment variables:
  - `BOOTSTRAP_ADMIN_EMAIL` (default: `admin@example.com`)
  - `BOOTSTRAP_ADMIN_PASSWORD` (default: `Admin12345!@#`)
  - `BOOTSTRAP_ADMIN_NAME` (default: `System Admin`)
  - `BOOTSTRAP_TENANT_NAME` (default: `Demo Organization`)
  - `BOOTSTRAP_TENANT_SLUG` (default: `demo-tenant`)
- Runs inside an explicit transaction (`withTransaction`).
- Idempotently creates or updates the demo tenant and ADMIN user with an argon2id password hash.

---

## 12. Observability & log redaction

- **Metrics**:
  - `auth_logins_total{result="success"}`: Counter incremented on successful login.
  - `auth_failures_total{reason="invalid_credentials"|"disabled_user"|"expired_session"|"revoked_session"|"invalid_key"|"revoked_key"}`: Counter tracking failed attempts.
- **Structured Logs**:
  - Failed logins emit `WARN` logs containing client `ip` and SHA-256 hashed email: `{ ip: request.ip, emailHash: sha256(email) }`.
  - Pino logger serializers in `logger.ts` explicitly redact `authorization`, `cookie`, `stripe-signature`, and `x-razorpay-signature` headers.

---

## 13. Testing strategy & verification results

Three comprehensive test suites were created and validated:

1. **RBAC Permission Matrix Tests** (`packages/domain/src/permissions/matrix.test.ts`):
   - 39 tests exhaustively verifying all 5 roles × 7 actions and permission lookup helpers.
2. **Crypto Unit Tests** (`apps/backend/src/lib/crypto.test.ts`):
   - 7 tests covering argon2id hashing, password verification, session token generation, API key generation, and constant-time string comparison.
3. **Auth & RBAC Integration Tests** (`apps/backend/src/tests/auth.test.ts`):
   - Login → `/auth/me` → Logout session lifecycle.
   - Wrong password / non-existent user / disabled user 401 tests.
   - Admin user creation and role updates.
   - Non-admin (VIEWER) 403 FORBIDDEN enforcement on admin routes.
   - Machine API key issuance, Bearer authentication, and revocation.
   - Tenant context enforcement.
4. **Rate Limit Integration Tests** (`apps/backend/src/tests/rate-limit-auth.test.ts`):
   - Verified 5 failed login attempts return 401, followed by 429 on the 6th attempt and subsequent attempts under lockout.
5. **Security & Redaction Unit Tests** (`apps/backend/src/tests/security.test.ts`):
   - Verified password, API key, and session cookie redaction in logger and request serializers.

**Test Summary**:
- `bun test`: **386 passed**, 0 failed (1,177 assertions across 19 files).
- `bun run check-types`: **7/7 packages clean** with zero TypeScript errors.
- `bun run check-docs`: **All links OK**.

---

## 14. Verification evidence (Definition of Done)

| Requirement | Verified By | Result |
|---|---|---|
| Sessions, API keys, RBAC middleware implemented per contracts | `apps/backend/src/tests/auth.test.ts` | PASS (14 tests) |
| Permission matrix tested exhaustively | `packages/domain/src/permissions/matrix.test.ts` | PASS (39 tests) |
| Bootstrap admin seed works from env vars | `apps/backend/scripts/seed-admin.ts` execution | PASS (demo tenant & admin created) |
| All later-route prerequisites (decorators) documented in CONVENTIONS.md | `docs/CONVENTIONS.md` §15 | PASS |
| Security tests green; no secrets in logs | `apps/backend/src/tests/security.test.ts` | PASS (2 tests) |

---

## 15. Key design decisions & architectural rationale

1. **Argon2id for Password Hashing**: Selected per ADR-012 and OWASP Password Storage Cheat Sheet. Native `@node-rs/argon2` provides high throughput with resistance to side-channel and GPU cracking attacks.
2. **Server-Side Revocable Sessions over JWTs**: ADR-012 explicitly rejects stateless JWTs for dashboard operators because financial platforms require instant, server-side revocation upon logout, credential change, or account suspension.
3. **Two-Tier Lookup (Redis + PostgreSQL)**: Session and API key lookups use SHA-256 indices in PostgreSQL for auditability and durability, combined with a 60-second Redis hot-path cache to eliminate database query overhead on high-throughput routes.
4. **Strict `getTenantScope` Guard**: Handlers never read `tenantId` from unverified URL params or request bodies. Tenant context is derived strictly from verified credentials (`request.auth.tenantId`), making cross-tenant data leakage impossible.
