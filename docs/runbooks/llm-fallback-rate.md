# Runbook: LLMFallbackRate (warn — degraded autonomy mode)

**Alert:** `LLMFallbackRate` — fallbacks >30% of LLM calls over 30m.
**Severity:** warn · **Owner:** AI Platform on-call.
**Dashboards:** [AI](../../infra/grafana/dashboards/ai.json) (fallback rate, fallbacks by reason, latency p50/p95, token rate).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query D with `llm.model`.

## Symptoms

- System running on deterministic fallbacks: bounded autonomy HOLDS (policy layer unchanged — the LLM only ever recommends), but decision quality is rule-based, not model-based.

## Diagnosis

1. Fallback reason split: `sum by (reason) (rate(fallback_total[5m]))` — `timeout` (model slow/down), `circuit_open` (breaker tripped after 5 failures/60s — check what tripped it), `validation`/`repair-exhausted` (model emitting off-schema — prompt/model mismatch), `simulate` (someone left `SIMULATE_LLM_FAILURE` on — check demo/injection state first, it's the cheapest cause).
2. Model-side: `llm_latency_ms` p95 (hitting the 20s timeout?), `llm_calls_total{status="error"}` rate, provider (OpenAI-compatible endpoint) status.
3. Cost check: `llm_tokens_total` rate — retries multiply cost; the pricing table (`s-15`) keeps accounting exact even during the storm.

## Mitigation (degraded-mode doctrine)

1. Set the **degraded-mode banner**: dashboard Settings → ops toggle ON ("operating on deterministic fallbacks") — required within 30m of sustained firing so operators stop expecting model-quality decisions.
2. Fix the cause: clear accidental simulation flags; wait out / escalate model-provider incidents (bounded retries already protect spend); for schema drift, roll the prompt version back (`docs/PROMPT_EVALUATION.md` — eval gate must pass before re-promoting).
3. Breaker resets itself after cooldown on success — do NOT force-close it; verify fallback rate <10% for 1h, then clear the banner.

## Escalation

- Fallback rate >80% (effectively no model) for 1h ⇒ page AI Platform lead; freeze prompt deploys.
- Cost spike accompanying the storm ⇒ notify Finance (token burn is metered per decision).

*Lifecycle: firing → acknowledged (banner set) → mitigated (banner cleared + rate normal) → postmortem-link.*
