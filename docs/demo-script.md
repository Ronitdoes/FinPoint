# AI Revenue Recovery — 9-Scene Live Demo Script (v0.1.0 Final)

Nine scenes per **Spec 01 §27**, rehearsed against the running system for the
v0.1.0 release (Step 35). Every number below is **measured**, not aspirational:
where the system differs from early prose (risk 60 not 86, ₹14.6L baseline not
₹12.8L), the measured value is canonical and the drift is explained inline.

> Seed determinism hash for all numbers below: `22785c9449e186952d14cfe16789c7a84f764a57cb8b0ffb2bae75608158048b`
> (`bun run db:seed --reset` → same hash, same numbers — verified ×2 cold runs
> on 2026-09-10. Re-verify any time with `GET /analytics/summary`.)

Total runtime: **3–5 minutes** including narration. Scene timings are wall-clock
measured on the local compose stack.

---

## Pre-Demo Setup & Environment Readiness (~2 min, done before the audience clock starts)

```bash
# 1. Start infrastructure (postgres, redis, temporal, redpanda, collector,
#    backend, frontend, worker) with healthchecks. `bun run infra:up`
#    includes the worker profile, so scenes S6–S8 are covered — just verify
#    `arr-worker` is up (`docker ps`) and polling in the Temporal UI below.
bun run infra:up

# 2. Apply database migrations (12 forward-only migrations, incl. s-35 0010 + 0011_magical_pepper_potts)
bun run db:migrate

# 3. Seed pristine spec volumes + Scenarios A/B/C (+ A-variant RECOVERED case)
bun run db:seed --reset
# Prints the determinism hash above. Safe to re-run: tenant-scoped reset,
# slug-guarded to demo tenants, atomic since s-35 (migration 0010 hatch).

# 4. Confirm the Temporal worker is polling (REQUIRED for S6; already
#    started by step 1 — only run the command below if `arr-worker` is missing):
#    docker compose --profile worker -f infra/docker/docker-compose.yml up -d worker
#    Host fallback (`bun --filter @repo/worker start`) only if the container won't start.
```

### Access URLs & Credentials

- **Frontend Dashboard**: [http://localhost:3000](http://localhost:3000)
- **Backend API**: [http://localhost:4000](http://localhost:4000)
- **Temporal UI**: [http://localhost:8080](http://localhost:8080)
- **Redpanda console**: [http://localhost:8081](http://localhost:8081)
- **Login**: `ops@example.com` / `Admin12345!@#` (role `OPERATIONS`; `admin@example.com` also works)

### Demo configuration matrix (pick your track before Scene 1)

| Track | LLM setup | S4 shows | How to select |
|---|---|---|---|
| **A — live LLM** | `LLM_API_KEY` set, no injections | `COMPLETED` decision, model diagnosis (typically `insufficient_funds` + `RETRY_PAYMENT`/`SEND_WHATSAPP`) | default when a key is configured |
| **B — fallback** (rehearsed default, no key needed) | no key, or `simulate_llm_failure: true` | `FALLBACK_RULE_BASED` badge, `stale_card` 0.70, `CREATE_HUMAN_TASK` → policy `ALLOWED` | `PATCH /demo/injections {"simulate_llm_failure":true}` (lowercase keys; 15-min TTL) |

Track B is the no-surprises conference-hall default: fully deterministic given
the seed hash. The COMPLETED-vs-FALLBACK contrast is additionally proven by the
E2E flagship journey (normal + `SIMULATE_LLM_FAILURE` variants, both green).

---

## 9-Scene Walkthrough Narrative

```text
Scene 1: System Baseline Dashboard  (₹14.6L at risk, 35 active cases)   [~30s]
   ↓
Scene 2: Inbound Failure Trigger    (POST /demo/payment-fail → ACCEPTED) [~5s]
   ↓
Scene 3: Real-Time Case Creation    (Risk = 60, Band = HIGH)             [~30s]
   ↓
Scene 4: AI Diagnosis               (Track A COMPLETED / Track B FALLBACK)[~30s]
   ↓
Scene 5: Policy Governance Check    (Verdict: ALLOWED, 9 rules)          [~20s]
   ↓
Scene 6: Orchestration              (DB workflow ledger RUNNING; see note)[~20s]
   ↓
Scene 7: Payment Success Loopback   (POST /demo/payment-succeed)        [~5s]
   ↓
Scene 8: Authoritative ROI          (pre-seeded ₹12,999 RECOVERED case)  [~30s]
   ↓
Scene 9: Immutable Audit Trail      (4-event spine → full ledger)        [~30s]
                                                   [total ≤5min]
```

---

### Scene 1: System Baseline Dashboard [~30s]

**Goal**: establish credibility with real seeded volumes.

1. Open [http://localhost:3000](http://localhost:3000), sign in, land on `/dashboard`.
2. Read the overview cards — expected values after a fresh `db:seed --reset`:
   - **Revenue at Risk**: `₹14,61,915.31` (≈ **₹14.6L**)
   - **Active Cases**: `35`
   - **Recovered Revenue (baseline)**: `₹3,19,121.69`
   - **Recovery rate**: `2182 bps`
3. Gesture at the recovery funnel + risk-mix (LOW/MEDIUM/HIGH/CRITICAL).

> Drift note: early prose cited “₹12.8L / 20 cases” from the s-29 seed
> generation. The s-30 August-date fix changed seeded aggregates; the seed
> hash above pins the current volumes. If your numbers differ, re-run
> `db:seed --reset` and compare hashes — same hash ⇒ same numbers, always.

---

### Scene 2: Inbound Payment Failure Trigger [~5s]

**Goal**: prove failures enter through the real, authenticated event gateway
(HMAC-signed webhook loopback — no test backdoors).

```bash
curl -X POST http://localhost:4000/demo/payment-fail \
  -H "Content-Type: application/json" \
  -H "Cookie: rr_session=<YOUR_SESSION_COOKIE>" \
  -d '{"customer_ref":"CUS-001","amount_minor":1299900,"provider":"STRIPE"}'
# → {"ok":true,"refs":{"provider":"STRIPE",...,"customerRef":"CUS-001",
#     "amountMinor":1299900,"webhookStatus":"ACCEPTED"}}   (~1.3s)
```

**Say while it runs**: “Scenario A — CUS-001, ₹12,999 annual subscription,
high-intent customer. The simulator builds a real Stripe
`payment_intent.payment_failed`, HMAC-signs it, and posts it to
`/webhooks/stripe`. Signature verified, event deduped, published to
`revenue-events.v1`.”

---

### Scene 3: Real-Time Case Creation & Risk Scoring [~30s]

**Goal**: deterministic risk scoring + automated case qualification.

1. Open `/cases` — the newest card is CUS-001 (next case number, e.g. `RC-9992`).
2. Click into `/cases/[id]` — expected:
   - **Risk Score**: `60 / 100`, band **`HIGH`**
   - **Amount at risk**: `₹12,999` (`1299900` minor units, INR)
   - **Factors** (explainability JSON): prior failures `≥1` (+20) and `≥2`
     (+20), customer active (+10), strong 180-day success history (+10).

> Drift note: spec §27’s “Risk = 86%” was the s-12-era illustrative target.
> The shipped deterministic rule set scores pristine Scenario A at **60/HIGH**.
> The band — the decision-relevant output — matches the spec expectation
> (`risk = HIGH`, spec 03 Scenario A).

---

### Scene 4: AI Diagnosis & Decisioning [~30s]

**Goal**: bounded, schema-validated AI output — with a visible safety story
either way.

- **Track A** (key configured): **AI Decision** card shows status `COMPLETED`,
  diagnosis (typically `insufficient_funds`), ranked catalog actions
  (`RETRY_PAYMENT` + `SEND_WHATSAPP`), stop conditions
  (`PAYMENT_SUCCEEDED`, `OPTED_OUT`, `MAX_RETRIES`).
- **Track B** (rehearsed, keyless): card shows **`FALLBACK_RULE_BASED`**,
  diagnosis `stale_card` (confidence `0.70`), one action
  **`CREATE_HUMAN_TASK`** (“Payment failure retry limit reached”, HIGH).
  **Say**: “No key, no hallucination, no stall — the deterministic fallback
  fires, is cost-tagged at ₹0 LLM spend, and still goes through policy.”

Either way: “The LLM only ever *recommends* from the closed Action Catalog.
It cannot move money, retry, or message anyone — that is structural, enforced
by validation + policy, and proven by the boundary audit
(`bun run boundaries:audit`, 0 errors).”

---

### Scene 5: Policy Governance Check [~20s]

**Goal**: autonomy is permitted, never assumed.

1. **Policy Verdict** card: **`ALLOWED`** — `allowed: true`,
   `required_approval: false`, 9 rules evaluated, 0 rejections, 1 effective
   action (`CREATE_HUMAN_TASK` → `APPROVED` action row).
2. **Say**: “₹12,999 is below the ₹1,00,000 high-value threshold, retry budget
   intact, contact caps clean, no opt-out, no dispute — autonomous execution
   permitted.”
3. For the REJECTED path, cite the automated proof (not a live click): e2e
   `AC-PAY-3` — retry count 3 + AI recommends retry → `POL-MAXRETRY` rejects
   (pure `evaluate` contract, green in CI). No REJECTED rows are pre-seeded in
   demo data by design — the ledger only contains what really happened.

---

### Scene 6: Orchestration [~20s]

**Goal**: durable workflow identity + ledger — with an honest boundary.

1. Case shows `status: IN_PROGRESS`, workflow row `RUNNING` with deterministic
   id `recover:<caseId>` (visible in the case payload / `workflows` table).
2. Timeline spine at this point (live, in order):
   `RISK_CALCULATED → AI_DECISION_CREATED → POLICY_ALLOWED → WORKFLOW_STARTED`.
3. **Say (v0.1.0 boundary, do not skip)**: “Execution handoff is recorded in
   the durable workflow ledger. Live Temporal *task execution* on the composed
   stack lands in the v0.1.1 patch step — see `docs/RELEASE-v0.1.0.md` known
   limitation L1. The workflow logic itself is proven today by three
   time-skipping matrix suites (12 + 8 + 9 scenarios, s-22–s-24) and the
   scripted flagship E2E that assembles the same services end to end.”

---

### Scene 7: Payment Success Loopback [~5s]

**Goal**: out-of-band success ingestion through the same signed gateway.

```bash
# payment_id = the case's source_entity_id (shown on the case card)
curl -X POST http://localhost:4000/demo/payment-succeed \
  -H "Content-Type: application/json" \
  -H "Cookie: rr_session=<YOUR_SESSION_COOKIE>" \
  -d '{"payment_id":"<PAYMENT_ID>"}'
# → {"ok":true,...,"webhookStatus":"ACCEPTED"} — payment row → SUCCEEDED
```

**Say**: “Same HMAC loopback as Scene 2, now `payment_intent.succeeded`.
The ledger marks the payment `SUCCEEDED`. Wake-up-to-`RECOVERED` closing of
the live case follows the L1 patch (signal path wired there); the
authoritative outcome mechanics are shown next on the pre-seeded recovered
case.”

---

### Scene 8: Authoritative ROI [~30s]

**Goal**: money math from PostgreSQL, never from UI state.

1. Open the pre-seeded recovered case (**CUS-001-REC**, case `9991`) or
   `GET /outcomes` — expected live row:
   - **Recovered**: `₹12,999` (`1299900` minor), method `PAYMENT_RETRY`,
     case `RECOVERED`.
2. `GET /cases/<id>/outcome` shows the cost rollup
   (`SUM(recovery_cost_entries)` — LLM + messaging + processing) and
   `net = recovered − costs`.
3. Refresh `/dashboard`: the seeded baseline (`₹3.19L` recovered) plus the new
   outcome rows reconcile — dashboard reads outcomes, it never computes money.

---

### Scene 9: Immutable Audit Trail [~30s]

**Goal**: non-repudiation — every step, append-only, tamper-evident.

1. On the live case (`/cases/[id]` → timeline): the 4-event spine from Scene 6,
   plus `PAYMENT_SUCCEEDED` (provider) after Scene 7 — chronological,
   actor-typed (`SYSTEM`), cursor-paginated.
2. On the recovered case: the full spine through `RECOVERY_RECORDED`.
3. **Say**: “`UPDATE`/`DELETE` on `audit_logs`, `case_events`,
   `audit_archive` are rejected by database triggers — try it, it raises. The
   only exception is the slug-guarded, transaction-local demo reset
   (migration 0010), which exists so this demo can go cold again in one
   command. Compliance reads live behind `GET /audit` (ADMIN-only).”

Close with the pillars: **Detection → Decision → Governance → Execution →
Recovery → Auditability.**

---

## Fallback Plan (if anything is red on stage)

| Failure | 30-second recovery |
|---|---|
| No LLM key / key expired | You are already on Track B — narrate the `FALLBACK_RULE_BASED` badge (`stale_card` 0.70, `CREATE_HUMAN_TASK` → policy `ALLOWED`, ₹0 LLM spend). Pin it with `PATCH /demo/injections {"simulate_llm_failure":true}` (15-min TTL). |
| Stripe / Razorpay webhook signature failure (401 / `invalid_signature`) | Stage loopback self-signs, so re-fire `POST /demo/payment-fail` (~1.3s → `ACCEPTED`). For a real provider secret: check `STRIPE_WEBHOOK_SECRET` / `RAZORPAY_WEBHOOK_SECRET`, send raw body with `Content-Type: application/json`, mind the ±5m Stripe tolerance window. |
| Temporal down / no worker (workflow never `RUNNING`, UI `:8080` empty) | Narrate the DB workflow ledger row (`recover:<caseId>` `RUNNING`) — the v0.1.0 L1 boundary — then recover: `docker compose -f infra/docker/docker-compose.yml --profile worker up -d worker` (containerized worker on queue `recovery-main`; host fallback `bun --filter @repo/worker start`); verify pollers in the UI. |
| Redpanda down / consumer silent (console `:8081` red) | Stay on the bus fallback: `EVENT_BUS_DRIVER=inprocess` keeps the single-process demo moving. Recover with `bun run infra:up` to re-green the broker, then re-fire the trigger and confirm `ACCEPTED` plus console `:8081` activity. |
| Database down / `db:migrate` connection refused | Wait for the `pg_isready` healthcheck; verify `DATABASE_URL` / `DIRECT_URL` point at `:5432/revenue_recovery`. Recover: `bun run infra:up` then `bun run db:migrate` (12/12). Meanwhile narrate S1 / S8 / S9 from the last dashboard snapshot. |
| Dirty demo state / numbers drifted from `₹14.6L` / 35 cases (hash mismatch) | One-command cold reset: `bun run db:seed --reset` (tenant-scoped, slug-guarded, atomic via the migration 0010 hatch) → re-verify hash `22785c94` and `GET /analytics/summary` → re-trigger Scene 2 for a fresh `RC-*` case. |