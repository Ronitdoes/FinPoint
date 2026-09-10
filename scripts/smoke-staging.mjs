/**
 * Staging smoke: journey-lite post-deploy probe (Step 33 §Observability).
 *
 * Subset of the s-32 journeys tagged @smoke, runnable against a live
 * staging URL with zero credentials. Fails the deploy pipeline on any red
 * check so a bad deploy never goes unnoticed.
 *
 * Env:
 *   SMOKE_BASE_URL      (required) e.g. https://api-staging.example.com
 *   SMOKE_EXPECT_SHA    (optional) exact GIT_SHA the deploy should serve;
 *                       verified against GET /version (proves the new tag
 *                       is actually live, not the previous replica set).
 *   SMOKE_STRICT_PROD_SHAPE (optional, default "true") when true, /demo/*
 *                       must be ABSENT (404) — proof of prod-shape.
 *
 * Checks (@smoke):
 *   1. GET /health → 200 { status: "ok" }            (LB liveness target)
 *   2. GET /ready  → 200 { isReady: true }           (readiness gate)
 *   3. GET /version → 200 + sha match (when expected)
 *   4. GET /metrics → 200 Prometheus exposition
 *   5. GET /cases (no auth) → 401                    (RBAC-negative probe)
 *   6. POST /demo/payment-fail (no auth) → 404 in prod-shape
 *
 * Usage: `SMOKE_BASE_URL=https://... bun scripts/smoke-staging.mjs`
 * Exit code: 0 all green, 1 any failure.
 */
const BASE_URL = (process.env.SMOKE_BASE_URL || "").replace(/\/+$/, "");
const EXPECT_SHA = process.env.SMOKE_EXPECT_SHA || "";
const STRICT_PROD_SHAPE = (process.env.SMOKE_STRICT_PROD_SHAPE ?? "true") === "true";

if (!BASE_URL) {
  console.error("smoke-staging: FAIL — SMOKE_BASE_URL is required.");
  process.exit(1);
}

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`smoke-staging: ok — ${name}${detail ? ` (${detail})` : ""}`);
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.message || err) });
    console.error(`smoke-staging: FAIL — ${name}: ${err?.message || err}`);
  }
}

async function getJson(path, init) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON is fine for /metrics; callers decide.
  }
  return { status: res.status, body, text };
}

await check("GET /health returns ok", async () => {
  const { status, body } = await getJson("/health");
  if (status !== 200 || body?.status !== "ok") {
    throw new Error(`expected 200 {status:ok}, got ${status}`);
  }
  return `uptime=${body.uptime}s`;
});

await check("GET /ready reports ready", async () => {
  const { status, body } = await getJson("/ready");
  if (status !== 200 || body?.isReady !== true) {
    throw new Error(
      `expected 200 {isReady:true}, got ${status} ${JSON.stringify(body?.checks || body)}`,
    );
  }
  return `checks=${JSON.stringify(body.checks)}`;
});

await check("GET /version serves expected build", async () => {
  const { status, body } = await getJson("/version");
  if (status !== 200 || !body?.version) {
    throw new Error(`expected 200 with version, got ${status}`);
  }
  if (EXPECT_SHA && body.gitSha !== EXPECT_SHA) {
    throw new Error(
      `sha mismatch: serving ${body.gitSha}, expected ${EXPECT_SHA} (stale replicas?)`,
    );
  }
  return `version=${body.version} sha=${body.gitSha} env=${body.env}`;
});

await check("GET /metrics exposes Prometheus text", async () => {
  const { status, text } = await getJson("/metrics");
  if (status !== 200 || !/http_requests_total|process_cpu_seconds_total/.test(text)) {
    throw new Error(`expected 200 with metric families, got ${status}`);
  }
  return "metric families present";
});

await check("GET /cases without auth is rejected (401)", async () => {
  const { status } = await getJson("/cases?limit=1");
  if (status !== 401) {
    throw new Error(`expected 401, got ${status} (RBAC-negative probe failed)`);
  }
  return "unauthenticated read blocked";
});

await check("prod-shape: /demo routes absent (404)", async () => {
  const { status } = await getJson("/demo/payment-fail", { method: "POST" });
  if (status === 404) {
    return "demo routes omitted (prod-shape confirmed)";
  }
  if (!STRICT_PROD_SHAPE) {
    return `demo route answered ${status} (non-strict mode: staging drill shape?)`;
  }
  throw new Error(
    `expected 404 (demo routes omitted in prod-shape), got ${status}`,
  );
});

const failed = results.filter((r) => !r.ok);
console.log(
  `smoke-staging: ${results.length - failed.length}/${results.length} checks green against ${BASE_URL}`,
);
if (failed.length > 0) {
  process.exit(1);
}
