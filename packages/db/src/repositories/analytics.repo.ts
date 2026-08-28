import { sql } from "drizzle-orm";
import { type RepoContext, getExecutor } from "./types";

export interface AnalyticsDateRangeFilter {
  tenantId: string;
  from?: Date;
  to?: Date;
}

export interface AnalyticsSummaryResult {
  revenue_at_risk_minor: bigint;
  revenue_recovered_minor: bigint;
  recovery_rate_bps: number;
  recovery_cost_minor: bigint;
  net_recovered_minor: bigint;
  recovery_roi_bps: number | null;
  currency: string;
  active_cases: number;
  escalations: number;
  avg_time_to_recovery_seconds: number;
}

export interface RecoveryTimeseriesItem {
  date: string;
  at_risk_minor: bigint;
  recovered_minor: bigint;
  recovery_cost_minor: bigint;
  net_minor: bigint;
}

export interface RecoveryTimeseriesResult {
  bucket: "day" | "week";
  timeseries: RecoveryTimeseriesItem[];
}

export interface InterventionPerformanceItem {
  type: string;
  cases: number;
  successes: number;
  recovered_minor: bigint;
  success_rate_bps: number;
}

export interface FunnelStageItem {
  stage: "AT_RISK" | "QUALIFIED" | "CONTACTED" | "ATTEMPTED" | "RECOVERED";
  count: number;
  amount_minor: bigint;
}

export interface RecoveryFunnelResult {
  stages: FunnelStageItem[];
  conversion_rate_bps: number;
}

export interface RiskMixItem {
  risk_type: string;
  risk_band: string;
  count: number;
  amount_at_risk_minor: bigint;
}

export interface AiPerformanceResult {
  decisions: number;
  decision_acceptance_rate_bps: number;
  recommendation_to_exec_rate_bps: number;
  policy_rejections: number;
  policy_rejection_rate_bps: number;
  approvals_required: number;
  avg_decision_ms: number;
  cost_per_case_minor: bigint;
  cost_per_recovered_bps: number;
  total_ai_cost_minor: bigint;
}

/**
 * Computes authoritative financial and operational cards for the executive summary (Step 27, Spec 00 §6, Spec 03 §7).
 */
export async function getAnalyticsSummary(
  ctx: RepoContext,
  params: AnalyticsDateRangeFilter,
): Promise<AnalyticsSummaryResult> {
  const executor = getExecutor(ctx);
  const { tenantId, from, to } = params;
  const fromIso = from ? from.toISOString() : null;
  const toIso = to ? to.toISOString() : null;

  // 1. Revenue at Risk: SUM(amount_at_risk) for cases opened in range NOT terminal-RECOVERED at query time
  const atRiskQuery = await executor.execute<{ at_risk: string }>(
    sql`
      SELECT COALESCE(SUM(amount_at_risk), 0)::text AS at_risk
      FROM recovery_cases
      WHERE tenant_id = ${tenantId}
        AND status != 'RECOVERED'
        ${fromIso ? sql`AND opened_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND opened_at <= ${toIso}::timestamptz` : sql``}
    `,
  );
  const revenueAtRiskMinor = BigInt(atRiskQuery[0]?.at_risk ?? "0");

  // 2. Financial Recovered & Cost: SUM(recovered_amount), SUM(recovery_cost), SUM(net_recovered)
  const outcomesQuery = await executor.execute<{
    recovered: string;
    cost: string;
    net: string;
    avg_recovery_seconds: string;
  }>(
    sql`
      SELECT
        COALESCE(SUM(ro.recovered_amount), 0)::text AS recovered,
        COALESCE(SUM(ro.recovery_cost), 0)::text AS cost,
        COALESCE(SUM(ro.net_recovered), 0)::text AS net,
        COALESCE(AVG(EXTRACT(EPOCH FROM (ro.recovered_at - rc.opened_at))), 0)::text AS avg_recovery_seconds
      FROM recovery_outcomes ro
      INNER JOIN recovery_cases rc ON ro.case_id = rc.id AND ro.tenant_id = rc.tenant_id
      WHERE ro.tenant_id = ${tenantId}
        ${fromIso ? sql`AND ro.recovered_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND ro.recovered_at <= ${toIso}::timestamptz` : sql``}
    `,
  );

  const revenueRecoveredMinor = BigInt(outcomesQuery[0]?.recovered ?? "0");
  const recoveryCostMinor = BigInt(outcomesQuery[0]?.cost ?? "0");
  const netRecoveredMinor = BigInt(outcomesQuery[0]?.net ?? "0");
  const avgTimeToRecoverySeconds = Math.round(
    parseFloat(outcomesQuery[0]?.avg_recovery_seconds ?? "0"),
  );

  // Recovery Rate BPS: (Recovered / AtRisk) in basis points (100% = 10000)
  const recoveryRateBps =
    revenueAtRiskMinor > 0n
      ? Number((revenueRecoveredMinor * 10000n) / revenueAtRiskMinor)
      : 0;

  // Recovery ROI BPS: (NetRecovered / Cost) in basis points
  const recoveryRoiBps =
    recoveryCostMinor > 0n
      ? Number((netRecoveredMinor * 10000n) / recoveryCostMinor)
      : null;

  // 3. Active Cases: COUNT(status IN ('QUALIFIED', 'DECISION_PENDING', 'POLICY_REVIEW', 'WAITING', 'IN_PROGRESS', 'ESCALATED'))
  const activeCasesQuery = await executor.execute<{ active_count: string }>(
    sql`
      SELECT COUNT(*)::text AS active_count
      FROM recovery_cases
      WHERE tenant_id = ${tenantId}
        AND status IN ('QUALIFIED', 'DECISION_PENDING', 'POLICY_REVIEW', 'WAITING', 'IN_PROGRESS', 'ESCALATED')
    `,
  );
  const activeCases = parseInt(activeCasesQuery[0]?.active_count ?? "0", 10);

  // 4. Escalations: count transitions into ESCALATED in range from case_events or status
  const escalationsQuery = await executor.execute<{ escalations_count: string }>(
    sql`
      SELECT COUNT(*)::text AS escalations_count
      FROM case_events
      WHERE tenant_id = ${tenantId}
        AND event_type = 'CASE_ESCALATED'
        ${fromIso ? sql`AND occurred_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND occurred_at <= ${toIso}::timestamptz` : sql``}
    `,
  );
  const escalations = parseInt(escalationsQuery[0]?.escalations_count ?? "0", 10);

  return {
    revenue_at_risk_minor: revenueAtRiskMinor,
    revenue_recovered_minor: revenueRecoveredMinor,
    recovery_rate_bps: recoveryRateBps,
    recovery_cost_minor: recoveryCostMinor,
    net_recovered_minor: netRecoveredMinor,
    recovery_roi_bps: recoveryRoiBps,
    currency: "INR",
    active_cases: activeCases,
    escalations: escalations,
    avg_time_to_recovery_seconds: avgTimeToRecoverySeconds,
  };
}

/**
 * Computes bucketed time-series data for recovery vs at-risk revenue (Step 27, Spec 02 §13).
 */
export async function getRecoveryTimeseries(
  ctx: RepoContext,
  params: AnalyticsDateRangeFilter & { bucket?: "day" | "week" },
): Promise<RecoveryTimeseriesResult> {
  const executor = getExecutor(ctx);
  const { tenantId, from, to, bucket = "day" } = params;
  const fromIso = from ? from.toISOString() : null;
  const toIso = to ? to.toISOString() : null;
  const bucketFormat = bucket === "week" ? "week" : "day";

  const rows = await executor.execute<{
    date: string;
    at_risk_minor: string;
    recovered_minor: string;
    recovery_cost_minor: string;
    net_minor: string;
  }>(
    sql`
      WITH at_risk_series AS (
        SELECT
          DATE_TRUNC(${sql.raw(`'${bucketFormat}'`)}, opened_at AT TIME ZONE 'UTC')::date AS bucket_date,
          COALESCE(SUM(amount_at_risk), 0)::text AS at_risk_minor
        FROM recovery_cases
        WHERE tenant_id = ${tenantId}
          ${fromIso ? sql`AND opened_at >= ${fromIso}::timestamptz` : sql``}
          ${toIso ? sql`AND opened_at <= ${toIso}::timestamptz` : sql``}
        GROUP BY DATE_TRUNC(${sql.raw(`'${bucketFormat}'`)}, opened_at AT TIME ZONE 'UTC')::date
      ),
      recovered_series AS (
        SELECT
          DATE_TRUNC(${sql.raw(`'${bucketFormat}'`)}, recovered_at AT TIME ZONE 'UTC')::date AS bucket_date,
          COALESCE(SUM(recovered_amount), 0)::text AS recovered_minor,
          COALESCE(SUM(recovery_cost), 0)::text AS recovery_cost_minor,
          COALESCE(SUM(net_recovered), 0)::text AS net_minor
        FROM recovery_outcomes
        WHERE tenant_id = ${tenantId}
          ${fromIso ? sql`AND recovered_at >= ${fromIso}::timestamptz` : sql``}
          ${toIso ? sql`AND recovered_at <= ${toIso}::timestamptz` : sql``}
        GROUP BY DATE_TRUNC(${sql.raw(`'${bucketFormat}'`)}, recovered_at AT TIME ZONE 'UTC')::date
      ),
      all_dates AS (
        SELECT bucket_date FROM at_risk_series
        UNION
        SELECT bucket_date FROM recovered_series
      )
      SELECT
        ad.bucket_date::text AS date,
        COALESCE(ars.at_risk_minor, '0') AS at_risk_minor,
        COALESCE(rs.recovered_minor, '0') AS recovered_minor,
        COALESCE(rs.recovery_cost_minor, '0') AS recovery_cost_minor,
        COALESCE(rs.net_minor, '0') AS net_minor
      FROM all_dates ad
      LEFT JOIN at_risk_series ars ON ad.bucket_date = ars.bucket_date
      LEFT JOIN recovered_series rs ON ad.bucket_date = rs.bucket_date
      ORDER BY ad.bucket_date ASC
    `,
  );

  const timeseries: RecoveryTimeseriesItem[] = rows.map((r) => ({
    date: r.date,
    at_risk_minor: BigInt(r.at_risk_minor ?? "0"),
    recovered_minor: BigInt(r.recovered_minor ?? "0"),
    recovery_cost_minor: BigInt(r.recovery_cost_minor ?? "0"),
    net_minor: BigInt(r.net_minor ?? "0"),
  }));

  return {
    bucket: bucketFormat as "day" | "week",
    timeseries,
  };
}

/**
 * Computes performance breakdown per recovery action / intervention type (Step 27, Spec 03 §7).
 */
export async function getInterventionPerformance(
  ctx: RepoContext,
  params: AnalyticsDateRangeFilter,
): Promise<{ items: InterventionPerformanceItem[] }> {
  const executor = getExecutor(ctx);
  const { tenantId, from, to } = params;
  const fromIso = from ? from.toISOString() : null;
  const toIso = to ? to.toISOString() : null;

  const rows = await executor.execute<{
    type: string;
    cases: string;
    successes: string;
    recovered_minor: string;
  }>(
    sql`
      SELECT
        action_type::text AS type,
        COUNT(DISTINCT case_id)::text AS cases,
        COUNT(DISTINCT CASE WHEN outcome_id IS NOT NULL THEN case_id ELSE NULL END)::text AS successes,
        COALESCE(SUM(CASE WHEN outcome_id IS NOT NULL THEN recovered_amount ELSE 0 END), 0)::text AS recovered_minor
      FROM analytics.v_intervention_performance
      WHERE tenant_id = ${tenantId}
        ${fromIso ? sql`AND (action_created_at >= ${fromIso}::timestamptz OR action_completed_at >= ${fromIso}::timestamptz)` : sql``}
        ${toIso ? sql`AND (action_created_at <= ${toIso}::timestamptz OR action_completed_at <= ${toIso}::timestamptz)` : sql``}
      GROUP BY action_type
      ORDER BY COUNT(DISTINCT case_id) DESC, action_type ASC
    `,
  );

  const items: InterventionPerformanceItem[] = rows.map((r) => {
    const cases = parseInt(r.cases ?? "0", 10);
    const successes = parseInt(r.successes ?? "0", 10);
    const recoveredMinor = BigInt(r.recovered_minor ?? "0");
    const successRateBps =
      cases > 0 ? Math.round((successes / cases) * 10000) : 0;

    return {
      type: r.type,
      cases,
      successes,
      recovered_minor: recoveredMinor,
      success_rate_bps: successRateBps,
    };
  });

  return { items };
}

/**
 * Computes the 5-stage recovery funnel progression (Step 27, Spec 03 §7).
 */
export async function getRecoveryFunnel(
  ctx: RepoContext,
  params: AnalyticsDateRangeFilter,
): Promise<RecoveryFunnelResult> {
  const executor = getExecutor(ctx);
  const { tenantId, from, to } = params;
  const fromIso = from ? from.toISOString() : null;
  const toIso = to ? to.toISOString() : null;

  const [row] = await executor.execute<{
    at_risk_count: string;
    at_risk_amount: string;
    qualified_count: string;
    qualified_amount: string;
    contacted_count: string;
    contacted_amount: string;
    attempted_count: string;
    attempted_amount: string;
    recovered_count: string;
    recovered_amount: string;
  }>(
    sql`
      SELECT
        COUNT(*)::text AS at_risk_count,
        COALESCE(SUM(amount_at_risk), 0)::text AS at_risk_amount,
        COUNT(*) FILTER (WHERE status != 'DETECTED')::text AS qualified_count,
        COALESCE(SUM(CASE WHEN status != 'DETECTED' THEN amount_at_risk ELSE 0 END), 0)::text AS qualified_amount,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.case_id = recovery_cases.id AND m.tenant_id = recovery_cases.tenant_id))::text AS contacted_count,
        COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.case_id = recovery_cases.id AND m.tenant_id = recovery_cases.tenant_id) THEN amount_at_risk ELSE 0 END), 0)::text AS contacted_amount,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM recovery_actions ra WHERE ra.case_id = recovery_cases.id AND ra.tenant_id = recovery_cases.tenant_id))::text AS attempted_count,
        COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM recovery_actions ra WHERE ra.case_id = recovery_cases.id AND ra.tenant_id = recovery_cases.tenant_id) THEN amount_at_risk ELSE 0 END), 0)::text AS attempted_amount,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM recovery_outcomes ro WHERE ro.case_id = recovery_cases.id AND ro.tenant_id = recovery_cases.tenant_id))::text AS recovered_count,
        COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM recovery_outcomes ro WHERE ro.case_id = recovery_cases.id AND ro.tenant_id = recovery_cases.tenant_id) THEN amount_at_risk ELSE 0 END), 0)::text AS recovered_amount
      FROM recovery_cases
      WHERE tenant_id = ${tenantId}
        ${fromIso ? sql`AND opened_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND opened_at <= ${toIso}::timestamptz` : sql``}
    `,
  );

  const atRiskCount = parseInt(row?.at_risk_count ?? "0", 10);
  const recoveredCount = parseInt(row?.recovered_count ?? "0", 10);

  const stages: FunnelStageItem[] = [
    {
      stage: "AT_RISK",
      count: atRiskCount,
      amount_minor: BigInt(row?.at_risk_amount ?? "0"),
    },
    {
      stage: "QUALIFIED",
      count: parseInt(row?.qualified_count ?? "0", 10),
      amount_minor: BigInt(row?.qualified_amount ?? "0"),
    },
    {
      stage: "CONTACTED",
      count: parseInt(row?.contacted_count ?? "0", 10),
      amount_minor: BigInt(row?.contacted_amount ?? "0"),
    },
    {
      stage: "ATTEMPTED",
      count: parseInt(row?.attempted_count ?? "0", 10),
      amount_minor: BigInt(row?.attempted_amount ?? "0"),
    },
    {
      stage: "RECOVERED",
      count: recoveredCount,
      amount_minor: BigInt(row?.recovered_amount ?? "0"),
    },
  ];

  const conversionRateBps =
    atRiskCount > 0 ? Math.round((recoveredCount / atRiskCount) * 10000) : 0;

  return {
    stages,
    conversion_rate_bps: conversionRateBps,
  };
}

/**
 * Computes risk mix distribution across risk types and risk bands (Step 27, Spec 00 §9).
 */
export async function getRiskMix(
  ctx: RepoContext,
  params: AnalyticsDateRangeFilter,
): Promise<{ items: RiskMixItem[] }> {
  const executor = getExecutor(ctx);
  const { tenantId, from, to } = params;
  const fromIso = from ? from.toISOString() : null;
  const toIso = to ? to.toISOString() : null;

  const rows = await executor.execute<{
    risk_type: string;
    risk_band: string;
    count: string;
    amount_at_risk_minor: string;
  }>(
    sql`
      SELECT
        risk_type::text AS risk_type,
        risk_band::text AS risk_band,
        COUNT(*)::text AS count,
        COALESCE(SUM(amount_at_risk), 0)::text AS amount_at_risk_minor
      FROM analytics.v_risk_mix
      WHERE tenant_id = ${tenantId}
        ${fromIso ? sql`AND opened_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND opened_at <= ${toIso}::timestamptz` : sql``}
      GROUP BY risk_type, risk_band
      ORDER BY COUNT(*) DESC, risk_type ASC
    `,
  );

  const items: RiskMixItem[] = rows.map((r) => ({
    risk_type: r.risk_type,
    risk_band: r.risk_band,
    count: parseInt(r.count ?? "0", 10),
    amount_at_risk_minor: BigInt(r.amount_at_risk_minor ?? "0"),
  }));

  return { items };
}

/**
 * Computes AI performance and governance autonomy metrics (Step 27, Spec 00 §9 Pillar B, Spec 03 §7).
 */
export async function getAiPerformance(
  ctx: RepoContext,
  params: AnalyticsDateRangeFilter,
): Promise<AiPerformanceResult> {
  const executor = getExecutor(ctx);
  const { tenantId, from, to } = params;
  const fromIso = from ? from.toISOString() : null;
  const toIso = to ? to.toISOString() : null;

  // 1. AI Decision aggregates
  const [decisionsSummary] = await executor.execute<{
    total_decisions: string;
    avg_latency_ms: string;
    total_llm_cost: string;
  }>(
    sql`
      SELECT
        COUNT(*)::text AS total_decisions,
        COALESCE(AVG(latency_ms), 0)::text AS avg_latency_ms,
        COALESCE(SUM(cost_minor_units), 0)::text AS total_llm_cost
      FROM ai_decisions
      WHERE tenant_id = ${tenantId}
        ${fromIso ? sql`AND created_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND created_at <= ${toIso}::timestamptz` : sql``}
    `,
  );

  const decisions = parseInt(decisionsSummary?.total_decisions ?? "0", 10);
  const avgDecisionMs = Math.round(
    parseFloat(decisionsSummary?.avg_latency_ms ?? "0"),
  );
  const totalAiCostMinor = BigInt(decisionsSummary?.total_llm_cost ?? "0");

  // 2. Decision Acceptance & Execution:
  // Recommended actions count vs executed actions
  const [actionsSummary] = await executor.execute<{
    recommended_count: string;
    executed_count: string;
  }>(
    sql`
      SELECT
        COALESCE(SUM(jsonb_array_length(recommended_actions)), 0)::text AS recommended_count,
        (
          SELECT COUNT(*)::text
          FROM recovery_actions ra
          WHERE ra.tenant_id = ${tenantId}
            AND ra.decision_id IS NOT NULL
            AND ra.status = 'EXECUTED'
            ${fromIso ? sql`AND ra.created_at >= ${fromIso}::timestamptz` : sql``}
            ${toIso ? sql`AND ra.created_at <= ${toIso}::timestamptz` : sql``}
        ) AS executed_count
      FROM ai_decisions
      WHERE tenant_id = ${tenantId}
        AND status = 'COMPLETED'
        ${fromIso ? sql`AND created_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND created_at <= ${toIso}::timestamptz` : sql``}
    `,
  );

  const recommendedCount = parseInt(actionsSummary?.recommended_count ?? "0", 10);
  const executedCount = parseInt(actionsSummary?.executed_count ?? "0", 10);

  const decisionAcceptanceRateBps =
    recommendedCount > 0
      ? Math.round((executedCount / recommendedCount) * 10000)
      : 0;

  const recommendationToExecRateBps = decisionAcceptanceRateBps;

  // 3. Policy Rejections & Approvals
  const [policySummary] = await executor.execute<{
    total_evaluations: string;
    rejections_count: string;
    approvals_required_count: string;
  }>(
    sql`
      SELECT
        COUNT(*)::text AS total_evaluations,
        COUNT(*) FILTER (WHERE result = 'REJECTED')::text AS rejections_count,
        COUNT(*) FILTER (WHERE result = 'REQUIRE_APPROVAL')::text AS approvals_required_count
      FROM policy_evaluations
      WHERE tenant_id = ${tenantId}
        ${fromIso ? sql`AND evaluated_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND evaluated_at <= ${toIso}::timestamptz` : sql``}
    `,
  );

  const totalEvaluations = parseInt(policySummary?.total_evaluations ?? "0", 10);
  const policyRejections = parseInt(policySummary?.rejections_count ?? "0", 10);
  const approvalsRequired = parseInt(
    policySummary?.approvals_required_count ?? "0",
    10,
  );

  const policyRejectionRateBps =
    totalEvaluations > 0
      ? Math.round((policyRejections / totalEvaluations) * 10000)
      : 0;

  // 4. AI Cost Economics: cost per decided case & cost per recovered amount (bps)
  const costPerCaseMinor =
    decisions > 0 ? totalAiCostMinor / BigInt(decisions) : 0n;

  const [recoveredTotalQuery] = await executor.execute<{ total_recovered: string }>(
    sql`
      SELECT COALESCE(SUM(recovered_amount), 0)::text AS total_recovered
      FROM recovery_outcomes
      WHERE tenant_id = ${tenantId}
        ${fromIso ? sql`AND recovered_at >= ${fromIso}::timestamptz` : sql``}
        ${toIso ? sql`AND recovered_at <= ${toIso}::timestamptz` : sql``}
    `,
  );
  const totalRecoveredMinor = BigInt(recoveredTotalQuery?.total_recovered ?? "0");

  const costPerRecoveredBps =
    totalRecoveredMinor > 0n
      ? Number((totalAiCostMinor * 10000n) / totalRecoveredMinor)
      : 0;

  return {
    decisions,
    decision_acceptance_rate_bps: decisionAcceptanceRateBps,
    recommendation_to_exec_rate_bps: recommendationToExecRateBps,
    policy_rejections: policyRejections,
    policy_rejection_rate_bps: policyRejectionRateBps,
    approvals_required: approvalsRequired,
    avg_decision_ms: avgDecisionMs,
    cost_per_case_minor: costPerCaseMinor,
    cost_per_recovered_bps: costPerRecoveredBps,
    total_ai_cost_minor: totalAiCostMinor,
  };
}
