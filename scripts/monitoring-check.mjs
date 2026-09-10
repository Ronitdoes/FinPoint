/**
 * Monitoring-as-code gate (s-34 §Tests).
 *
 * Validates without Prometheus/Grafana running:
 *  1. rules.yml: exact 14-alert set, no duplicates, thresholds match the
 *     step spec, every alert names an existing reviewed runbook.
 *  2. Metric references: every key series in an alert/dashboards expression
 *     is actually exported (packages/observability registry, pushgateway KPI
 *     job, or a documented external exporter) — catches metric-name typos.
 *  3. Dashboards: 4 files, valid JSON, uid/title/panels, Prometheus
 *     datasource, no unknown metrics.
 *  4. Wiring: prometheus.yml scrapes backend + pushgateway and loads
 *     rules.yml; alertmanager.yml has the page/ticket/warn receivers.
 *  5. Label PII audit: no tenant_id/case_id/email/phone/customer_id label
 *     anywhere in rules, dashboards, or scrape config (CONVENTIONS §12).
 *
 * Usage: `bun scripts/monitoring-check.mjs [--perf-baseline path --perf-results path --tolerance 0.2]`
 * The optional perf comparison enforces the >20% regression rule for the
 * nightly gate (compares p95-class fields of two load-lite result files).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const RULES = "infra/prometheus/rules.yml";
const PROM = "infra/prometheus/prometheus.yml";
const AM = "infra/prometheus/alertmanager.yml";
const DASH_DIR = "infra/grafana/dashboards";

let failures = 0;
function fail(msg) {
  console.error(`monitoring-check: FAIL — ${msg}`);
  failures += 1;
}
function pass(msg) {
  console.log(`monitoring-check: ok — ${msg}`);
}
function read(rel) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    fail(`${rel} is missing.`);
    return null;
  }
  return readFileSync(abs, "utf8");
}

// ---- 0. registry metric names ---------------------------------------------
const metricsSrc = read("packages/observability/src/metrics.ts") ?? "";
const registryNames = new Set(
  [...metricsSrc.matchAll(/name:\s*"([a-z_:][a-z0-9_:]*)"/g)].map((m) => m[1]),
);
// External/documented series (exporters, pushgateway job metadata, prom internals).
const externalNames = new Set([
  "up",
  "push_time_seconds",
  // node_exporter / redis_exporter / postgres_exporter series referenced only
  // in prose/panels via standard jobs; s-34 gauges (disk_free_ratio,
  // cert_expiry_days, redis_memory_ratio) are app-emitted and in the registry.
]);

function metricBase(token) {
  // histogram_quantile(..._bucket) and derived _count/_sum map to the base.
  for (const suffix of ["_bucket", "_count", "_sum"]) {
    if (token.endsWith(suffix)) return token.slice(0, -suffix.length);
  }
  return token;
}

const PROMQL_FUNCTIONS = new Set(
  "absent,absent_over_time,avg_over_time,avg,min_over_time,min,max_over_time,max,sum_over_time,sum,count_over_time,count,rate,irate,increase,delta,deriv,predict_linear,histogram_quantile,histogram_sum,histogram_count,histogram_fraction,clamp_min,clamp_max,clamp,ceil,floor,round,sqrt,abs,ln,log2,log10,exp,time,timestamp,vector,scalar,sort,sort_desc,topk,bottomk,limit_count,limit_ratio,label_replace,label_join,changes,resets,minute,hour,day_of_week,day_of_month,days_in_month,month,year".split(","),
);

function assertKnownMetrics(where, expr) {
  // Strip string literals first (label values like "invalid_signature" or
  // "staging" are not metric references).
  const code = expr.replace(/"[^"]*"/g, '""');
  // Candidate metric tokens: lowercase words possibly containing _ : and digits.
  const tokens = new Set(
    [...code.matchAll(/\b([a-z_][a-z0-9_:]*)\b/g)]
      .map((m) => m[1])
      .filter((t) => !PROMQL_FUNCTIONS.has(t))
      .filter(
        (t) =>
          ![
            "by", "without", "on", "ignoring", "group_left", "group_right",
            "and", "or", "unless", "offset", "bool", "job", "le", "tenant",
            "group", "provider", "status", "op", "method", "reason", "result",
            "type", "queue", "mountpoint", "host", "kind", "model", "stage",
            "route", "topic", "tenant_id",
          ].includes(t),
      ),
  );
  for (const token of tokens) {
    if (token.includes(":")) continue; // recording-rule style / urls — none expected
    if (!token.includes("_")) continue; // function names, keywords
    const base = metricBase(token);
    if (registryNames.has(base) || registryNames.has(token) || externalNames.has(base)) continue;
    // pushgateway job label values, not metrics:
    if (["arr", "kpi", "staging", "prod", "local"].includes(token)) continue;
    fail(`${where}: unknown metric '${token}' (base '${base}') — not exported by @repo/observability.`);
  }
}

// ---- 1. rules ---------------------------------------------------------------
const EXPECTED_ALERTS = {
  WebhookErrorRate: { severity: "page", threshold: "0.02", runbook: "webhook-error-rate.md" },
  P95WebhookLatency: { severity: "warn", threshold: "300", runbook: "p95-webhook-latency.md" },
  BusDLQDepth: { severity: "ticket", threshold: "bus_dlq_depth", runbook: "bus-dlq-depth.md" },
  WorkflowFailureRate: { severity: "page", threshold: "0.01", runbook: "workflow-failure-rate.md" },
  TemporalWorkerPollers: { severity: "page", threshold: "== 0", runbook: "temporal-worker-pollers.md" },
  RecoveredAmountDrop: { severity: "warn", threshold: "0.5", runbook: "recovered-amount-drop.md" },
  ProviderFailureRate: { severity: "page", threshold: "0.10", runbook: "provider-failure-rate.md" },
  LLMFallbackRate: { severity: "warn", threshold: "0.30", runbook: "llm-fallback-rate.md" },
  PolicyRejectionSpike: { severity: "warn", threshold: "3 *", runbook: "policy-rejection-spike.md" },
  DBPoolSaturation: { severity: "warn", threshold: "0.8", runbook: "db-pool-saturation.md" },
  AuditWriteFailures: { severity: "page", threshold: "audit_write_failures_total", runbook: "audit-write-failures.md" },
  CertExpiry: { severity: "warn", threshold: "14", runbook: "cert-expiry.md" },
  DiskFills: { severity: "warn", threshold: "0.10", runbook: "disk-fills.md" },
  MonitoringPipelineDown: { severity: "page", threshold: "up{", runbook: "monitoring-pipeline-down.md" },
};

const rulesSrc = read(RULES);
if (rulesSrc) {
  const blocks = rulesSrc.split(/\n\s+- alert: /).slice(1);
  const names = blocks.map((b) => b.split("\n", 1)[0].trim());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) fail(`duplicate alert names: ${[...new Set(dupes)].join(", ")}`);
  const missing = Object.keys(EXPECTED_ALERTS).filter((n) => !names.includes(n));
  const extra = names.filter((n) => !(n in EXPECTED_ALERTS));
  if (missing.length > 0) fail(`missing alerts: ${missing.join(", ")}`);
  if (extra.length > 0) fail(`unexpected alerts (keep the set exact): ${extra.join(", ")}`);
  if (missing.length === 0 && extra.length === 0 && dupes.length === 0) {
    pass(`alert set exact (${names.length} alerts, no duplicates).`);
  }
  for (const [name, spec] of Object.entries(EXPECTED_ALERTS)) {
    const block = blocks.find((b) => b.startsWith(name + "\n") || b === name);
    if (!block) continue;
    if (!block.includes(`severity: ${spec.severity}`)) {
      fail(`${name}: expected severity '${spec.severity}'.`);
    }
    if (!block.includes(spec.threshold)) {
      fail(`${name}: threshold marker '${spec.threshold}' not found in expr.`);
    }
    const rbMatch = block.match(/runbook_url:\s*"([^"]+)"/);
    if (!rbMatch) {
      fail(`${name}: missing runbook_url annotation.`);
      continue;
    }
    const rbRel = rbMatch[1].replace(/^docs\//, "docs/");
    const rbAbs = join(REPO_ROOT, rbRel.startsWith("docs/") ? rbRel : `docs/runbooks/${rbRel}`);
    if (!existsSync(rbAbs)) {
      fail(`${name}: runbook file missing: ${rbMatch[1]}.`);
      continue;
    }
    const rb = readFileSync(rbAbs, "utf8");
    if (!/Owner:/.test(rb)) fail(`${name}: runbook has no Owner line.`);
    if (/TBD/.test(rb)) fail(`${name}: runbook contains TBD (must name a real owner).`);
    const expr = (block.match(/expr: \|([\s\S]*?)\n\s+for:/) ?? [])[1] ?? "";
    assertKnownMetrics(`alert ${name}`, expr);
  }
  pass("every alert names a reviewed runbook (owner set, no TBD).");
}

// ---- 2. dashboards ------------------------------------------------------------
const EXPECTED_DASHBOARDS = {
  "executive.json": { uid: "arr-executive", metrics: ["kpi_revenue_at_risk_minor", "kpi_revenue_recovered_minor", "kpi_recovery_rate", "kpi_net_recovered_minor", "kpi_active_cases", "kpi_escalations_total"] },
  "operations.json": { uid: "arr-operations", metrics: ["webhook_deliveries_total", "webhook_duration_ms", "bus_dlq_depth", "workflow_started_total", "provider_calls_total", "policy_evaluations_total"] },
  "ai.json": { uid: "arr-ai", metrics: ["llm_latency_ms", "llm_tokens_total", "fallback_total", "human_tasks_open", "approval_oldest_age_seconds"] },
  "infra.json": { uid: "arr-infra", metrics: ["http_requests_total", "db_pool_saturation_ratio", "redis_memory_ratio", "temporal_worker_pollers", "cert_expiry_days", "disk_free_ratio"] },
};

for (const [file, spec] of Object.entries(EXPECTED_DASHBOARDS)) {
  const raw = read(`${DASH_DIR}/${file}`);
  if (raw === null) continue;
  let dash;
  try {
    dash = JSON.parse(raw);
  } catch (err) {
    fail(`${file}: invalid JSON (${err.message}).`);
    continue;
  }
  if (dash.uid !== spec.uid) fail(`${file}: uid must be '${spec.uid}'.`);
  if (!Array.isArray(dash.panels) || dash.panels.length === 0) {
    fail(`${file}: no panels.`);
    continue;
  }
  const exprs = [];
  for (const panel of dash.panels) {
    for (const target of panel.targets ?? []) {
      if (target.expr) exprs.push(target.expr);
    }
    const ds = panel.datasource;
    if (ds && ds.uid !== "prometheus" && ds.type !== "prometheus") {
      fail(`${file}: panel '${panel.title}' must use the Prometheus datasource.`);
    }
  }
  const joined = exprs.join("\n");
  for (const metric of spec.metrics) {
    if (!joined.includes(metric)) fail(`${file}: required metric '${metric}' not referenced by any panel.`);
  }
  assertKnownMetrics(`dashboard ${file}`, joined);
}
pass("four dashboards valid with required panels and known metrics.");

// ---- 3. wiring ------------------------------------------------------------------
const promSrc = read(PROM);
if (promSrc) {
  for (const job of ['"arr-backend"', '"pushgateway"']) {
    if (!promSrc.includes(`job_name: ${job}`)) fail(`prometheus.yml: missing scrape job ${job}.`);
  }
  if (!promSrc.includes("rules.yml")) fail("prometheus.yml: must load rules.yml via rule_files.");
}
const amSrc = read(AM);
if (amSrc) {
  for (const receiver of ['"paging-staging"', '"slack-warn"', '"ticket-and-slack"']) {
    if (!amSrc.includes(`name: ${receiver}`)) fail(`alertmanager.yml: missing receiver ${receiver}.`);
  }
  if (!amSrc.includes('severity = "page"')) fail("alertmanager.yml: missing page routing.");
}
pass("prometheus + alertmanager wiring present.");

// ---- 4. PII label audit ------------------------------------------------------------
const scanned = [
  ["rules", rulesSrc ?? ""],
  ["prometheus", promSrc ?? ""],
  ["alertmanager", amSrc ?? ""],
];
for (const [file, spec] of Object.entries(EXPECTED_DASHBOARDS)) {
  scanned.push([`dashboards/${file}`, read(`${DASH_DIR}/${file}`) ?? ""]);
}
const FORBIDDEN = ["tenant_id", "case_id", "customer_id", "event_id", "decision_id", "action_id", "email", "phone"];
for (const [where, content] of scanned) {
  for (const token of FORBIDDEN) {
    // Allow prose mentions in comments/descriptions of rules.yml only for
    // tenant_id inside descr/help? No — labels only. Flag `{...token...}`
    // label usage and bare label keys.
    const labelUse = new RegExp(`[{,]\\s*${token}\\s*=|\\b${token}:`, "g");
    if (labelUse.test(content)) {
      fail(`${where}: forbidden PII label/key '${token}' in monitoring config.`);
    }
  }
}
pass("label PII audit clean (no tenant/case/customer/PII keys in labels).");

// ---- 5. optional perf regression ------------------------------------------------------
const cli = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (!a.startsWith("--")) return [];
    const eq = a.indexOf("=");
    if (eq > 0) return [[a.slice(2, eq), a.slice(eq + 1)]];
    const next = arr[i + 1];
    return [[a.slice(2), next && !next.startsWith("--") ? next : "true"]];
  }),
);

if (cli["perf-baseline"] && cli["perf-results"]) {
  const tolerance = Number(cli.tolerance ?? 0.2);
  const base = JSON.parse(readFileSync(resolve(REPO_ROOT, cli["perf-baseline"]), "utf8"));
  const cur = JSON.parse(readFileSync(resolve(REPO_ROOT, cli["perf-results"]), "utf8"));
  const fields = [
    ["phases", "webhook", "p95"],
    ["phases", "reads", "p95"],
    ["phases", "policy", "p95"],
    ["phases", "risk", "p95"],
  ];
  for (const [a, b, c] of fields) {
    const bv = base?.[a]?.[b]?.[c];
    const cv = cur?.[a]?.[b]?.[c];
    if (typeof bv !== "number" || typeof cv !== "number" || bv <= 0) {
      fail(`perf regression: incomparable field ${a}.${b}.${c} (baseline=${bv}, current=${cv}).`);
      continue;
    }
    const ratio = cv / bv;
    if (ratio > 1 + tolerance) {
      fail(`perf regression: ${a}.${b}.${c} regressed ${(100 * (ratio - 1)).toFixed(1)}% (baseline ${bv} → ${cv}, tolerance ${tolerance * 100}%).`);
    } else {
      pass(`perf ${a}.${b}.${c}: ${cv} vs baseline ${bv} (Δ${(100 * (ratio - 1)).toFixed(1)}%).`);
    }
  }
  const bd = base?.phases?.duplicates;
  const cd = cur?.phases?.duplicates;
  if (bd && cd && cd.accepted !== 1) {
    fail(`perf regression: duplicate storm accepted=${cd.accepted}, expected exactly 1.`);
  }
}

if (failures > 0) {
  console.error(`monitoring-check: ${failures} failure(s).`);
  process.exit(1);
}
console.log("monitoring-check: PASS — monitoring-as-code green.");
