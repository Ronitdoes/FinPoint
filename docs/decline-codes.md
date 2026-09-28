# Canonical Payment Decline-Code Table (s-18)

Source of truth: `INTERNAL_DECLINE_CODES` in
`packages/integrations/src/payments/types.ts`, populated by
`mapStripeDeclineCode` (`stripe.adapter.ts`) and `mapRazorpayErrorCode`
(`razorpay.adapter.ts`). Adapters are pure executors — every gateway failure
is normalized into this closed taxonomy before it reaches orchestration
(metrics, policy context, workflow replan).

Flow: gateway raw code → adapter mapper → `RetryPaymentResult.failureCode`
(internal code) + `rawFailureCode` (original preserved for forensics) →
`payment_attempts.failure_code` + `recordProviderDecline` metric.

## Table

| Internal code | Stripe sources | Razorpay sources (matched on code + description + reason text) | Meaning | Later-round retry? |
|---|---|---|---|---|
| `insufficient_funds` | `insufficient_funds` | `insufficient_funds`, `insufficient balance`, `low balance` | Card/account lacks funds | **Yes** — next round (funds may arrive); never an immediate hot loop |
| `stale_card` | `expired_card` | `expired`, `expiry` | Card expired | **No** — requires a new payment method; notify customer |
| `bank_decline` | `generic_decline`, `card_declined`, `bank_decline`, `withdrawal_count_limit_exceeded` | `declined by bank`, `bank declined`, `bank_error`, `bank`+`decline` | Generic issuer/bank refusal (incl. Razorpay `do_not_honor`-worded texts, which normalize here — Razorpay never emits the standalone `do_not_honor` code) | **Limited** — one later retry, then escalate |
| `do_not_honor` | `do_not_honor` | — (no Razorpay source maps here) | Issuer explicitly refuses without reason; needs customer authorization | **No** — escalate to customer |
| `incorrect_cvc` | `incorrect_cvc`, `invalid_cvc` | `invalid_cvv`, `incorrect_cvc`, `cvv` | Wrong security code | **No** — requires corrected CVC |
| `lost_or_stolen` | `lost_card`, `stolen_card` | `lost_card`, `stolen` | Card reported lost/stolen | **No** — block instrument, manual review |
| `fraudulent` | `fraudulent`, `merchant_blacklist` | `fraud`, `risk_check` | Suspected fraud / risk block | **No** — block, manual review |
| `invalid_account` | `invalid_account`, `incorrect_number`, `invalid_number` | `invalid_account`, `invalid_card` | Invalid card number/account | **No** — invalid instrument |
| `processing_error` | `processing_error`, `card_velocity_exceeded` | `gateway_error`, `server_error`, `processing_error` | Transient acquirer/gateway fault | **Yes** — transient, safe to retry next round |
| `unknown_decline` | anything unmapped (fallback) | anything unmapped (fallback) | Unrecognized gateway response | **Cautious** — single retry, then escalate |

## Notes

- **4xx vs 5xx split (Spec 18 §Requirements 4):** adapters return HTTP 4xx
  gateway responses as definitive `FAILED` results (mapped through this
  table) — they are never thrown and never retried. HTTP 5xx responses are
  thrown (`…returned 5xx status: NNN`) and classified by
  `isRetryableProviderError` (`apps/backend/src/modules/payments/execution.service.ts`)
  for the bounded ×2 network-only retry; anything else thrown (programming
  errors) surfaces immediately.
- **UNKNOWN polling** (`refresh.service.ts`, N=6 over ~60s) resolves
  `UNKNOWN`/`ACCEPTED_ASYNC` attempts via `getPaymentStatus`; terminal
  `FAILED` statuses from polling carry the mapped internal code above.
- **Mock provider** scripts `insufficient_funds` (first attempt) and honors
  `setOutcomeOverride` failure codes from this table for demos/tests.
- Related: [s-18 explanation](./explanation/s-18-explanation.md) §3 (taxonomy),
  §8–§9 (execution/refresh).
