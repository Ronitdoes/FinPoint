import type { ActionType, RiskType, CaseStatus, PolicyResult as DomainPolicyResult, PolicyRuleKind } from "@repo/domain";

export interface CaseSnapshot {
  id: string;
  tenant_id?: string;
  tenantId?: string;
  risk_type?: RiskType | string;
  riskType?: RiskType | string;
  amount_at_risk?: number | bigint;
  amountAtRisk?: number | bigint;
  currency?: string;
  retry_count?: number;
  retryCount?: number;
  status?: CaseStatus | string;
  payment_status?: string;
  paymentStatus?: string;
  [key: string]: unknown;
}

export interface CustomerSnapshot {
  opted_out?: boolean;
  optedOut?: boolean;
  dispute_open?: boolean;
  disputeOpen?: boolean;
  [key: string]: unknown;
}

export interface DecisionSnapshot {
  diagnosis_confidence?: number | string;
  diagnosisConfidence?: number | string;
  requires_approval?: boolean;
  requiresApproval?: boolean;
  diagnosis?: {
    cause?: string;
    confidence?: number | string;
    rationale?: string;
  };
  actions?: unknown[];
  recommendedActions?: unknown[];
  [key: string]: unknown;
}

export interface ActionProposal {
  type: ActionType | string;
  params: Record<string, unknown>;
}

export interface CountersSnapshot {
  whatsapp_sent_7d?: number;
  email_sent_14d?: number;
  sms_sent_7d?: number;
  [key: string]: number | undefined;
}

export interface PolicyEvaluationOptions {
  clamp_to_cap?: boolean;
  [key: string]: unknown;
}

export interface PolicyInput {
  case: CaseSnapshot;
  customer: CustomerSnapshot;
  decision?: DecisionSnapshot | null;
  actions: ActionProposal[];
  counters: CountersSnapshot;
  policy_version_ids?: string[];
  options?: PolicyEvaluationOptions;
}

export type ActionVerdictStatus = "ALLOWED" | "REJECTED" | "REQUIRE_APPROVAL" | "ADJUSTED";
export type OverallPolicyResult = DomainPolicyResult; // "ALLOWED" | "REJECTED" | "REQUIRE_APPROVAL"

export interface PolicyRejection {
  action_index: number;
  rule_code: string;
  reason: string;
  action_type?: string;
}

export interface EffectiveAction {
  type: string;
  params: Record<string, unknown>;
  status: "ALLOWED" | "ADJUSTED" | "REQUIRE_APPROVAL";
  original_params?: Record<string, unknown>;
  adjustment_reason?: string;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  required_approval: boolean;
  result: OverallPolicyResult;
  rejections: PolicyRejection[];
  effective_actions: EffectiveAction[];
  applied_rules?: string[];
  rule_versions?: string[];
  latency_ms?: number;
}

export type MatcherOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "contains"
  | "exists";

export interface RuleCondition {
  field: string;
  op: MatcherOperator;
  value?: unknown;
}

export interface RuleDefinition {
  applies_to?: string[];
  conditions?: RuleCondition[];
  effect?: "REJECT" | "REQUIRE_APPROVAL" | "ALLOW" | "LIMIT";
  reason_code?: string;
  reason_message?: string;
  clamp?: {
    field: string;
    max_value?: number;
    min_value?: number;
  };
  max_amount_minor?: number;
  clamp_enabled?: boolean;
  require_approval?: boolean;
  [key: string]: unknown;
}

export interface ActivePolicyRule {
  id: string;
  tenantId?: string | null;
  code: string;
  name: string;
  description?: string | null;
  ruleKind: PolicyRuleKind | string;
  definition: RuleDefinition;
  enabled: boolean;
  activeVersionId?: string;
  activeVersionNumber?: number;
}

export interface NormalizedEvaluationContext {
  case: {
    id: string;
    tenant_id: string;
    risk_type: string;
    amount_at_risk: number;
    currency: string;
    retry_count: number;
    status: string;
    payment_status: string;
    [key: string]: unknown;
  };
  customer: {
    opted_out: boolean;
    dispute_open: boolean;
    [key: string]: unknown;
  };
  decision: {
    diagnosis_confidence: number;
    requires_approval: boolean;
    diagnosis?: {
      cause?: string;
      confidence?: number;
      rationale?: string;
    };
    [key: string]: unknown;
  } | null;
  counters: {
    whatsapp_sent_7d: number;
    email_sent_14d: number;
    sms_sent_7d: number;
    [key: string]: number;
  };
  action: ActionProposal;
  action_index: number;
  options: PolicyEvaluationOptions;
}

export interface RuleEvaluationOutcome {
  matched: boolean;
  verdict?: "ALLOW" | "REJECT" | "REQUIRE_APPROVAL" | "ADJUST";
  rule_code: string;
  reason?: string;
  adjusted_params?: Record<string, unknown>;
  adjustment_reason?: string;
}

export type CompiledRuleEvaluator = (
  context: NormalizedEvaluationContext,
  rule?: ActivePolicyRule,
) => RuleEvaluationOutcome | null;
