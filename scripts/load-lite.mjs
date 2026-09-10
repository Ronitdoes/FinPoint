/**
 * Load-lite performance measurement (s-34 §Requirements 5).
 *
 * Bun-run realistic mix against a live backend (in-process Fastify + real
 * Postgres/Redis from the environment), producing MEASURED numbers for
 * docs/PERFORMANCE.md against the six spec 03 §10 targets:
 *
 *   phases: policy | risk | webhook | reads | duplicates | llm | all
 *
 *   bun scripts/load-lite.mjs [--phase all] [--webhook-n 300] [--reads-n 200]
 *     [--concurrency 10] [--out infra/load/baseline.local.json]
 *
 * - policy/risk/llm: pure in-process benches (no infra needed).
 * - webhook: signed Stripe payment_failed via app.inject (unique event ids),
 *   exercising verification → normalize → upsert → bus dispatch.
 * - reads: session-authenticated GET /analytics/summary, /cases, /risks.
 * - duplicates: same payload ×N concurrently → exactly 1 ACCEPTED
 *   (zero duplicate financial actions under load).
 * - llm: deterministic fallback-path decision latency (no provider call, no
 *   cost) + the s-15 eval-harness live-model typical is cited in
 *   PERFORMANCE.md rather than re-measured here.
 *
 * Rate limiting stays ON (production-realistic); volumes sit under the s-30
 * per-class budgets. A uniquely-named `load-lite-*` tenant isolates rows.
 * Exit code 0 always (measurement, not gate); the nightly perf-gate job
 * applies the >20% regression rule against infra/load/baseline.json.
 */
import { randomUUID, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (!a.startsWith("--")) return [];
    const eq = a.indexOf("=");
    if (eq > 0) return [[a.slice(2, eq), a.slice(eq + 1)]];
    const next = arr[i + 1];
    return [[a.slice(2), next && !next.startsWith("--") ? next : "true"]];
  }),
);

const PHASE = args.phase ?? "all";
const WEBHOOK_N = Number(args["webhook-n"] ?? 300);
const READS_N = Number(args["reads-n"] ?? 200);
const DUPLICATE_N = Number(args["duplicate-n"] ?? 50);
const CONCURRENCY = Number(args.concurrency ?? 10);
const BENCH_N = Number(args["bench-n"] ?? 1000);
const OUT = args.out ?? "infra/load/baseline.local.json";

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(name, samples, unit = "ms") {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    name,
    n: sorted.length,
    unit,
    mean: round(sum / sorted.length),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function round(v) {
  return Math.round(v * 100) / 100;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const want = (name) => PHASE === "all" || PHASE === name;
const results = { env: {}, phases: {}, targets: {} };

// ---- pure benches (no infra) ---------------------------------------------
if (want("policy")) {
  const { evaluate } = await import("../packages/policy/src/evaluator.ts");
  const input = {
    case: {
      id: "case-bench", tenant_id: "tenant-bench", risk_type: "PAYMENT_FAILURE",
      amount_at_risk: 129900, currency: "INR", retry_count: 1,
      status: "IN_PROGRESS", payment_status: "FAILED",
    },
    customer: { opted_out: false, dispute_open: false },
    decision: { diagnosis_confidence: 0.9, requires_approval: false },
    actions: [
      { type: "RETRY_PAYMENT", params: { attempt_number: 2 } },
      { type: "SEND_WHATSAPP", params: { template: "payment_failed_v1", variables: {} } },
    ],
    counters: { whatsapp_sent_7d: 0, email_sent_14d: 1, sms_sent_7d: 0 },
  };
  const samples = [];
  for (let i = 0; i < BENCH_N; i++) {
    const t0 = performance.now();
    evaluate(input);
    samples.push(performance.now() - t0);
  }
  results.phases.policy = summarize("policy_evaluation", samples);
}

if (want("risk")) {
  const { scorePaymentFailure } = await import(
    "../apps/backend/src/modules/risk/engine/score-payment-failure.ts"
  );
  const now = new Date();
  const aggregates = {
    customer: { id: "cus", status: "ACTIVE", createdAt: new Date(now.getTime() - 400 * 864e5), updatedAt: now },
    payment: { id: "pay", amount: 129900, currency: "INR", status: "FAILED" },
    subscriptions: [],
    paymentsHistory: [
      { id: "p1", status: "SUCCEEDED", paidAt: new Date(now.getTime() - 30 * 864e5) },
      { id: "p2", status: "FAILED", createdAt: now },
    ],
    paymentAttempts: [{ id: "a1", status: "FAILED" }],
    now,
  };
  const samples = [];
  for (let i = 0; i < BENCH_N; i++) {
    const t0 = performance.now();
    scorePaymentFailure(aggregates);
    samples.push(performance.now() - t0);
  }
  results.phases.risk = summarize("risk_calculation", samples);
}

if (want("llm")) {
  // Deterministic fallback path only (zero provider cost): the same
  // generateFallbackDecision the decide service uses when the LLM fails.
  const { generateFallbackDecision } = await import(
    "../apps/backend/src/modules/ai/validate/fallback.ts"
  );
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    generateFallbackDecision({ riskType: "PAYMENT_FAILURE", priorRetriesCount: 1 });
    samples.push(performance.now() - t0);
  }
  results.phases.llm_fallback = summarize("llm_fallback_path", samples);
}

// ---- live phases (need Postgres/Redis from env) ---------------------------
const needsLive = want("webhook") || want("reads") || want("duplicates");
let app = null;
let tenantId = null;
let stripeSecret = `whsec_loadlite_${randomUUID().slice(0, 8)}`;

if (needsLive) {
  const { apiConfig } = await import("../packages/config/src/api.ts");
  const { buildApp } = await import("../apps/backend/src/app.ts");
  const { db, createTenant, createUser, createSession } = await import("../packages/db/src/index.ts");
  const { sha256 } = await import("../apps/backend/src/lib/crypto.ts");

  // Fire-and-forget black-hole bus: mirrors the production Redpanda path
  // where ingest.service resolves the HTTP response right after DISPATCH
  // (consumers run in other processes). NullBus would await handlers inline
  // and drag the whole risk→case→pipeline cascade into the measured window.
  const blackHoleBus = {
    published: 0,
    async publish() { this.published++; },
    subscribe() {},
    async close() {},
  };

  const baseConfig = apiConfig();
  results.env = {
    nodeEnv: baseConfig.app.env,
    busDriver: baseConfig.bus.driver,
    mockProviders: baseConfig.demo.mockProviders,
    when: new Date().toISOString(),
  };
  const tenant = await createTenant(
    { db },
    { name: `load-lite ${randomUUID().slice(0, 8)}`, slug: `load-lite-${randomUUID().slice(0, 8)}` },
  );
  tenantId = tenant.id;

  app = await buildApp({
    eventBus: blackHoleBus,
    logger: false,
    config: {
      ...baseConfig,
      payments: { ...baseConfig.payments, stripeWebhookSecret: stripeSecret },
    },
  });
  await app.ready();
  app.tenantId = tenantId;
  app.dbHandle = { db };
  app.crypto = { sha256, createTenant, createUser, createSession, db };
}

function stripeSig(body, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${sig}`;
}

function webhookPayload(tag) {
  return JSON.stringify({
    id: `evt_loadlite_${tag}_${randomUUID()}`,
    type: "payment_intent.payment_failed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `pi_loadlite_${randomUUID()}`,
        amount: 129900,
        currency: "inr",
        customer: `cus_loadlite_${randomUUID().slice(0, 8)}`,
      },
    },
  });
}

if (want("webhook")) {
  const items = Array.from({ length: WEBHOOK_N }, (_, i) => i);
  const samples = [];
  let accepted = 0;
  await mapPool(items, CONCURRENCY, async () => {
    const body = webhookPayload("burst");
    const t0 = performance.now();
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${tenantId}`,
      headers: { "content-type": "application/json", "stripe-signature": stripeSig(body, stripeSecret) },
      payload: body,
    });
    samples.push(performance.now() - t0);
    if (res.statusCode === 200 && JSON.parse(res.body).status === "ACCEPTED") accepted++;
  });
  results.phases.webhook = { ...summarize("webhook_response", samples), accepted, total: WEBHOOK_N };
}

if (want("duplicates")) {
  const body = webhookPayload("dupe");
  const headers = { "content-type": "application/json", "stripe-signature": stripeSig(body, stripeSecret) };
  const items = Array.from({ length: DUPLICATE_N }, (_, i) => i);
  const statuses = await mapPool(items, CONCURRENCY, async () => {
    const res = await app.inject({ method: "POST", url: `/webhooks/stripe?tenant_id=${tenantId}`, headers, payload: body });
    try {
      return JSON.parse(res.body).status;
    } catch {
      return `HTTP_${res.statusCode}`;
    }
  });
  const acceptedCount = statuses.filter((s) => s === "ACCEPTED").length;
  const duplicateCount = statuses.filter((s) => s === "DUPLICATE").length;
  results.phases.duplicates = {
    name: "duplicate_webhook_storm",
    sent: DUPLICATE_N,
    accepted: acceptedCount,
    duplicates: duplicateCount,
    other: statuses.filter((s) => s !== "ACCEPTED" && s !== "DUPLICATE"),
    zero_duplicate_financial_actions: acceptedCount === 1 && duplicateCount === DUPLICATE_N - 1,
  };
}

if (want("reads")) {
  const { createUser, createSession, sha256, db } = app.crypto;
  const user = await createUser({ db }, {
    tenantId,
    email: `reader-${randomUUID().slice(0, 8)}@example.com`,
    name: "Load Reader",
    role: "FINANCE",
    status: "ACTIVE",
  });
  const rawToken = `tok_load_${randomUUID()}`;
  await createSession({ db }, { userId: user.id, tokenHash: sha256(rawToken), expiresAt: new Date(Date.now() + 3600_000) });
  const cookie = `rr_session=${rawToken}`;
  const paths = [
    "/analytics/summary?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z",
    "/cases?limit=20",
    "/risks?limit=20",
  ];
  const items = Array.from({ length: READS_N }, (_, i) => paths[i % paths.length]);
  const samples = [];
  let ok = 0;
  await mapPool(items, CONCURRENCY, async (path) => {
    const t0 = performance.now();
    const res = await app.inject({ method: "GET", url: path, headers: { cookie } });
    samples.push(performance.now() - t0);
    if (res.statusCode === 200) ok++;
  });
  results.phases.reads = { ...summarize("api_read", samples), ok, total: READS_N };
}

if (app) {
  // Bounded teardown: background handles (pg pool, redis, bus timers) must
  // not hold the measurement process open; lingering async consumer work
  // after the last response is expected and already excluded from samples.
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
}

// ---- verdict vs spec 03 §10 -----------------------------------------------
const T = (v, op, target) => ({ value: v, target, pass: op === "<" ? v < target : v === target });
const p = results.phases;
results.targets = {
  webhook_p95_lt_300ms: p.webhook ? T(p.webhook.p95, "<", 300) : "not measured",
  api_reads_p95_lt_500ms: p.reads ? T(p.reads.p95, "<", 500) : "not measured",
  policy_lt_50ms: p.policy ? T(p.policy.p95, "<", 50) : "not measured",
  risk_lt_50ms: p.risk ? T(p.risk.p95, "<", 50) : "not measured",
  zero_duplicate_financial_actions: p.duplicates ? T(p.duplicates.zero_duplicate_financial_actions, "===", true) : "not measured",
};

console.log(JSON.stringify(results, null, 2));
if (OUT !== "none") {
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.error(`load-lite: wrote ${OUT}`);
}
process.exit(0);
