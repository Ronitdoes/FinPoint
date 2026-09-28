import type { RepoContext } from "@repo/db/repositories";
import { getExecutor } from "@repo/db/repositories";
import { recoveryCases } from "@repo/db/schema";
import { and, eq, inArray } from "@repo/db";
import * as repos from "@repo/db/repositories";

export interface CaseValidationViolation {
  caseId: string;
  riskType?: string;
  status: string;
  missingEvents: string[];
  actualSequence: string[];
  error: string;
}

export interface CoverageReport {
  valid: boolean;
  totalCasesChecked: number;
  passedCases: number;
  failedCases: number;
  violations: CaseValidationViolation[];
}

export interface CaseValidationResult {
  valid: boolean;
  missingEvents: string[];
  actualSequence: string[];
  error?: string;
}

const TERMINAL_STATUSES = new Set([
  "RECOVERED",
  "FAILED",
  "STOPPED",
  "CLOSED",
  "ESCALATED",
]);

/**
 * Per-surface discovery spine (audit fix): expected opening event per riskType.
 * Exported so CI / tests / docs can reference the canonical payment/invoice/
 * checkout sequences without re-discovering them.
 */
export const SURFACE_DISCOVERY_EVENTS: Record<string, string> = {
  PAYMENT_FAILURE: "PAYMENT_FAILED",
  INVOICE_OVERDUE: "INVOICE_OVERDUE",
  CHECKOUT_ABANDONMENT: "CHECKOUT_ABANDONED",
};

/**
 * Canonical per-surface lifecycle sequences (audit fix): discovery -> assessment
 * -> decision -> policy -> execution -> terminal. Used for documentation and
 * for the discovery-stage check in `validateCaseTimelineSequence` below.
 */
export const SURFACE_SEQUENCES: Record<string, string[]> = {
  PAYMENT_FAILURE: [
    "PAYMENT_FAILED",
    "RISK_CALCULATED",
    "AI_DECISION_CREATED",
    "POLICY_ALLOWED | POLICY_REJECTED",
    "WORKFLOW_STARTED",
    "RECOVERY_RECORDED | PAYMENT_SUCCEEDED | CASE_STOPPED",
  ],
  INVOICE_OVERDUE: [
    "INVOICE_OVERDUE",
    "RISK_CALCULATED",
    "AI_DECISION_CREATED",
    "POLICY_ALLOWED | POLICY_REJECTED",
    "WORKFLOW_STARTED",
    "RECOVERY_RECORDED | PAYMENT_SUCCEEDED | CASE_STOPPED",
  ],
  CHECKOUT_ABANDONMENT: [
    "CHECKOUT_ABANDONED",
    "RISK_CALCULATED",
    "AI_DECISION_CREATED",
    "POLICY_ALLOWED | POLICY_REJECTED",
    "WORKFLOW_STARTED",
    "RECOVERY_RECORDED | PAYMENT_SUCCEEDED | CASE_STOPPED",
  ],
};

/**
 * Pure sequence validator for a case's timeline event history.
 */
export function validateCaseTimelineSequence(caseInfo: {
  id: string;
  riskType?: string;
  status: string;
  events: Array<{ eventType: string; occurredAt: Date }>;
}): CaseValidationResult {
  const actualSequence = caseInfo.events.map((e) => e.eventType);
  const eventSet = new Set(actualSequence);
  const missingEvents: string[] = [];

  // 0. Per-surface discovery spine (audit fix): e.g. PAYMENT_FAILURE -> PAYMENT_FAILED.
  const expectedDiscovery = caseInfo.riskType
    ? SURFACE_DISCOVERY_EVENTS[caseInfo.riskType]
    : undefined;
  if (expectedDiscovery && !eventSet.has(expectedDiscovery)) {
    missingEvents.push(expectedDiscovery);
  }

  // 1. Every processed case must have risk assessment
  if (!eventSet.has("RISK_CALCULATED") && !eventSet.has("CASE_DETECTED")) {
    missingEvents.push("RISK_CALCULATED");
  }

  // 2. Every evaluated case must have AI decision
  if (!eventSet.has("AI_DECISION_CREATED")) {
    missingEvents.push("AI_DECISION_CREATED");
  }

  // 3. Every decision must undergo policy evaluation
  if (!eventSet.has("POLICY_ALLOWED") && !eventSet.has("POLICY_REJECTED")) {
    missingEvents.push("POLICY_ALLOWED | POLICY_REJECTED");
  }

  // 4. If policy was allowed and case reached IN_PROGRESS or terminal success, workflow must start
  if (eventSet.has("POLICY_ALLOWED")) {
    if (!eventSet.has("WORKFLOW_STARTED") && caseInfo.status !== "STOPPED" && caseInfo.status !== "FAILED") {
      missingEvents.push("WORKFLOW_STARTED");
    }
  }

  // 5. Terminal resolution verification
  if (caseInfo.status === "RECOVERED") {
    if (!eventSet.has("RECOVERY_RECORDED") && !eventSet.has("PAYMENT_SUCCEEDED")) {
      missingEvents.push("RECOVERY_RECORDED | PAYMENT_SUCCEEDED");
    }
  } else if (caseInfo.status === "STOPPED") {
    if (!eventSet.has("CASE_STOPPED") && !eventSet.has("POLICY_REJECTED")) {
      missingEvents.push("CASE_STOPPED | POLICY_REJECTED");
    }
  } else if (caseInfo.status === "ESCALATED") {
    if (!eventSet.has("CASE_ESCALATED") && !eventSet.has("HUMAN_TASK_CREATED")) {
      missingEvents.push("CASE_ESCALATED | HUMAN_TASK_CREATED");
    }
  }

  // 6. Chronological ordering verification
  let orderError: string | undefined;
  const riskIdx = actualSequence.indexOf("RISK_CALCULATED");
  const aiIdx = actualSequence.indexOf("AI_DECISION_CREATED");
  const policyIdx = Math.max(
    actualSequence.indexOf("POLICY_ALLOWED"),
    actualSequence.indexOf("POLICY_REJECTED"),
  );
  const workflowIdx = actualSequence.indexOf("WORKFLOW_STARTED");

  if (riskIdx !== -1 && aiIdx !== -1 && riskIdx > aiIdx) {
    orderError = "RISK_CALCULATED appeared after AI_DECISION_CREATED";
  } else if (aiIdx !== -1 && policyIdx !== -1 && aiIdx > policyIdx) {
    orderError = "AI_DECISION_CREATED appeared after POLICY verdict";
  } else if (policyIdx !== -1 && workflowIdx !== -1 && policyIdx > workflowIdx) {
    orderError = "POLICY evaluation appeared after WORKFLOW_STARTED";
  }

  const valid = missingEvents.length === 0 && !orderError;

  return {
    valid,
    missingEvents,
    actualSequence,
    error: orderError || (missingEvents.length > 0 ? `Missing required events: ${missingEvents.join(", ")}` : undefined),
  };
}

/**
 * Walks terminal cases in DB and asserts required audit/timeline event coverage.
 */
export async function verifyAuditCoverage(
  ctx: RepoContext,
  options: { tenantId?: string; caseIds?: string[] } = {},
): Promise<CoverageReport> {
  const executor = getExecutor(ctx);

  const conditions = [];
  if (options.tenantId) {
    conditions.push(eq(recoveryCases.tenantId, options.tenantId));
  }
  if (options.caseIds && options.caseIds.length > 0) {
    conditions.push(inArray(recoveryCases.id, options.caseIds));
  }

  const cases = await executor
    .select()
    .from(recoveryCases)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const terminalCases = cases.filter((c) => TERMINAL_STATUSES.has(c.status));

  const violations: CaseValidationViolation[] = [];
  let passedCount = 0;

  for (const c of terminalCases) {
    const events = await repos.listCaseEvents(ctx, {
      tenantId: c.tenantId,
      caseId: c.id,
      limit: 100,
    });

    const validation = validateCaseTimelineSequence({
      id: c.id,
      riskType: c.riskType,
      status: c.status,
      events: events.map((e) => ({ eventType: e.eventType, occurredAt: e.occurredAt })),
    });

    if (validation.valid) {
      passedCount++;
    } else {
      violations.push({
        caseId: c.id,
        riskType: c.riskType,
        status: c.status,
        missingEvents: validation.missingEvents,
        actualSequence: validation.actualSequence,
        error: validation.error ?? "Audit coverage validation failed",
      });
    }
  }

  return {
    valid: violations.length === 0,
    totalCasesChecked: terminalCases.length,
    passedCases: passedCount,
    failedCases: violations.length,
    violations,
  };
}

// CLI runner
if ((import.meta as { main?: boolean }).main || process.argv[1]?.endsWith("coverage.check.ts")) {
  import("@repo/db").then(async ({ db }) => {
    console.log("🔍 Running audit coverage verification...");
    const report = await verifyAuditCoverage({ db });
    console.log(`\n📊 Coverage Report: ${report.passedCases}/${report.totalCasesChecked} passed`);
    if (!report.valid) {
      console.error("❌ Violations found:\n", JSON.stringify(report.violations, null, 2));
      process.exit(1);
    } else {
      console.log("✅ All terminal cases satisfy mandatory audit trail event coverage.");
      process.exit(0);
    }
  });
}
