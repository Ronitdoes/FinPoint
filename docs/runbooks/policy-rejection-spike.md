# Runbook: PolicyRejectionSpike (warn)

**Alert:** `PolicyRejectionSpike` — rejection rate >3× the trailing baseline (with 0.05 rps floor) for 15m.
**Severity:** warn · **Owner:** AI Platform on-call (primary) · Policy owner (secondary).
**Dashboards:** [AI](../../infra/grafana/dashboards/ai.json) (evaluations by result), [Operations](../../infra/grafana/dashboards/operations.json) (rejection rate).
**Logs:** [`docs/LOGGING.md`](../LOGGING.md) query C filtered to policy evaluations.

## Symptoms

- Something changed upstream of enforcement: a misbehaving recommender (AI proposing out-of-bounds actions) or a bad rule deploy (over-strict rules rejecting the normal stream).

## Diagnosis

1. Which rules? `sum by (rule_code, reason) (rate(policy_rejections_total[15m]))` top-k over 15m. One rule dominating ⇒ rule-side; spread across rules ⇒ recommender-side. (Aggregate alert uses `policy_evaluations_total{result="REJECTED"}`; per-rule drill-down needs `policy_rejections_total`, which carries `rule_code`/`reason` labels.)
2. Rule-side: correlate with the latest `policy_versions` row (`GET /policies/:id/versions`) — who deployed what, when. Diff the AST against the previous version.
3. Recommender-side: check `GET /ai/decisions` recent items — confidence distribution shift, new prompt version without eval-gate evidence (`docs/PROMPT_EVALUATION.md`), or a model change emitting novel action shapes.
4. Blast radius: funnel `POLICY_REVIEW` pile-up (`case_funnel_total`) and approval-queue growth (over-rejection can starve automation into manual review).

## Mitigation

- Bad rule deploy ⇒ roll back to the previous immutable `policy_versions` snapshot (append-only ledger — never edit in place); rejections should revert within minutes.
- Recommender drift ⇒ pin/rollback the prompt version; re-run the eval gate (`@repo/eval`, must pass validity + must_not checks) before re-promoting.
- Never "fix" a spike by loosening caps (discount/contact/retry) without a policy review — caps are the bounded-autonomy boundary.

## Escalation

- Rejections blocking >50% of decisions (automation effectively halted) ⇒ page AI Platform lead.
- Suspected prompt-injection shaping recommendations ⇒ Security notify + freeze AI deploys.

*Lifecycle: firing → acknowledged → mitigated (rule/prompt version noted) → postmortem-link.*
