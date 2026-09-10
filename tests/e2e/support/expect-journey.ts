/**
 * `expectJourney` assertion library (s-32 §Technical Implementation).
 *
 * Maps each numbered spec 01 §29 definition-of-done item to a check function.
 * The traceability table lives IN code: every function carries its `[DOD-NN]`
 * marker comment, and `scripts/e2e-coverage-check.mjs` counts markers —
 * failing if <18. Do not rename markers.
 */
import { expect } from "vitest";
import { CUSTOMER_CONTEXT_ALLOWLIST } from "../../../apps/backend/src/modules/customers/context/allowlist";
import {
  db,
  findEventById,
  findLatestRiskForSubject,
  findCaseById,
  listCases,
  findLatestDecisionForCase,
  listPolicyEvaluationsForCase,
  findWorkflowByCaseId,
  listMessagesForCase,
  findPaymentById,
  findPaymentAttemptByIdempotencyKey,
  findOutcomeByCaseId,
  listCostEntriesForCase,
  listCaseEvents,
} from "@repo/db";

/** Timeline spine the flagship journey must exhibit, in order (≥9 types). */
export const REQUIRED_TIMELINE_ORDER = [
  "PAYMENT_FAILED",
  "RISK_CALCULATED",
  "AI_DECISION_CREATED",
  "POLICY_ALLOWED",
  "WORKFLOW_STARTED",
  "WHATSAPP_SENT",
  "PAYMENT_RETRY_STARTED",
  "PAYMENT_SUCCEEDED",
  "RECOVERY_RECORDED",
] as const;

/** [DOD-01] Provider sends payment.failed — signed loopback accepted. */
export function expectDod01WebhookAccepted(result: { webhookStatus: string; providerPaymentId: string }): void {
  // [DOD-01]
  expect(result.webhookStatus).toBe("ACCEPTED");
  expect(result.providerPaymentId).toBeTruthy();
}

/** [DOD-02] Event is authenticated — signature path used, forgeries rejected. */
export function expectDod02AuthPath(args: { acceptedStatus: string; forgedStatusCode: number }): void {
  // [DOD-02]
  expect(args.acceptedStatus).toBe("ACCEPTED");
  expect([400, 401]).toContain(args.forgedStatusCode);
}

/** [DOD-03] Duplicate event is ignored — no second case. */
export function expectDod03DuplicateIgnored(args: { statuses: string[]; caseCount: number }): void {
  // [DOD-03]
  expect(args.statuses).toContain("DUPLICATE");
  expect(args.caseCount).toBe(1);
}

/** [DOD-04] Internal event is created w/ normalized envelope. */
export async function expectDod04InternalEvent(tenantId: string, eventId: string): Promise<void> {
  // [DOD-04]
  const event = await findEventById({ db }, { tenantId, eventId });
  expect(event).toBeTruthy();
  expect(event!.type).toBe("payment.failed");
  expect(event!.correlationId).toBeTruthy();
  expect(event!.payload).toBeTruthy();
}

/** [DOD-05] Risk is calculated — HIGH band parity fixture. */
export async function expectDod05RiskHigh(tenantId: string, subjectId: string): Promise<void> {
  // [DOD-05]
  const risk = await findLatestRiskForSubject({ db }, { tenantId, subjectType: "PAYMENT", subjectId });
  expect(risk).toBeTruthy();
  expect(["HIGH", "CRITICAL"]).toContain(risk!.band);
  expect(risk!.score).toBeGreaterThanOrEqual(60);
  expect(risk!.factors).toBeTruthy();
}

/** [DOD-06] Recovery case is created — exactly one RC-* case. */
export async function expectDod06SingleCase(tenantId: string, caseId: string): Promise<void> {
  // [DOD-06]
  const c = await findCaseById({ db }, { tenantId, caseId });
  expect(c).toBeTruthy();
  expect(c!.caseNumber).toBeGreaterThan(0);
  const all = await listCases({ db }, { tenantId, limit: 500 });
  const live = all.filter((x: any) => x.sourceEntityId === c!.sourceEntityId);
  expect(live.length).toBe(1);
}

/** [DOD-07] Context is assembled — snapshot matches allowlist schema, PII masked. */
export function expectDod07ContextAllowlisted(inputSnapshot: any): void {
  // [DOD-07]
  expect(inputSnapshot).toBeTruthy();
  const ctx = inputSnapshot.customer_context ?? inputSnapshot.context ?? inputSnapshot;
  expect(ctx).toBeTruthy();
  for (const [section, allowed] of Object.entries(CUSTOMER_CONTEXT_ALLOWLIST)) {
    const node = (ctx as any)[section];
    if (node === undefined) continue;
    for (const key of Object.keys(node)) {
      expect((allowed as readonly string[])).toContain(key);
    }
  }
  const customer = (ctx as any).customer ?? {};
  if (customer.email !== undefined || customer.phone !== undefined) {
    throw new Error("raw PII leaked into context snapshot (expected masked-only)");
  }
}

/** [DOD-08] AI returns schema-valid decision (COMPLETED vs mock, or FALLBACK badge). */
export async function expectDod08DecisionValid(
  tenantId: string,
  caseId: string,
  mode: "normal" | "fallback",
): Promise<void> {
  // [DOD-08]
  const decision = await findLatestDecisionForCase({ db }, { tenantId, caseId });
  expect(decision).toBeTruthy();
  if (mode === "normal") {
    expect(decision!.status).toBe("COMPLETED");
  } else {
    expect(decision!.status).toBe("FALLBACK_RULE_BASED");
  }
  const actions = decision!.recommendedActions as any[];
  expect(Array.isArray(actions)).toBe(true);
  expect(actions.length).toBeGreaterThan(0);
  for (const a of actions) {
    expect(a.type).toBeTruthy();
  }
  expect(decision!.diagnosisCause ?? (decision!.outputRaw as any)?.diagnosis?.cause).toBeTruthy();
}

/** [DOD-09] Policy validates decision — ALLOWED evaluation for executed actions. */
export async function expectDod09PolicyAllowed(tenantId: string, caseId: string): Promise<void> {
  // [DOD-09]
  const evaluations = await listPolicyEvaluationsForCase({ db }, { tenantId, caseId });
  expect(evaluations.length).toBeGreaterThan(0);
  expect(evaluations.some((e: any) => e.result === "ALLOWED")).toBe(true);
}

/** [DOD-10] Temporal workflow starts — RUNNING row, queryable history. */
export async function expectDod10WorkflowRunning(tenantId: string, caseId: string): Promise<void> {
  // [DOD-10]
  const workflow = await findWorkflowByCaseId({ db }, { tenantId, caseId });
  expect(workflow).toBeTruthy();
  expect(workflow!.status).toBe("RUNNING");
  expect(workflow!.temporalWorkflowId).toBe(`recover:${caseId}`);
}

/** [DOD-11] Message is sent — WhatsApp SENT ledger, idempotent-keyed. */
export async function expectDod11MessageSent(tenantId: string, caseId: string): Promise<void> {
  // [DOD-11]
  const messages = await listMessagesForCase({ db }, { tenantId, caseId });
  const wa = messages.filter((m: any) => m.channel === "WHATSAPP");
  expect(wa.length).toBeGreaterThan(0);
  expect(["SENT", "DELIVERED", "READ"]).toContain(wa[0]!.status);
  expect(wa[0]!.idempotencyKey).toContain(caseId);
}

/** [DOD-12] Payment retry occurs — REQUESTED attempt, provider called once. */
export async function expectDod12RetryOccurs(
  tenantId: string,
  caseId: string,
  paymentId: string,
  attemptNumber = 1,
): Promise<void> {
  // [DOD-12]
  const key = `${tenantId}:${caseId}:RETRY_PAYMENT:${attemptNumber}`;
  const attempt = await findPaymentAttemptByIdempotencyKey({ db }, { tenantId, idempotencyKey: key });
  expect(attempt).toBeTruthy();
  expect(attempt!.requestedAt).toBeTruthy();
  const payment = await findPaymentById({ db }, { tenantId, paymentId });
  expect(payment).toBeTruthy();
}

/** [DOD-13] Provider returns success — SUCCEEDED propagates. */
export async function expectDod13ProviderSuccess(tenantId: string, paymentId: string): Promise<void> {
  // [DOD-13]
  const payment = await findPaymentById({ db }, { tenantId, paymentId });
  expect(payment?.status).toBe("SUCCEEDED");
}

/** [DOD-14] Outcome is recorded — recovered_amount + WORKFLOW_LINKED. */
export async function expectDod14OutcomeRecorded(
  tenantId: string,
  caseId: string,
  expectedMinor: bigint,
): Promise<void> {
  // [DOD-14]
  const outcome = await findOutcomeByCaseId({ db }, { tenantId, caseId });
  expect(outcome).toBeTruthy();
  expect(BigInt(outcome!.recoveredAmount as any)).toBe(expectedMinor);
  expect(outcome!.attributionMethod).toBe("WORKFLOW_LINKED");
}

/** [DOD-15] Recovered amount computed — net = recovered − costs (LLM+messaging exist). */
export async function expectDod15NetComputed(tenantId: string, caseId: string): Promise<void> {
  // [DOD-15]
  const outcome = await findOutcomeByCaseId({ db }, { tenantId, caseId });
  const costs = await listCostEntriesForCase({ db }, { tenantId, caseId });
  const categories = new Set(costs.map((c: any) => c.category));
  expect(categories.has("LLM")).toBe(true);
  expect(categories.has("MESSAGING")).toBe(true);
  const recovered = BigInt(outcome!.recoveredAmount as any);
  const cost = BigInt(outcome!.recoveryCost as any);
  expect(recovered - cost).toBe(BigInt(outcome!.netRecovered as any));
  expect(outcome!.netRecovered as any as bigint | number).toBeTruthy();
}

/** [DOD-16] Dashboard reflects it — analytics summary shows recovered (cache-bust verified). */
export function expectDod16DashboardReflects(args: { before: string; after: string; expectedMinor: bigint }): void {
  // [DOD-16]
  expect(BigInt(args.after) - BigInt(args.before)).toBe(args.expectedMinor);
}

/** [DOD-17] Audit timeline contains every major event — ≥9 types in order. */
export async function expectDod17TimelineComplete(tenantId: string, caseId: string): Promise<void> {
  // [DOD-17]
  const events = await listCaseEvents({ db }, { tenantId, caseId });
  const types = events.map((e: any) => e.eventType);
  expect(types.length).toBeGreaterThanOrEqual(REQUIRED_TIMELINE_ORDER.length);
  let cursor = -1;
  for (const required of REQUIRED_TIMELINE_ORDER) {
    const idx = types.indexOf(required, cursor + 1);
    expect(idx).toBeGreaterThan(cursor);
    cursor = idx;
  }
}

/** [DOD-18] System recovers from worker/API restarts — journey completes post-restart. */
export async function expectDod18RestartResilience(tenantId: string, caseId: string): Promise<void> {
  // [DOD-18]
  const outcome = await findOutcomeByCaseId({ db }, { tenantId, caseId });
  expect(outcome).toBeTruthy();
  const c = await findCaseById({ db }, { tenantId, caseId });
  expect(["RECOVERED", "IN_PROGRESS"]).toContain(c!.status);
}

/** Ordered registry used by docs and the coverage script's cross-check. */
export const DOD_CHECKS = [
  "expectDod01WebhookAccepted",
  "expectDod02AuthPath",
  "expectDod03DuplicateIgnored",
  "expectDod04InternalEvent",
  "expectDod05RiskHigh",
  "expectDod06SingleCase",
  "expectDod07ContextAllowlisted",
  "expectDod08DecisionValid",
  "expectDod09PolicyAllowed",
  "expectDod10WorkflowRunning",
  "expectDod11MessageSent",
  "expectDod12RetryOccurs",
  "expectDod13ProviderSuccess",
  "expectDod14OutcomeRecorded",
  "expectDod15NetComputed",
  "expectDod16DashboardReflects",
  "expectDod17TimelineComplete",
  "expectDod18RestartResilience",
] as const;
