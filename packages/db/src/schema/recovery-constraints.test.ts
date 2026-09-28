import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { db } from "../client";
import {
  aiDecisions,
  auditLogs,
  caseEvents,
  customerResponses,
  customers,
  events,
  humanTasks,
  idempotencyKeys,
  messageDeliveryEvents,
  messages,
  payments,
  policyEvaluations,
  policyRules,
  policyVersions,
  promisesToPay,
  recoveryActions,
  recoveryCases,
  recoveryCostEntries,
  recoveryOutcomes,
  revenueRisks,
  tenants,
  users,
  workflowEvents,
  workflows,
} from "./index";

describe("Recovery Schema: Database constraints, indexes, and anti-duplication anchors", () => {
  let tenantId: string;
  let customerId: string;
  let paymentId: string;
  let riskId: string;
  let caseId: string;
  let decisionId: string;
  let workflowId: string;
  let messageId: string;
  let policyRuleId: string;
  // Globally-unique rule code suffix (policy_rules_code_unique): the duplicate
  // test below must reuse this exact code to trigger the conflict.
  let policyRuleCode: string;
  const obligationId = "11111111-1111-1111-1111-111111111111";

  beforeAll(async () => {
    // Step 1: Create tenant
    const [tenant] = await db
      .insert(tenants)
      .values({
        name: "Recovery Test Tenant",
        slug: `recovery-test-${Date.now()}`,
        status: "ACTIVE",
        settings: { timezone: "UTC", attributionWindowHours: 72 },
      })
      .returning();
    tenantId = tenant.id;

    // Step 2: Create customer & policy rule in parallel.
    // Code is globally unique (policy_rules_code_unique), so suffix per run
    // to survive repeated local runs against a shared DB.
    const runSuffix = Date.now().toString(36);
    policyRuleCode = `MAX_PAYMENT_RETRIES_${runSuffix}`.slice(0, 64);
    const [[customer], [rule]] = await Promise.all([
      db
        .insert(customers)
        .values({
          tenantId,
          name: "Jane Recovery",
          email: `jane.recovery.${runSuffix}@example.com`,
          phone: "+15550001111",
        })
        .returning(),
      db
        .insert(policyRules)
        .values({
          tenantId,
          code: policyRuleCode,
          name: "Max Payment Retries",
          description: "Limits automated retry attempts to 3",
          ruleKind: "LIMIT",
          definition: { max_retries: 3 },
          enabled: true,
        })
        .returning(),
    ]);
    customerId = customer.id;
    policyRuleId = rule.id;

    // Step 3: Create payment & policy version in parallel
    const [[payment]] = await Promise.all([
      db
        .insert(payments)
        .values({
          tenantId,
          customerId,
          amount: 15000n,
          currency: "USD",
          status: "FAILED",
          provider: "STRIPE",
          providerPaymentId: `pi_recov_${Date.now()}`,
          occurredAt: new Date(),
        })
        .returning(),
      db.insert(policyVersions).values({
        ruleId: policyRuleId,
        version: 1,
        snapshot: { max_retries: 3 },
        createdAt: new Date(),
      }),
    ]);
    paymentId = payment.id;

    // Step 4: Create revenue risk
    const [risk] = await db
      .insert(revenueRisks)
      .values({
        tenantId,
        customerId,
        riskType: "PAYMENT_FAILURE",
        subjectType: "PAYMENT",
        subjectId: paymentId,
        score: 85,
        band: "HIGH",
        factors: { retry_count: 2, past_due_days: 3 },
        status: "OPEN",
        computedAt: new Date(),
      })
      .returning();
    riskId = risk.id;

    // Step 5: Create recovery case
    const [recCase] = await db
      .insert(recoveryCases)
      .values({
        tenantId,
        caseNumber: 1001,
        customerId,
        riskId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: obligationId,
        amountAtRisk: 15000n,
        currency: "USD",
        riskScore: 85,
        status: "DETECTED",
        attributionWindowHours: 72,
        openedAt: new Date(),
      })
      .returning();
    caseId = recCase.id;

    // Step 6: Create AI decision, workflow, & message in parallel
    const [[decision], [wf], [msg]] = await Promise.all([
      db
        .insert(aiDecisions)
        .values({
          tenantId,
          caseId,
          model: "gpt-4o",
          modelVersion: "2026-08-01",
          promptVersion: "prompt_v1",
          inputSnapshot: { amount: 15000, risk_score: 85 },
          outputRaw: { diagnosis: "INSUFFICIENT_FUNDS", actions: ["RETRY_PAYMENT"] },
          diagnosisCause: "INSUFFICIENT_FUNDS",
          diagnosisConfidence: "0.92",
          recommendedActions: [{ type: "RETRY_PAYMENT", parameters: { attempt_number: 1 } }],
          stopConditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT"],
          status: "COMPLETED",
          latencyMs: 340,
          inputTokens: 1200,
          outputTokens: 150,
          costMinorUnits: 12n,
        })
        .returning(),
      db
        .insert(workflows)
        .values({
          tenantId,
          caseId,
          temporalWorkflowId: `recover:${caseId}`,
          runId: `run_${Date.now()}`,
          type: "FailedPaymentRecoveryWorkflow",
          status: "RUNNING",
          startedAt: new Date(),
        })
        .returning(),
      db
        .insert(messages)
        .values({
          tenantId,
          caseId,
          customerId,
          channel: "EMAIL",
          direction: "OUTBOUND",
          templateId: "payment_retry_notice_v1",
          variables: { customer_name: "Jane", amount: "$150.00" },
          toAddress: "jane.recovery@example.com",
          provider: "SMTP_EMAIL",
          idempotencyKey: `${tenantId}:${caseId}:EMAIL:payment_retry_notice_v1:step_1`,
          status: "SENT",
          sentAt: new Date(),
        })
        .returning(),
    ]);

    decisionId = decision.id;
    workflowId = wf.id;
    messageId = msg.id;
  }, 30000);

  afterAll(async () => {
    if (tenantId) {
      // Clean up in parallel dependency batches. Policy rows are cleaned by
      // TENANT (not just the beforeAll rule id): any test that inserts extra
      // rules/versions for this tenant would otherwise block tenant deletion
      // via policy_rules_tenant_id_tenants_id_fk.
      const tenantRules = await db
        .select({ id: policyRules.id })
        .from(policyRules)
        .where(sql`tenant_id = ${tenantId}`);
      const tenantRuleIds = tenantRules.map((r) => r.id);
      if (tenantRuleIds.length > 0) {
        await db
          .delete(policyVersions)
          .where(inArray(policyVersions.ruleId, tenantRuleIds));
      }
      // Clean up in parallel dependency batches
      await Promise.all([
        db.delete(policyEvaluations).where(sql`tenant_id = ${tenantId}`),
        db.delete(humanTasks).where(sql`tenant_id = ${tenantId}`),
        db.delete(promisesToPay).where(sql`tenant_id = ${tenantId}`),
        db.delete(messageDeliveryEvents).where(sql`message_id = ${messageId}`),
        db.delete(workflowEvents).where(sql`workflow_row_id = ${workflowId}`),
        db.delete(recoveryActions).where(sql`tenant_id = ${tenantId}`),
        db.delete(recoveryCostEntries).where(sql`tenant_id = ${tenantId}`),
        db.delete(recoveryOutcomes).where(sql`tenant_id = ${tenantId}`),
        db.delete(caseEvents).where(sql`tenant_id = ${tenantId}`),
        db.delete(auditLogs).where(sql`tenant_id = ${tenantId}`),
      ]);

      await Promise.all([
        db.delete(messages).where(sql`tenant_id = ${tenantId}`),
        db.delete(customerResponses).where(sql`tenant_id = ${tenantId}`),
        db.delete(workflows).where(sql`tenant_id = ${tenantId}`),
        db.delete(aiDecisions).where(sql`tenant_id = ${tenantId}`),
        db.delete(policyRules).where(sql`tenant_id = ${tenantId}`),
      ]);

      await Promise.all([
        db.delete(recoveryCases).where(sql`tenant_id = ${tenantId}`),
        db.delete(revenueRisks).where(sql`tenant_id = ${tenantId}`),
        db.delete(events).where(sql`tenant_id = ${tenantId}`),
      ]);

      await db.delete(payments).where(sql`id = ${paymentId}`);
      await db.delete(customers).where(sql`id = ${customerId}`);
      await db.delete(tenants).where(sql`id = ${tenantId}`);
    }
  }, 30000);

  // ==========================================
  // FIVE ANTI-DUPLICATION ANCHORS
  // ==========================================

  it("Anchor 1: events rejects duplicate (source, external_event_id)", async () => {
    const extId = `evt_ext_${Date.now()}`;
    await db.insert(events).values({
      tenantId,
      source: "STRIPE",
      externalEventId: extId,
      type: "payment.failed",
      rawPayload: { id: extId },
      payload: { payment_id: "pi_123" },
      correlationId: "22222222-2222-2222-2222-222222222222",
      status: "RECEIVED",
      receivedAt: new Date(),
    });

    // Duplicate insert must fail
    await expect(
      Promise.resolve(
        db.insert(events).values({
          tenantId,
          source: "STRIPE",
          externalEventId: extId, // Duplicate
          type: "payment.failed",
          rawPayload: { id: extId },
          payload: { payment_id: "pi_123" },
          correlationId: "33333333-3333-3333-3333-333333333333",
          status: "RECEIVED",
          receivedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("Anchor 2: recovery_cases partial unique index rejects second live case for same obligation", async () => {
    // Current case for obligationId has status 'DETECTED' (live)
    await expect(
      Promise.resolve(
        db.insert(recoveryCases).values({
          tenantId,
          caseNumber: 1002,
          customerId,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: obligationId, // Duplicate live obligation
          amountAtRisk: 15000n,
          currency: "USD",
          riskScore: 90,
          status: "IN_PROGRESS",
          attributionWindowHours: 72,
          openedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("Partial Index Behavior: allows creating new case after previous case reaches terminal status", async () => {
    const termObligationId = "44444444-4444-4444-4444-444444444444";

    // 1. Create first case with terminal status RECOVERED
    const [closedCase] = await db
      .insert(recoveryCases)
      .values({
        tenantId,
        caseNumber: 2001,
        customerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: termObligationId,
        amountAtRisk: 5000n,
        currency: "USD",
        riskScore: 70,
        status: "RECOVERED", // Terminal status
        attributionWindowHours: 72,
        openedAt: new Date(),
        closedAt: new Date(),
      })
      .returning();

    expect(closedCase.id).toBeDefined();

    // 2. Create new live case for the same obligation -> MUST SUCCEED
    const [newLiveCase] = await db
      .insert(recoveryCases)
      .values({
        tenantId,
        caseNumber: 2002,
        customerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: termObligationId, // Same obligation
        amountAtRisk: 5000n,
        currency: "USD",
        riskScore: 80,
        status: "DETECTED", // Live status
        attributionWindowHours: 72,
        openedAt: new Date(),
      })
      .returning();

    expect(newLiveCase.id).toBeDefined();

    // Clean up
    await db.delete(recoveryCases).where(sql`id IN (${closedCase.id}, ${newLiveCase.id})`);
  });

  it("Anchor 3: recovery_actions rejects duplicate idempotency_key", async () => {
    const actionKey = `${tenantId}:${caseId}:RETRY_PAYMENT:1`;
    const [action] = await db
      .insert(recoveryActions)
      .values({
        tenantId,
        caseId,
        decisionId,
        type: "RETRY_PAYMENT",
        parameters: { attempt_number: 1 },
        status: "PROPOSED",
        attemptNumber: 1,
        idempotencyKey: actionKey,
      })
      .returning();

    expect(action.id).toBeDefined();

    // Duplicate action key must fail
    await expect(
      Promise.resolve(
        db.insert(recoveryActions).values({
          tenantId,
          caseId,
          decisionId,
          type: "RETRY_PAYMENT",
          parameters: { attempt_number: 1 },
          status: "PROPOSED",
          attemptNumber: 1,
          idempotencyKey: actionKey, // Duplicate
        }),
      ),
    ).rejects.toThrow();
  });

  it("Anchor 4: messages rejects duplicate idempotency_key", async () => {
    const msgKey = `${tenantId}:${caseId}:EMAIL:payment_retry_notice_v1:step_1`;
    // Already inserted in beforeAll
    await expect(
      Promise.resolve(
        db.insert(messages).values({
          tenantId,
          caseId,
          customerId,
          channel: "EMAIL",
          direction: "OUTBOUND",
          templateId: "payment_retry_notice_v1",
          variables: {},
          toAddress: "jane.recovery@example.com",
          provider: "SMTP_EMAIL",
          idempotencyKey: msgKey, // Duplicate
          status: "QUEUED",
        }),
      ),
    ).rejects.toThrow();
  });

  it("Anchor 5: recovery_outcomes rejects duplicate case_id", async () => {
    const [outcome] = await db
      .insert(recoveryOutcomes)
      .values({
        tenantId,
        caseId,
        paymentId,
        baselineAmount: 15000n,
        recoveredAmount: 15000n,
        recoveryCost: 250n,
        attributionMethod: "WORKFLOW_LINKED",
        attributionWindowHours: 72,
        recoveredAt: new Date(),
      })
      .returning();

    expect(outcome.id).toBeDefined();

    // Second outcome for same case must fail
    await expect(
      Promise.resolve(
        db.insert(recoveryOutcomes).values({
          tenantId,
          caseId, // Duplicate case_id
          paymentId,
          baselineAmount: 15000n,
          recoveredAmount: 15000n,
          recoveryCost: 250n,
          attributionMethod: "ATTRIBUTION_WINDOW",
          attributionWindowHours: 72,
          recoveredAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  // ==========================================
  // GENERATED COLUMN & INVARIANT CHECKS
  // ==========================================

  it("calculates net_recovered correctly via GENERATED ALWAYS column in recovery_outcomes", async () => {
    const [outcome] = await db
      .select()
      .from(recoveryOutcomes)
      .where(sql`case_id = ${caseId}`);

    expect(outcome).toBeDefined();
    expect(outcome.recoveredAmount).toBe(15000n);
    expect(outcome.recoveryCost).toBe(250n);
    // net_recovered = 15000 - 250 = 14750
    expect(outcome.netRecovered).toBe(14750n);
  });

  it("rejects invalid score on revenue_risks via CHECK (score BETWEEN 0 AND 100)", async () => {
    await expect(
      Promise.resolve(
        db.insert(revenueRisks).values({
          tenantId,
          customerId,
          riskType: "PAYMENT_FAILURE",
          subjectType: "PAYMENT",
          subjectId: paymentId,
          score: 105, // > 100
          band: "CRITICAL",
          factors: {},
          status: "OPEN",
          computedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();

    await expect(
      Promise.resolve(
        db.insert(revenueRisks).values({
          tenantId,
          customerId,
          riskType: "PAYMENT_FAILURE",
          subjectType: "PAYMENT",
          subjectId: paymentId,
          score: -5, // < 0
          band: "LOW",
          factors: {},
          status: "OPEN",
          computedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects non-positive amount_at_risk on recovery_cases via CHECK (amount_at_risk > 0)", async () => {
    await expect(
      Promise.resolve(
        db.insert(recoveryCases).values({
          tenantId,
          caseNumber: 9999,
          customerId,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: "55555555-5555-5555-5555-555555555555",
          amountAtRisk: 0n, // Zero
          currency: "USD",
          riskScore: 50,
          status: "DETECTED",
          attributionWindowHours: 72,
          openedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects non-positive promised_amount on promises_to_pay via CHECK (promised_amount > 0)", async () => {
    await expect(
      Promise.resolve(
        db.insert(promisesToPay).values({
          tenantId,
          caseId,
          promisedAmount: 0n,
          currency: "USD",
          promisedByDate: "2026-09-15",
          status: "MADE",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects diagnosis_confidence outside [0, 1] on ai_decisions", async () => {
    await expect(
      Promise.resolve(
        db.insert(aiDecisions).values({
          tenantId,
          caseId,
          model: "gpt-4o",
          promptVersion: "prompt_v1",
          inputSnapshot: {},
          recommendedActions: [],
          diagnosisConfidence: "1.50", // > 1
          status: "COMPLETED",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate (tenant_id, case_number) on recovery_cases", async () => {
    await expect(
      Promise.resolve(
        db.insert(recoveryCases).values({
          tenantId,
          caseNumber: 1001, // Duplicate case_number for same tenant
          customerId,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "INVOICE",
          sourceEntityId: "66666666-6666-6666-6666-666666666666",
          amountAtRisk: 20000n,
          currency: "USD",
          riskScore: 60,
          status: "DETECTED",
          attributionWindowHours: 72,
          openedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate case_id and temporal_workflow_id on workflows", async () => {
    // Duplicate case_id
    await expect(
      Promise.resolve(
        db.insert(workflows).values({
          tenantId,
          caseId, // Duplicate case_id
          temporalWorkflowId: `recover:different_${Date.now()}`,
          type: "FailedPaymentRecoveryWorkflow",
          status: "RUNNING",
        }),
      ),
    ).rejects.toThrow();

    // Duplicate temporal_workflow_id
    const [tempCase] = await db
      .insert(recoveryCases)
      .values({
        tenantId,
        caseNumber: 3001,
        customerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: "77777777-7777-7777-7777-777777777777",
        amountAtRisk: 1000n,
        currency: "USD",
        riskScore: 50,
        status: "DETECTED",
      })
      .returning();

    await expect(
      Promise.resolve(
        db.insert(workflows).values({
          tenantId,
          caseId: tempCase.id,
          temporalWorkflowId: `recover:${caseId}`, // Duplicate workflow id
          type: "FailedPaymentRecoveryWorkflow",
          status: "RUNNING",
        }),
      ),
    ).rejects.toThrow();

    await db.delete(recoveryCases).where(sql`id = ${tempCase.id}`);
  });

  it("rejects duplicate policy_rule code and policy_version (rule_id, version)", async () => {
    // Duplicate code (must match the beforeAll row's code to conflict)
    await expect(
      Promise.resolve(
        db.insert(policyRules).values({
          tenantId,
          code: policyRuleCode, // Duplicate
          name: "Max Payment Retries Duplicate",
          ruleKind: "LIMIT",
          definition: {},
        }),
      ),
    ).rejects.toThrow();

    // Duplicate version
    await expect(
      Promise.resolve(
        db.insert(policyVersions).values({
          ruleId: policyRuleId,
          version: 1, // Duplicate version
          snapshot: {},
        }),
      ),
    ).rejects.toThrow();
  });

  // ==========================================
  // CASCADE DELETIONS FOR APPEND-ONLY LOGS
  // ==========================================

  it("cascades deletion from workflows to workflow_events", async () => {
    const [tempCase] = await db
      .insert(recoveryCases)
      .values({
        tenantId,
        caseNumber: 4001,
        customerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: "88888888-8888-8888-8888-888888888888",
        amountAtRisk: 1000n,
        currency: "USD",
        riskScore: 50,
        status: "DETECTED",
      })
      .returning();

    const [tempWf] = await db
      .insert(workflows)
      .values({
        tenantId,
        caseId: tempCase.id,
        temporalWorkflowId: `recover:temp_${Date.now()}`,
        type: "FailedPaymentRecoveryWorkflow",
        status: "RUNNING",
      })
      .returning();

    await db.insert(workflowEvents).values({
      workflowRowId: tempWf.id,
      type: "WORKFLOW_STEP_EXECUTED",
      payload: { step: 1 },
    });

    // Delete parent workflow
    await db.delete(workflows).where(sql`id = ${tempWf.id}`);

    // Verify child events cascaded
    const eventsRemaining = await db
      .select()
      .from(workflowEvents)
      .where(sql`workflow_row_id = ${tempWf.id}`);
    expect(eventsRemaining.length).toBe(0);

    await db.delete(recoveryCases).where(sql`id = ${tempCase.id}`);
  });

  it("cascades deletion from messages to message_delivery_events", async () => {
    const [tempMsg] = await db
      .insert(messages)
      .values({
        tenantId,
        caseId,
        customerId,
        channel: "WHATSAPP",
        direction: "OUTBOUND",
        templateId: "wa_temp_1",
        toAddress: "+15551234567",
        provider: "WHATSAPP_CLOUD",
        idempotencyKey: `temp_msg_${Date.now()}`,
        status: "SENT",
      })
      .returning();

    await db.insert(messageDeliveryEvents).values({
      messageId: tempMsg.id,
      status: "DELIVERED",
      payload: { provider_event: "delivered" },
    });

    // Delete parent message
    await db.delete(messages).where(sql`id = ${tempMsg.id}`);

    // Verify child delivery events cascaded
    const eventsRemaining = await db
      .select()
      .from(messageDeliveryEvents)
      .where(sql`message_id = ${tempMsg.id}`);
    expect(eventsRemaining.length).toBe(0);
  });

  it("supports idempotency_keys lease locking and expiration index", async () => {
    const key = `evt:stripe:evt_${Date.now()}`;
    const [idemp] = await db
      .insert(idempotencyKeys)
      .values({
        key,
        requestHash: "sha256_hash_12345",
        status: "PROCESSING",
        lockedUntil: new Date(Date.now() + 30000),
        expiresAt: new Date(Date.now() + 86400000),
      })
      .returning();

    expect(idemp.key).toBe(key);
    expect(idemp.status).toBe("PROCESSING");

    await db.delete(idempotencyKeys).where(sql`key = ${key}`);
  });

  // ==========================================
  // SPEC-MANDATED INDEX VERIFICATION
  // ==========================================

  it("confirms presence of all Step 05 spec-mandated indexes in pg_indexes", async () => {
    const result = await db.execute<{ indexname: string; tablename: string }>(
      sql`SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public';`,
    );

    const indexNames = result.map((r) => r.indexname);

    // Events indexes
    expect(indexNames).toContain("events_source_external_event_id_unique");
    expect(indexNames).toContain("events_tenant_type_received_at_idx");
    expect(indexNames).toContain("events_status_unprocessed_idx");

    // Revenue risks indexes
    expect(indexNames).toContain("revenue_risks_status_score_idx");
    expect(indexNames).toContain("revenue_risks_tenant_subject_idx");

    // Recovery cases indexes
    expect(indexNames).toContain("recovery_cases_tenant_case_number_unique");
    expect(indexNames).toContain("recovery_cases_tenant_source_entity_live_unique");
    expect(indexNames).toContain("recovery_cases_status_opened_at_idx");
    expect(indexNames).toContain("recovery_cases_customer_id_idx");
    expect(indexNames).toContain("recovery_cases_tenant_status_idx");

    // AI decisions indexes
    expect(indexNames).toContain("ai_decisions_case_created_at_idx");

    // Recovery actions indexes
    expect(indexNames).toContain("recovery_actions_idempotency_key_unique");
    expect(indexNames).toContain("recovery_actions_case_created_at_idx");

    // Workflows indexes
    expect(indexNames).toContain("workflows_case_id_unique");
    expect(indexNames).toContain("workflows_temporal_workflow_id_unique");
    expect(indexNames).toContain("workflow_events_workflow_occurred_at_idx");

    // Messages & responses indexes
    expect(indexNames).toContain("messages_idempotency_key_unique");
    expect(indexNames).toContain("messages_case_created_at_idx");
    expect(indexNames).toContain("messages_customer_channel_sent_at_idx");
    expect(indexNames).toContain("message_delivery_events_message_occurred_at_idx");
    expect(indexNames).toContain("customer_responses_customer_received_at_idx");

    // Promises to pay indexes
    expect(indexNames).toContain("promises_to_pay_case_id_idx");

    // Human tasks indexes
    expect(indexNames).toContain("human_tasks_status_sla_due_at_idx");
    expect(indexNames).toContain("human_tasks_case_id_idx");

    // Policies indexes
    expect(indexNames).toContain("policy_rules_code_unique");
    expect(indexNames).toContain("policy_versions_rule_version_unique");
    expect(indexNames).toContain("policy_evaluations_tenant_id_idx");

    // Audit logs & case events indexes
    expect(indexNames).toContain("audit_logs_case_created_at_idx");
    expect(indexNames).toContain("audit_logs_tenant_created_at_idx");
    expect(indexNames).toContain("case_events_case_occurred_at_idx");

    // Outcomes & cost entries indexes
    expect(indexNames).toContain("recovery_outcomes_case_id_unique");
    expect(indexNames).toContain("recovery_cost_entries_case_category_idx");

    // Idempotency keys index
    expect(indexNames).toContain("idempotency_keys_expires_at_idx");
  });
});
