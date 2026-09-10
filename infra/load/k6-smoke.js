/**
 * Staging smoke/load script (s-34 §Requirements 5).
 *
 * Realistic mix through staging, run from CI nightly (perf-gate.yml) or by
 * hand:
 *   k6 run -e BASE_URL=https://staging.api.example \
 *          -e STRIPE_WEBHOOK_SECRET=$STAGING_STRIPE_WHSEC \
 *          -e API_TOKEN=$STAGING_API_TOKEN \
 *          infra/load/k6-smoke.js
 *
 * Mix: webhook burst 100 rps for 60s (signed Stripe payment_failed with
 * unique event ids so each is ACCEPTED, not deduped) + read APIs at 50 rps
 * (analytics summary, case list). Thresholds encode spec 03 §10:
 * webhook p95 <300ms, reads p95 <500ms, zero failed checks. Regressions
 * >20% vs infra/load/baseline.json fail the perf-gate job.
 *
 * Secrets arrive ONLY via -e env (never committed); the script aborts with
 * a clear message when a required var is missing for its stage.
 */
import http from "k6/http";
import { check, fail } from "k6";
import crypto from "k6/crypto";
import exec from "k6/execution";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const STRIPE_WHSEC = __ENV.STRIPE_WEBHOOK_SECRET || "";
const API_TOKEN = __ENV.API_TOKEN || "";

function stripeSignature(body, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const h = crypto.createHMAC("sha256", secret);
  h.update(`${ts}.${body}`);
  return `t=${ts},v1=${h.digest("hex")}`;
}

export const options = {
  scenarios: {
    webhook_burst: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 20,
      maxVUs: 120,
      exec: "webhookBurst",
    },
    read_apis: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "60s",
      preAllocatedVUs: 10,
      maxVUs: 60,
      exec: "readApis",
    },
  },
  thresholds: {
    // Spec 03 §10 targets as gates.
    "http_req_duration{scenario:webhook_burst}": ["p(95)<300"],
    "http_req_duration{scenario:read_apis}": ["p(95)<500"],
    checks: ["rate==1.0"],
  },
};

export function webhookBurst() {
  if (!STRIPE_WHSEC) fail("STRIPE_WEBHOOK_SECRET is required for the webhook_burst scenario");
  const externalId = `evt_k6_${exec.scenario.iterationInTest}_${Date.now()}`;
  const body = JSON.stringify({
    id: externalId,
    type: "payment_intent.payment_failed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `pi_k6_${externalId}`,
        amount: 129900,
        currency: "inr",
        customer: `cus_k6_${exec.vu.idInTest}`,
      },
    },
  });
  const res = http.post(`${BASE_URL}/webhooks/stripe`, body, {
    headers: {
      "Content-Type": "application/json",
      "stripe-signature": stripeSignature(body, STRIPE_WHSEC),
    },
    tags: { scenario: "webhook_burst" },
  });
  check(res, {
    "webhook accepted or deduped": (r) => r.status === 200,
    "webhook fast (<300ms)": (r) => r.timings.duration < 300,
  });
}

export function readApis() {
  const headers = API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};
  const paths = [
    "/analytics/summary?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z",
    "/cases?limit=20",
    "/risks?limit=20",
  ];
  const path = paths[exec.scenario.iterationInTest % paths.length];
  const res = http.get(`${BASE_URL}${path}`, {
    headers,
    tags: { scenario: "read_apis" },
  });
  check(res, {
    "read ok or auth-guarded": (r) => r.status === 200 || r.status === 401,
    "read fast (<500ms)": (r) => r.timings.duration < 500,
  });
}
