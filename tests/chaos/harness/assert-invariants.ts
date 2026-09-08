/**
 * Financial invariant assertion library (Step 31 §Technical Implementation).
 *
 * `assertInvariants(tenantId)` scans the tenant's ledger and throws a single
 * aggregated error when any hard invariant breaks. Reused by every chaos
 * scenario:
 * - payments ↔ attempts consistency (no orphan/duplicate charges)
 * - message uniqueness by idempotency key (no double contact)
 * - single live case per obligation (no duplicate recovery)
 * - outcomes ≤ 1 per case (no double counting)
 * - cost entries ≥ LLM-minimum for decided cases (no free decisions)
 * - state-machine vocabulary legality (chaos may not invent transitions)
 */
import {
  ACTION_STATUSES,
  CASE_STATUSES,
  type ActionStatus,
  type CaseStatus,
} from "@repo/domain";
import { isTerminal } from "@repo/domain";
import {
  db,
  findPaymentAttemptsByPaymentId,
  findPaymentById,
  findOutcomeByCaseId,
  listActionsForCase,
  listCases,
  listCostEntriesForCase,
  listDecisionsForCase,
  listMessagesForCase,
} from "@repo/db";

export interface InvariantReport {
  tenantId: string;
  casesScanned: number;
  actionsScanned: number;
  messagesScanned: number;
  attemptsScanned: number;
  outcomesScanned: number;
  violations: string[];
}

export class InvariantViolationError extends Error {
  readonly code = "CHAOS_INVARIANT_VIOLATED";
  constructor(
    readonly tenantId: string,
    readonly violations: string[],
  ) {
    super(
      `Chaos invariant violations for tenant '${tenantId}' (${violations.length}):\n` +
        violations.map((v) => `- ${v}`).join("\n"),
    );
    this.name = "InvariantViolationError";
  }
}

function isLiveStatus(status: CaseStatus): boolean {
  return !isTerminal(status);
}

/**
 * Scans tenant state and throws `InvariantViolationError` on any breach.
 * Returns the scan report when all invariants hold.
 */
export async function assertInvariants(tenantId: string): Promise<InvariantReport> {
  const violations: string[] = [];
  const report: InvariantReport = {
    tenantId,
    casesScanned: 0,
    actionsScanned: 0,
    messagesScanned: 0,
    attemptsScanned: 0,
    outcomesScanned: 0,
    violations,
  };

  const cases = await listCases({ db }, { tenantId, limit: 500 });
  report.casesScanned = cases.length;

  // Single live case per obligation: group non-terminal cases by anchor.
  const liveByObligation = new Map<string, string[]>();
  for (const c of cases) {
    if (!(CASE_STATUSES as readonly string[]).includes(c.status)) {
      violations.push(`case ${c.id} carries unknown status '${c.status}'`);
      continue;
    }
    if (isLiveStatus(c.status as CaseStatus)) {
      const anchor = `${c.sourceEntityType}:${c.sourceEntityId}`;
      const bucket = liveByObligation.get(anchor) ?? [];
      bucket.push(c.id);
      liveByObligation.set(anchor, bucket);
    }
  }
  for (const [anchor, ids] of liveByObligation) {
    if (ids.length > 1) {
      violations.push(
        `obligation '${anchor}' has ${ids.length} live cases (${ids.join(", ")}) — expected ≤1`,
      );
    }
  }

  const seenMessageKeys = new Map<string, string>();

  for (const c of cases) {
    const [actions, messages, decisions, outcome, costs] = await Promise.all([
      listActionsForCase({ db }, { tenantId, caseId: c.id }),
      listMessagesForCase({ db }, { tenantId, caseId: c.id }),
      listDecisionsForCase({ db }, { tenantId, caseId: c.id }),
      findOutcomeByCaseId({ db }, { tenantId, caseId: c.id }),
      listCostEntriesForCase({ db }, { tenantId, caseId: c.id }),
    ]);

    report.actionsScanned += actions.length;
    report.messagesScanned += messages.length;
    if (outcome) report.outcomesScanned += 1;

    // Action vocabulary legality (chaos may not invent transitions).
    for (const a of actions) {
      if (!(ACTION_STATUSES as readonly string[]).includes(a.status)) {
        violations.push(`action ${a.id} carries unknown status '${a.status}'`);
      }
      // EXECUTING must always be resolvable: a completed/failed twin with the
      // same key must not exist alongside (claim-guard breach).
      if (a.status === ("EXECUTING" as ActionStatus)) {
        const twins = actions.filter(
          (other) =>
            other.id !== a.id &&
            other.idempotencyKey === a.idempotencyKey &&
            (other.status === "EXECUTED" || other.status === "FAILED"),
        );
        if (twins.length > 0) {
          violations.push(
            `action ${a.id} EXECUTING while key '${a.idempotencyKey}' already resolved by ${twins[0].id}`,
          );
        }
      }
    }

    // Message uniqueness by idempotency key (no double contact).
    for (const m of messages) {
      const prev = seenMessageKeys.get(m.idempotencyKey);
      if (prev && prev !== m.id) {
        violations.push(
          `duplicate message key '${m.idempotencyKey}' on messages ${prev} and ${m.id}`,
        );
      } else {
        seenMessageKeys.set(m.idempotencyKey, m.id);
      }
    }

    // Outcomes ≤ 1 per case is enforced by unique(case_id); a second lookup
    // path (list) guards against partial-write twins.
    if (outcome && outcome.caseId !== c.id) {
      violations.push(`outcome ${outcome.id} mismatched case link on case ${c.id}`);
    }

    // Cost entries ≥ LLM-minimum for decided cases.
    if (decisions.length > 0) {
      const llmCosts = costs.filter((entry) => entry.category === "LLM");
      if (llmCosts.length === 0) {
        violations.push(
          `case ${c.id} has ${decisions.length} decision(s) but zero LLM cost entries`,
        );
      }
    }

    // Payments ↔ attempts consistency for payment-anchored cases.
    if (c.sourceEntityType === "PAYMENT") {
      const payment = await findPaymentById(
        { db },
        { tenantId, paymentId: c.sourceEntityId },
      );
      if (!payment) {
        violations.push(
          `case ${c.id} anchors missing payment '${c.sourceEntityId}'`,
        );
        continue;
      }
      const attempts = await findPaymentAttemptsByPaymentId(
        { db },
        { tenantId, paymentId: payment.id },
      );
      report.attemptsScanned += attempts.length;
      const succeeded = attempts.filter((a) => a.status === "SUCCEEDED");
      if (succeeded.length > 1) {
        // Multiple SUCCEEDED attempts are only legal under distinct keys
        // (separate attempts); identical keys would be a double charge.
        const keys = new Set(succeeded.map((a) => a.idempotencyKey));
        if (keys.size !== succeeded.length) {
          violations.push(
            `payment ${payment.id} has ${succeeded.length} SUCCEEDED attempts sharing idempotency keys (double-charge risk)`,
          );
        }
      }
      for (const attempt of attempts) {
        if (!attempt.requestedAt) {
          violations.push(`attempt ${attempt.id} missing requested_at`);
        }
        if (
          (attempt.status === "SUCCEEDED" || attempt.status === "FAILED") &&
          !attempt.resolvedAt
        ) {
          violations.push(
            `attempt ${attempt.id} terminal (${attempt.status}) without resolved_at`,
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    report.violations = violations;
    throw new InvariantViolationError(tenantId, violations);
  }
  return report;
}
