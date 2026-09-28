# Least-Privilege Credentials (s-30)

One row per credential class: what it can do, where it lives, and the
minimum scope to issue. Rule of thumb: a credential that can both *read*
and *move money* is a finding — split it.

## Provider credentials

| Credential | Lives in | Least privilege | Notes |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | secret manager → `packages/integrations` only (CONVENTIONS §12) | **Restricted key**: read + refund/write only on the objects the recovery loop touches; no account-settings, no payouts | Live mode fails fast at boot without it (`@repo/config`); mock mode needs nothing |
| `STRIPE_WEBHOOK_SECRET` | secret manager | Signing secret for exactly one webhook endpoint | Rotate via [webhook-secrets-rotation](./webhook-secrets-rotation.md); Stripe dual-signature roll = zero downtime |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | secret manager → `packages/integrations` | Key pair scoped to the merchant account that owns the payments; test vs live pairs must never mix | Same fail-fast/rotation story as Stripe |
| `RAZORPAY_WEBHOOK_SECRET` | secret manager | One secret per webhook endpoint | Dual-endpoint migration = zero downtime |
| `WHATSAPP_API_KEY` + `WHATSAPP_PHONE_NUMBER_ID` | secret manager → `packages/integrations` | System-user token with `whatsapp_business_messaging` only, bound to the single sender number | Webhook verification uses the separate `WHATSAPP_VERIFY_SECRET` |
| `EMAIL_API_KEY` / `EMAIL_FROM` | secret manager → `packages/integrations` | Sending-only key for the single verified sender domain | Inbound status webhooks use `EMAIL_WEBHOOK_SECRET` |
| `LLM_API_KEY` | secret manager → `packages/integrations` via AI service | Key capped with a spend limit at the provider; no assistant/admin scopes | Token spend is metered per decision (`recovery_cost_entries`, category `LLM`) |
| `DATABASE_URL` / `DIRECT_URL` | secret manager | App role: read/write on app tables; `audit_logs`/`case_events` append-only enforced by DB triggers (s-25) with dedicated `app_rw` / `audit_writer` roles | Migrations use the direct (unpooled) URL; see ADR-003/ADR-004 |
| `REDIS_URL` | secret manager | Local dev: no auth (loopback only). Production: ACL user limited to the key prefixes the app uses (`rr:*`, `sec:*`, `apikey:*`, `session:*`, `login_attempts:*`) | Redis is never source of truth (ADR-007) |
| `SESSION_SECRET` | secret manager | Signs `rr_session` cookies only; rotation logs everyone out (acceptable, announced) | Cookies are `httpOnly`, `SameSite=Lax`, `Secure` in prod, 12 h sliding |
| `NEXT_PUBLIC_*` | build args only | Public, inlined into the JS bundle — **never secrets** (sweep-enforced) | Only `NEXT_PUBLIC_API_URL` exists today |

## Machine vs human principals

- **Machine API keys** (`rrk_…`, SHA-256 stored, revocable) carry explicit
  **scopes** (`events:write`, `ai:decide`, `demo`, `policy:evaluate`,
  `worker`, `*`). Issue the narrowest scope per integration; `*` is for
  full-trust internal tooling only. Keys are ADMIN *within their tenant*
  but can never cross tenants (probe-verified).
- **Human sessions** carry the 5-role RBAC ladder
  (`VIEWER < SUPPORT < OPERATIONS < FINANCE < ADMIN`). Human-task
  approve/reject additionally requires an interactive session — API keys
  get 403 even with `*` (s-21), so automation can never approve its own
  escalations.

## Rotation summary

| Secret | How | Downtime |
|---|---|---|
| Stripe webhook secret | Dashboard roll → deploy → expire old | None (dual signatures) |
| Razorpay webhook secret | Second endpoint → deploy → remove old | None |
| API keys (`rrk_…`) | Issue new (`POST /admin/api-keys`) → migrate callers → revoke old (`DELETE /admin/api-keys/:id`) | None per key |
| Sessions | Revoke server-side; rotate `SESSION_SECRET` to drop all | Logout only |
| DB/Redis/provider master keys | Provider/secret-manager rotation, rolling deploy | Rolling restart |

Details: [webhook-secrets-rotation](./webhook-secrets-rotation.md) and
[webhook-secret-rotation](./webhook-secret-rotation.md) (abuse-block interplay).
