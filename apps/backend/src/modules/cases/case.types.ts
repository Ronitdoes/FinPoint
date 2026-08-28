import type { ActorType, CaseStatus, RiskType, UserRole } from "@repo/domain";
import type { RecoveryCase } from "@repo/db";

export type PipelineStageName =
  | "CONTEXT"
  | "AI_DECISION"
  | "POLICY"
  | "ACTIONS"
  | "WORKFLOW";

export interface StageLedgerEntry {
  stage: PipelineStageName;
  status: "DONE" | "FAILED" | "PENDING";
  at: string;
  ref?: string;
}

export interface TryCreateCaseInput {
  tenantId: string;
  customerId: string;
  riskId?: string;
  riskType: RiskType;
  sourceEntityType: string;
  sourceEntityId: string;
  amountAtRisk: bigint | number;
  currency: string;
  riskScore: number;
  stopConditions?: string[];
  attributionWindowHours?: number;
  correlationId?: string;
  traceparent?: string;
}

export interface TryCreateCaseResult {
  case: RecoveryCase;
  created: boolean;
}

export interface PipelineRunOptions {
  tenantId: string;
  caseId: string;
  correlationId?: string;
  traceparent?: string;
}

export interface CaseActorContext {
  userId?: string;
  role?: UserRole;
  actorType?: ActorType;
}

export interface CaseSummary {
  id: string;
  tenant_id: string;
  case_number: number;
  customer_id: string;
  risk_id: string | null;
  risk_type: string;
  source_entity_type: string;
  source_entity_id: string;
  amount_at_risk: number;
  currency: string;
  risk_score: number;
  status: CaseStatus;
  status_reason: string | null;
  assigned_to: string | null;
  workflow_id: string | null;
  opened_at: string;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanonicalCaseDetail extends CaseSummary {
  stop_conditions: string[];
  attribution_window_hours: number;
  risk: {
    id: string;
    risk_type: string;
    band: string;
    score: number;
    factors: Record<string, unknown>;
    computed_at: string;
    status: string;
  } | null;
  decision: {
    id: string;
    model: string;
    prompt_version: string;
    status: string;
    diagnosis: {
      cause: string;
      confidence: number;
      rationale?: string;
    } | null;
    recommended_actions: unknown[];
    stop_conditions: string[];
    created_at: string;
  } | null;
  policy_evaluation: {
    id: string;
    result: string;
    allowed: boolean;
    required_approval: boolean;
    rejections: unknown[];
    effective_actions: unknown[];
    latency_ms: number;
    evaluated_at: string;
  } | null;
  actions: {
    id: string;
    type: string;
    status: string;
    parameters: Record<string, unknown>;
    idempotency_key: string;
    attempt_number: number;
    scheduled_at: string | null;
    created_at: string;
  }[];
  workflow: {
    id: string;
    status: string;
    temporal_workflow_id?: string;
  } | null;
  outcome: {
    id: string;
    payment_id: string;
    recovered_amount: number;
    recovered_at: string;
    attribution_method: string;
  } | null;
}
