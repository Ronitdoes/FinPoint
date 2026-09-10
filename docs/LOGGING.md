# Log Pipeline & Case Tracing (s-34)

Structured JSON is the only log shape in this repo (pino via
`@repo/observability`; CONVENTIONS §7). This page records how those logs
reach an operator in staging/prod and the saved queries that answer Pillar
D's "why did the system stop?" for one case.

## 1. Pipeline

```text
backend/worker pino JSON (stdout)
  → Docker json-file driver (local: `docker compose logs`)
  → Promtail (staging/prod, `clients.url=http://loki:3100/loki/api/v1/push`)
  → Loki (:3100, config infra/loki/loki-config.yml)
  → Grafana Explore (Loki datasource to add beside Prometheus in
     infra/grafana/provisioning/datasources/datasources.yaml at staging
     provisioning time)
```

- **Local:** Loki already runs in compose (`arr-loki`); ship via stdout and
  query with `docker compose logs backend | <jq filter>`.
- **Correlation keys preserved end-to-end** (CONVENTIONS §11): every record
  carries `correlation_id`, `tenant_id`, and — when in a recovery context —
  `event_id`, `case_id`, `workflow_id`, `decision_id`, `action_id`, plus
  OTel `trace_id`/`span_id`. Promtail maps them to Loki labels
  (`correlation_id`, `tenant_id`, `case_id`) with the remainder as detected
  fields — never dropped, never renamed.
- **Redaction at the edge:** pino redacts `sk_*`, `whsec_*`, API keys,
  tokens, and non-allowlisted PII before emission (deny-by-default); the
  Loki `limits_config` additionally caps label cardinality (12 labels max)
  so a tenant cohort — never a raw UUID, email, or phone — is the largest
  identity key in storage. Runbooks contain rotation references only, never
  secrets.

## 2. Saved queries — "trace this case_id across logs"

Replace `<CASE_ID>` (e.g. `RC-0007` resolves to its UUID via the case API
first; prefer the UUID `case_id`).

```logql
# A. Whole journey for one case (all services, oldest first)
{app="revenue-recovery"} | json | case_id="<CASE_ID>"

# B. Journey + its correlation chain (webhook → risk → AI → policy → workflow)
{app="revenue-recovery"} | json
  | case_id="<CASE_ID>" or correlation_id="<CORRELATION_ID>"

# C. Only state transitions and money movement for the case
{app="revenue-recovery"} | json
  | case_id="<CASE_ID>" and (msg=~"transition|outcome|attribut|payment.*success|policy.*REJECT")

# D. Errors and warnings for the case (needs action)
{app="revenue-recovery"} | json
  | case_id="<CASE_ID>" and level=~"error|warn"

# E. Prove "no duplicate financial action" for the case under load
{app="revenue-recovery"} | json
  | case_id="<CASE_ID>" and msg=~"idempotency|duplicate|EXECUTING|claim"
  | count_over_time([1h])

# F. Local equivalent without Loki (same key discipline, jq)
docker compose -f infra/docker/docker-compose.yml logs backend --no-log-prefix \
  | jq -c 'select(.case_id=="<CASE_ID>") | {t:.time,lvl:.level,msg:.msg,action:.action_id,decision:.decision_id}'
```

## 3. Procedure (also referenced by every runbook's Diagnosis §1)

1. Resolve the human case number to `case_id` UUID
   (`GET /cases?case_number=RC-xxxx`).
2. Run query **A**; note the `correlation_id` of the first record.
3. Run query **B** to pull the full cross-service chain (bus hops share the
   correlation id, not just the case id).
4. Narrow with **C**/**D**; cross-check money against `GET /cases/:id/outcome`
   (authoritative ledger, never log text).
5. Paste the query + time range into the incident ticket and link it from
   the runbook's lifecycle footer.
