# Runbook: DiskFills (warn — ops hygiene)

**Alert:** `DiskFills` — `min(disk_free_ratio) < 0.10` for 15m.
**Severity:** warn · **Owner:** Platform on-call.
**Dashboards:** [Infrastructure](../../infra/grafana/dashboards/infra.json) (disk free panel by mountpoint).

## Symptoms

- A volume under 10% free. Postgres WAL/segments, Loki chunks, or Prometheus TSDB retention are the usual tenants of a full disk here — a full PG disk halts ALL writes (outcomes, audit, cases).

## Diagnosis

1. Which mountpoint? `disk_free_ratio{mountpoint}` — data volume vs WAL vs logs determines the safe lever.
2. Growth rate: disk usage slope over 7d — sudden (runaway logs/WAL, a stuck retention job) vs gradual (retention windows too generous for the volume).
3. Check retention jobs first: audit-retention archive pass, Loki `retention`/`compactor` config, Prometheus `--storage.tsdb.retention.time` — a silently failing retention job looks exactly like organic growth.

## Mitigation

- Postgres data: run the audit-retention archive (`AuditRetentionJob`, `docs/deploy/crons.md`); checkpoint + WAL archive; expand the volume if the growth is legitimate business data.
- Loki/Prometheus: tighten retention windows (config change, documented in the ticket); delete only time-ranged blocks, never the head block.
- Never delete WAL segments by hand on a running primary — use archiving/checkpointing or fail over first.

## Escalation

- Free <5% on the Postgres volume ⇒ page Platform lead immediately (write halt imminent); stop non-essential writers (pause demo/simulator traffic) to buy headroom.

*Lifecycle: firing → acknowledged → mitigated (free % + cause recorded) → postmortem-link only on recurrence.*
