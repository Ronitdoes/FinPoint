export type UserRole = "ADMIN" | "FINANCE" | "OPERATIONS" | "SUPPORT" | "VIEWER";

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED" | "INVITED";
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiKey {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AuthMeResponse {
  authenticated: boolean;
  userId: string;
  tenantId: string;
  role: UserRole;
  email?: string;
  name?: string;
  kind: "session" | "api_key";
  scopes?: string[];
}

export type CaseStatus =
  | "DETECTED"
  | "QUALIFIED"
  | "DECISION_PENDING"
  | "POLICY_REVIEW"
  | "IN_PROGRESS"
  | "WAITING"
  | "RECOVERED"
  | "STOPPED"
  | "ESCALATED"
  | "FAILED"
  | "PAUSED";

export type RiskBand = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type RiskType =
  | "FAILED_PAYMENT"
  | "CHECKOUT_ABANDONED"
  | "OVERDUE_INVOICE"
  | "DISPUTE_RISK"
  | "SUBSCRIPTION_CHURN";

export interface CaseSummary {
  id: string;
  tenant_id: string;
  case_number: string;
  customer_id: string;
  risk_id: string | null;
  risk_type: RiskType;
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
    risk_type: RiskType;
    band: RiskBand;
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
    };
    recommended_actions: unknown[];
    stop_conditions: string[];
    created_at: string;
  } | null;
  policy_evaluation: {
    id: string;
    result: "ALLOWED" | "REJECTED" | "REQUIRE_APPROVAL";
    allowed: boolean;
    required_approval: boolean;
    rejections: unknown[];
    effective_actions: unknown[];
    latency_ms: number;
    evaluated_at: string;
  } | null;
  actions: Array<{
    id: string;
    type: string;
    status: string;
    parameters: Record<string, unknown>;
    idempotency_key: string;
    attempt_number: number;
    scheduled_at: string | null;
    created_at: string;
  }>;
  workflow: {
    id: string;
    status: string;
    temporal_workflow_id?: string;
  } | null;
  outcome: {
    id: string;
    payment_id: string | null;
    recovered_amount: number;
    recovered_at: string;
    attribution_method: string;
  } | null;
}

export interface TimelineItem {
  id: string;
  event_type: string;
  timestamp: string;
  actor_type: "SYSTEM" | "USER" | "ANONYMOUS";
  actor_id: string | null;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface AnalyticsSummary {
  revenueAtRisk: string; // minor units
  revenueRecovered: string; // minor units
  recoveryRate: number; // percentage (0..100)
  recoveryCost: string | null; // minor units or null if redacted
  netRecovered: string | null; // minor units or null if redacted
  activeCases: number;
  escalatedCases: number;
  recoveredCases: number;
  stoppedCases: number;
  failedCases: number;
  timeRange: {
    from: string;
    to: string;
  };
}

export interface RecoveryTimeseriesPoint {
  bucket: string;
  revenueAtRisk: string;
  revenueRecovered: string;
  casesCount: number;
  recoveredCasesCount: number;
}

export interface FunnelStage {
  stage: "AT_RISK" | "QUALIFIED" | "CONTACTED" | "ATTEMPTED" | "RECOVERED";
  count: number;
  value: string; // minor units
  conversionRate: number; // 0..100
}

export interface InterventionStat {
  actionType: string;
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  successRate: number; // 0..100
  totalRecovered: string; // minor units
  averageCost: string | null; // minor units
}

export interface RiskMixItem {
  riskType: RiskType;
  band: RiskBand;
  count: number;
  value: string; // minor units
}

export interface AiPerformanceMetrics {
  totalRecommendations: number;
  policyRejections: number;
  humanApprovals: number;
  averageDecisionLatencyMs: number;
  fallbackCount: number;
  autonomyRate: number; // 0..100
  aiCostPerRecoveredRupee: number | null;
}

export interface HumanTask {
  id: string;
  tenant_id: string;
  case_id: string;
  type: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  assigned_to_user_id: string | null;
  reason: string;
  notes: string | null;
  resolution_notes: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  case?: CaseSummary;
}

export interface PolicyRule {
  id: string;
  tenant_id: string;
  code?: string;
  name: string;
  description: string;
  category: "SPENDING" | "COMMUNICATION" | "APPROVAL" | "STOP_CONDITION" | string;
  rule_type: string;
  parameters: Record<string, unknown>;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PolicyVersion {
  id: string;
  rule_id: string;
  version: number;
  parameters: Record<string, unknown>;
  enabled: boolean;
  changed_by: string;
  changed_at: string;
  reason?: string;
}

export interface AuditLogItem {
  id: string;
  tenant_id: string;
  case_id: string | null;
  event: string;
  actor_type: "SYSTEM" | "USER" | "ANONYMOUS";
  actor_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RiskEvaluationItem {
  id: string;
  tenant_id: string;
  customer_id: string;
  case_id?: string;
  risk_type: RiskType;
  band: RiskBand;
  score: number;
  factors: Record<string, unknown>;
  status: string;
  computed_at: string;
}
