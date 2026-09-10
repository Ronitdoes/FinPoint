# Runbook: TemporalWorkerPollers (page — execution halted!)

**Alert:** `TemporalWorkerPollers` — `temporal_worker_pollers == 0` for 5m on `recovery-main`.
**Severity:** page · **Owner:** Platform on-call.
**Dashboards:** [Infrastructure](../../infra/grafana/dashboards/infra.json) (pollers/activity slots), [Temporal UI](http://localhost:8080).
**Logs:** worker container logs (`docker compose logs worker` / platform scheduler logs).

## Symptoms

- Durable execution halted: no workflow can progress; `WorkflowFailureRate` may follow (timeouts), cases stall in-flight. This is the "why did the system stop?" alert — treat as SEV-1.

## Diagnosis

1. Is the Temporal **server** reachable? `temporal` container healthy? `tctl`/UI responds? If server down ⇒ §3a.
2. Is the **worker process** running? Compose: `arr-worker` present (needs `--profile worker` locally; always-on in staging/prod). Platform: scheduler shows the worker deployment at desired replicas? If worker down ⇒ §3b.
3. Did pollers drain from overload? `temporal_activity_slots_available == 0` with pollers >0 previously ⇒ slot exhaustion, not absence (scale, don't restart).
4. Check worker boot logs for loud-fail config errors (`FATAL: missing required config`, s-33 entrypoint) — a bad env push kills every replica identically.

## Mitigation

- **3a (server):** restore Temporal (restart container / fail over per platform); workflows resume from event history — no manual restarts.
- **3b (worker):** redeploy/restart the worker deployment (same unified image, `command: ["worker"]`); confirm pollers >0 in Grafana and workers visible in Temporal UI → resolve.
- Verify: `temporal_worker_pollers >= 1` for 10m + a canary case progresses (`GET /cases/:id/timeline` shows fresh events).

## Escalation

- Server data loss suspected (never observed; Temporal persists to Postgres) ⇒ page Backend lead; PITR is owner-approved last resort (`docs/deploy/rollback.md`), never automated.

*Lifecycle: firing → acknowledged → mitigated → postmortem-link (required).*
