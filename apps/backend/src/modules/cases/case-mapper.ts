import type {
  AiDecision,
  PolicyEvaluation,
  RecoveryAction,
  RecoveryCase,
  RecoveryOutcome,
  RevenueRisk,
  Workflow,
} from "@repo/db";
import type { CanonicalCaseDetail, CaseSummary } from "./case.types";

/**
 * Transforms a raw RecoveryCase database record into a canonical CaseSummary shape (Spec 02 §3).
 */
export function toCaseSummary(row: RecoveryCase): CaseSummary {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    case_number: row.caseNumber,
    customer_id: row.customerId,
    risk_id: row.riskId ?? null,
    risk_type: row.riskType,
    source_entity_type: row.sourceEntityType,
    source_entity_id: row.sourceEntityId,
    amount_at_risk: Number(row.amountAtRisk),
    currency: row.currency,
    risk_score: row.riskScore,
    status: row.status,
    status_reason: row.statusReason ?? null,
    assigned_to: row.assignedTo ?? null,
    workflow_id: row.workflowId ?? null,
    opened_at: row.openedAt.toISOString(),
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface CaseRelations {
  risk?: RevenueRisk | null;
  decision?: AiDecision | null;
  policyEvaluation?: PolicyEvaluation | null;
  actions?: RecoveryAction[];
  workflow?: Workflow | null;
  outcome?: RecoveryOutcome | null;
}

/**
 * Maps a recovery case and its related entities into the full canonical detail payload (Spec 02 §3, Spec 02 §13).
 */
export function toCanonicalCaseDetail(
  row: RecoveryCase,
  relations: CaseRelations = {},
): CanonicalCaseDetail {
  const summary = toCaseSummary(row);

  const riskPayload = relations.risk
    ? {
        id: relations.risk.id,
        risk_type: relations.risk.riskType,
        band: relations.risk.band,
        score: relations.risk.score,
        factors: (relations.risk.factors as Record<string, unknown>) ?? {},
        computed_at: relations.risk.computedAt.toISOString(),
        status: relations.risk.status,
      }
    : null;

  let decisionPayload: CanonicalCaseDetail["decision"] = null;
  if (relations.decision) {
    const rawDiag = (relations.decision as any).diagnosis;
    const cause =
      relations.decision.diagnosisCause ??
      (typeof rawDiag === "object" ? rawDiag?.cause : undefined) ??
      "UNKNOWN";
    const confidence =
      relations.decision.diagnosisConfidence !== undefined &&
      relations.decision.diagnosisConfidence !== null
        ? Number(relations.decision.diagnosisConfidence)
        : typeof rawDiag === "object" && rawDiag?.confidence !== undefined
          ? Number(rawDiag.confidence)
          : 0.5;
    const rationale =
      typeof rawDiag === "object" ? rawDiag?.rationale : undefined;

    decisionPayload = {
      id: relations.decision.id,
      model: relations.decision.model,
      prompt_version: relations.decision.promptVersion,
      status: relations.decision.status,
      diagnosis: {
        cause,
        confidence,
        rationale,
      },
      recommended_actions:
        (relations.decision.recommendedActions as unknown[]) ?? [],
      stop_conditions: relations.decision.stopConditions ?? [],
      created_at: relations.decision.createdAt.toISOString(),
    };
  }

  const policyPayload = relations.policyEvaluation
    ? {
        id: relations.policyEvaluation.id,
        result: relations.policyEvaluation.result,
        allowed: relations.policyEvaluation.result === "ALLOWED",
        required_approval:
          relations.policyEvaluation.result === "REQUIRE_APPROVAL",
        rejections: (relations.policyEvaluation.rejections as unknown[]) ?? [],
        effective_actions:
          (relations.policyEvaluation.effectiveActions as unknown[]) ?? [],
        latency_ms: relations.policyEvaluation.latencyMs,
        evaluated_at: relations.policyEvaluation.evaluatedAt.toISOString(),
      }
    : null;

  const actionsPayload = (relations.actions ?? []).map((action) => ({
    id: action.id,
    type: action.type,
    status: action.status,
    parameters: (action.parameters as Record<string, unknown>) ?? {},
    idempotency_key: action.idempotencyKey,
    attempt_number: action.attemptNumber,
    scheduled_at: action.scheduledAt ? action.scheduledAt.toISOString() : null,
    created_at: action.createdAt.toISOString(),
  }));

  const workflowPayload = relations.workflow
    ? {
        id: relations.workflow.id,
        status: relations.workflow.status,
        temporal_workflow_id: relations.workflow.temporalWorkflowId,
      }
    : row.workflowId
      ? {
          id: row.workflowId,
          status: "RUNNING",
        }
      : null;

  const outcomePayload = relations.outcome
    ? {
        id: relations.outcome.id,
        payment_id: relations.outcome.paymentId,
        recovered_amount: Number(relations.outcome.recoveredAmount),
        recovered_at: relations.outcome.recoveredAt.toISOString(),
        attribution_method: relations.outcome.attributionMethod,
      }
    : null;

  return {
    ...summary,
    stop_conditions: row.stopConditions ?? [],
    attribution_window_hours: row.attributionWindowHours,
    risk: riskPayload,
    decision: decisionPayload,
    policy_evaluation: policyPayload,
    actions: actionsPayload,
    workflow: workflowPayload,
    outcome: outcomePayload,
  };
}
