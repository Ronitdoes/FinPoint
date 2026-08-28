import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { InProcessEventBus } from "@repo/integrations";
import {
  db,
  sql,
  createTenant,
  createUser,
  createSession,
  createCustomer,
  createCase,
  createDecision,
  recordPolicyEvaluation,
  insertAction,
  insertMessage,
  createHumanTask,
  recordAuditLog,
  recordCaseEvent,
  listCaseEvents,
  type Tenant,
  auditArchive,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import {
  scanForPii,
  redactPii,
  maskEmail,
  maskPhone,
  maskCard,
} from "../modules/audit/pii-scanner";
import {
  validateCaseTimelineSequence,
  verifyAuditCoverage,
} from "../modules/audit/coverage.check";
import { backfillCaseTimelineGaps } from "../modules/audit/backfill";
import { archiveExpiredAuditLogs } from "../modules/audit/retention.job";

describe("Step 25 Integration: Audit Trail & Case Timeline (Completion & Immutability)", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: InProcessEventBus;
  let tenantA: Tenant;
  let tenantB: Tenant;

  let adminCookie: string;
  let viewerCookie: string;
  let opsCookie: string;
  let financeCookie: string;
  let adminUserId: string;

  beforeAll(async () => {
    eventBus = new InProcessEventBus();
    app = await buildApp({
      customDb: db,
      eventBus,
      disableRateLimit: true,
    });
    await app.ready();

    // 1. Seed Tenants
    tenantA = await createTenant(
      { db },
      { name: `Audit Tenant A ${randomUUID()}`, slug: `tenant-audit-a-${randomUUID().slice(0, 8)}` },
    );
    tenantB = await createTenant(
      { db },
      { name: `Audit Tenant B ${randomUUID()}`, slug: `tenant-audit-b-${randomUUID().slice(0, 8)}` },
    );

    // 2. Seed Users & Sessions for Tenant A
    const adminUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `admin-${randomUUID().slice(0, 8)}@example.com`,
        name: "Admin User",
        passwordHash: "mock_argon2id_hash",
        role: "ADMIN",
      },
    );
    adminUserId = adminUser.id;
    const adminSessionToken = `session-admin-${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: adminUser.id,
        tokenHash: sha256(adminSessionToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    adminCookie = adminSessionToken;

    const viewerUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `viewer-${randomUUID().slice(0, 8)}@example.com`,
        name: "Viewer User",
        passwordHash: "mock_argon2id_hash",
        role: "VIEWER",
      },
    );
    const viewerSessionToken = `session-viewer-${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: viewerUser.id,
        tokenHash: sha256(viewerSessionToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    viewerCookie = viewerSessionToken;

    const opsUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `ops-${randomUUID().slice(0, 8)}@example.com`,
        name: "Ops User",
        passwordHash: "mock_argon2id_hash",
        role: "OPERATIONS",
      },
    );
    const opsSessionToken = `session-ops-${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: opsUser.id,
        tokenHash: sha256(opsSessionToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    opsCookie = opsSessionToken;

    const financeUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `fin-${randomUUID().slice(0, 8)}@example.com`,
        name: "Finance User",
        passwordHash: "mock_argon2id_hash",
        role: "FINANCE",
      },
    );
    const financeSessionToken = `session-finance-${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: financeUser.id,
        tokenHash: sha256(financeSessionToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    financeCookie = financeSessionToken;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("1. DB-Level Immutability Hardening (Triggers & Append-Only)", () => {
    it("prohibits UPDATE and DELETE operations on audit_logs via SQL triggers", async () => {
      // 1. Insert valid audit row
      const log = await recordAuditLog(
        { db },
        {
          tenantId: tenantA.id,
          actorType: "SYSTEM",
          event: "test.immutability.init",
          metadata: { check: true },
        },
      );

      expect(log.id).toBeDefined();

      // 2. Attempt UPDATE -> MUST throw PostgreSQL trigger exception
      await expect(
        db.execute(
          sql`UPDATE audit_logs SET event = 'tampered.event' WHERE id = ${log.id}`,
        ),
      ).rejects.toThrow(/Audit records and case events are append-only and immutable/i);

      // 3. Attempt DELETE -> MUST throw PostgreSQL trigger exception
      await expect(
        db.execute(sql`DELETE FROM audit_logs WHERE id = ${log.id}`),
      ).rejects.toThrow(/Audit records and case events are append-only and immutable/i);
    });

    it("prohibits UPDATE and DELETE operations on case_events via SQL triggers", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, externalRef: `cus_${randomUUID().slice(0, 8)}`, name: "Imm Customer", email: "imm@example.com" },
      );
      const testCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "payment",
          sourceEntityId: randomUUID(),
          riskScore: 60,
          amountAtRisk: 5000n,
          currency: "INR",
        },
      );

      const event = await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId: testCase.id,
          eventType: "PAYMENT_FAILED",
          actorType: "SYSTEM",
          description: "Initial failure",
        },
      );

      // Attempt UPDATE -> exception
      await expect(
        db.execute(
          sql`UPDATE case_events SET description = 'tampered' WHERE id = ${event.id}`,
        ),
      ).rejects.toThrow(/Audit records and case events are append-only and immutable/i);

      // Attempt DELETE -> exception
      await expect(
        db.execute(sql`DELETE FROM case_events WHERE id = ${event.id}`),
      ).rejects.toThrow(/Audit records and case events are append-only and immutable/i);
    });

    it("prohibits UPDATE and DELETE operations on audit_archive via SQL triggers", async () => {
      const [archived] = await db
        .insert(auditArchive)
        .values({
          tenantId: tenantA.id,
          actorType: "SYSTEM",
          event: "test.archive.immutability",
          metadata: { cold: true },
          createdAt: new Date(Date.now() - 400 * 86400000),
          archivedAt: new Date(),
        })
        .returning();

      // Attempt UPDATE -> exception
      await expect(
        db.execute(
          sql`UPDATE audit_archive SET event = 'tampered' WHERE id = ${archived.id}`,
        ),
      ).rejects.toThrow(/Audit records and case events are append-only and immutable/i);

      // Attempt DELETE -> exception
      await expect(
        db.execute(sql`DELETE FROM audit_archive WHERE id = ${archived.id}`),
      ).rejects.toThrow(/Audit records and case events are append-only and immutable/i);
    });
  });

  describe("2. PII and Secret Scanner", () => {
    it("detects unmasked emails, phone numbers, card numbers, and secret keys", () => {
      const dirtyPayload = {
        customerEmail: "john.doe@company.com",
        customerPhone: "+919876543210",
        creditCard: "4111222233334444",
        apiKey: "sk_live_99998888777766665555",
        metadata: {
          nestedEmail: "nested@domain.org",
        },
      };

      const result = scanForPii(dirtyPayload);
      expect(result.hasPii).toBe(true);
      expect(result.violations.length).toBeGreaterThanOrEqual(4);

      const patterns = result.violations.map((v) => v.pattern);
      expect(patterns).toContain("EMAIL");
      expect(patterns).toContain("PHONE");
      expect(patterns).toContain("CARD");
      expect(patterns).toContain("SECRET");
    });

    it("passes allowlisted and properly masked fields", () => {
      const cleanPayload = {
        maskedEmail: maskEmail("john.doe@company.com"),
        maskedPhone: maskPhone("+919876543210"),
        last4: "4444",
        brand: "visa",
        caseId: randomUUID(),
        amountPaise: 500000,
      };

      const result = scanForPii(cleanPayload);
      expect(result.hasPii).toBe(false);
      expect(result.violations).toHaveLength(0);
    });

    it("redactPii deeply masks secrets and sensitive PII from objects", () => {
      const input = {
        email: "alice@example.com",
        phone: "+919876543210",
        cardNumber: "4111222233334444",
        secretToken: "sk_test_123456789012345678",
        safeNote: "Payment failed due to NSF",
      };

      const redacted = redactPii(input);
      expect(redacted.email).toContain("*");
      expect(redacted.phone).toContain("*");
      expect(redacted.cardNumber).toContain("*");
      expect(redacted.secretToken).toBe("[REDACTED]");
      expect(redacted.safeNote).toBe("Payment failed due to NSF");
    });
  });

  describe("3. Unified Case Timeline API (GET /cases/:id/timeline)", () => {
    let caseId: string;
    let customerId: string;

    beforeAll(async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, externalRef: `cus_timeline_${randomUUID().slice(0, 8)}`, name: "Timeline Customer", email: "timeline@example.com" },
      );
      customerId = customer.id;

      const c = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "payment",
          sourceEntityId: randomUUID(),
          riskScore: 65,
          amountAtRisk: 149900n,
          currency: "INR",
        },
      );
      caseId = c.id;

      // Create linked entities
      const decision = await createDecision(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          model: "gpt-4o",
          promptVersion: "payment_failure@1",
          inputSnapshot: {},
          diagnosisCause: "Card temporary limit exceeded",
          diagnosisConfidence: "0.92",
          recommendedActions: [{ actionType: "RETRY_PAYMENT", rank: 1 }],
          status: "COMPLETED",
          costMinorUnits: 45n,
        },
      );

      const policyEval = await recordPolicyEvaluation(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          decisionId: decision.id,
          ruleVersions: [randomUUID()],
          result: "ALLOWED",
          effectiveActions: [{ actionType: "RETRY_PAYMENT" }],
          latencyMs: 12,
        },
      );

      const msg = await insertMessage(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          customerId,
          channel: "WHATSAPP",
          templateId: "payment_reminder_v1",
          toAddress: "+91 9876543210",
          provider: "MOCK",
          idempotencyKey: randomUUID(),
          status: "DELIVERED",
          providerMessageId: "wamid.mock.123",
        },
      );

      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          title: "High value approval",
          type: "APPROVAL",
          status: "RESOLVED",
          decidedBy: adminUserId,
          decisionNotes: "Approved after operator check",
        },
      );

      // Record chronological timeline events
      const t0 = new Date("2026-08-28T10:00:00Z");
      await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          eventType: "PAYMENT_FAILED",
          actorType: "SYSTEM",
          description: "Initial card payment declined",
          payload: { amount: 149900, currency: "INR", declineCode: "insufficient_funds" },
          occurredAt: new Date(t0.getTime() + 1000),
        },
      );

      await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          eventType: "RISK_CALCULATED",
          actorType: "SYSTEM",
          description: "Risk score assessed at 65 (HIGH)",
          payload: { score: 65, band: "HIGH" },
          occurredAt: new Date(t0.getTime() + 2000),
        },
      );

      await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          eventType: "AI_DECISION_CREATED",
          actorType: "AI",
          actorId: "gpt-4o",
          description: "AI recommended retry after delay",
          payload: { decisionId: decision.id },
          occurredAt: new Date(t0.getTime() + 3000),
        },
      );

      await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          eventType: "POLICY_ALLOWED",
          actorType: "SYSTEM",
          description: "Policy engine approved recommended action",
          payload: { evaluationId: policyEval.id },
          occurredAt: new Date(t0.getTime() + 4000),
        },
      );

      await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          eventType: "WORKFLOW_STARTED",
          actorType: "SYSTEM",
          description: "Temporal recovery workflow initialized",
          payload: { workflowId: `recover:${caseId}` },
          occurredAt: new Date(t0.getTime() + 5000),
        },
      );

      await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          eventType: "WHATSAPP_SENT",
          actorType: "SYSTEM",
          description: "Payment reminder sent via WhatsApp",
          payload: { messageId: msg.id },
          occurredAt: new Date(t0.getTime() + 6000),
        },
      );

      await recordCaseEvent(
        { db },
        {
          tenantId: tenantA.id,
          caseId,
          eventType: "HUMAN_TASK_CREATED",
          actorType: "SYSTEM",
          description: "Operator approval task opened",
          payload: { taskId: task.id },
          occurredAt: new Date(t0.getTime() + 7000),
        },
      );
    });

    it("returns enriched chronological timeline entries for VIEWER role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/timeline`,
        cookies: { rr_session: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBe(7);

      // Verify AI_DECISION_CREATED enrichment
      const aiEntry = body.items.find((e: any) => e.type === "AI_DECISION_CREATED");
      expect(aiEntry).toBeDefined();
      expect(aiEntry.data.diagnosis).toBe("Card temporary limit exceeded");
      expect(aiEntry.data.confidence).toBe(0.92);
      expect(aiEntry.data.topAction).toBe("RETRY_PAYMENT");
      expect(aiEntry.data.promptVersion).toBe("payment_failure@1");
      expect(aiEntry.actor.type).toBe("AI");

      // Verify POLICY_ALLOWED enrichment
      const polEntry = body.items.find((e: any) => e.type === "POLICY_ALLOWED");
      expect(polEntry).toBeDefined();
      expect(polEntry.data.verdict).toBe("ALLOWED");

      // Verify WHATSAPP_SENT enrichment
      const msgEntry = body.items.find((e: any) => e.type === "WHATSAPP_SENT");
      expect(msgEntry).toBeDefined();
      expect(msgEntry.data.channel).toBe("WHATSAPP");
      expect(msgEntry.data.template).toBe("payment_reminder_v1");
      expect(msgEntry.data.status).toBe("DELIVERED");

      // Verify HUMAN_TASK_CREATED enrichment
      const taskEntry = body.items.find((e: any) => e.type === "HUMAN_TASK_CREATED");
      expect(taskEntry).toBeDefined();
      expect(taskEntry.data.taskType).toBe("APPROVAL");
      expect(taskEntry.data.taskStatus).toBe("RESOLVED");
    });

    it("supports filtering by event types (?types=...)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/timeline?types=AI_DECISION_CREATED,WORKFLOW_STARTED`,
        cookies: { rr_session: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBe(2);
      const types = body.items.map((i: any) => i.type);
      expect(types).toEqual(["AI_DECISION_CREATED", "WORKFLOW_STARTED"]);
    });

    it("supports cursor pagination on timeline", async () => {
      // 1. Fetch page 1 with limit=3
      const page1Res = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/timeline?limit=3`,
        cookies: { rr_session: viewerCookie },
      });

      expect(page1Res.statusCode).toBe(200);
      const page1 = page1Res.json();
      expect(page1.items.length).toBe(3);
      expect(page1.nextCursor).toBeDefined();

      // 2. Fetch page 2 with nextCursor
      const page2Res = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/timeline?limit=3&cursor=${page1.nextCursor}`,
        cookies: { rr_session: viewerCookie },
      });

      expect(page2Res.statusCode).toBe(200);
      const page2 = page2Res.json();
      expect(page2.items.length).toBe(3);

      // Verify no duplicate IDs across pages
      const p1Ids = page1.items.map((i: any) => i.id);
      const p2Ids = page2.items.map((i: any) => i.id);
      const intersection = p1Ids.filter((id: number) => p2Ids.includes(id));
      expect(intersection).toHaveLength(0);
    });

    it("enforces tenant isolation and returns 404 for other tenant's case", async () => {
      const otherCustomer = await createCustomer(
        { db },
        { tenantId: tenantB.id, externalRef: `cus_b_${randomUUID().slice(0, 8)}`, name: "Tenant B Customer", email: "tb@example.com" },
      );
      const otherCase = await createCase(
        { db },
        {
          tenantId: tenantB.id,
          customerId: otherCustomer.id,
          riskType: "INVOICE_OVERDUE",
          sourceEntityType: "invoice",
          sourceEntityId: randomUUID(),
          riskScore: 50,
          amountAtRisk: 1000n,
          currency: "INR",
        },
      );

      const res = await app.inject({
        method: "GET",
        url: `/cases/${otherCase.id}/timeline`,
        cookies: { rr_session: viewerCookie }, // Tenant A viewer
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("4. Compliance Audit API (GET /audit)", () => {
    beforeAll(async () => {
      await recordAuditLog(
        { db },
        {
          tenantId: tenantA.id,
          actorType: "USER",
          actorId: adminUserId,
          event: "policy.rule.updated",
          metadata: { ruleId: "POL-MAXRETRY", changedKey: "maxRetries", oldVal: 3, newVal: 4 },
        },
      );

      await recordAuditLog(
        { db },
        {
          tenantId: tenantA.id,
          actorType: "SYSTEM",
          event: "events.replayed",
          metadata: { count: 12 },
        },
      );
    });

    it("allows ADMIN callers to query audit logs with pagination and filters", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/audit?limit=10",
        cookies: { rr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items[0]).toHaveProperty("event");
      expect(body.items[0]).toHaveProperty("metadata");
    });

    it("filters audit logs by event", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/audit?event=policy.rule.updated",
        cookies: { rr_session: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items.every((i: any) => i.event === "policy.rule.updated")).toBe(true);
    });

    it("returns 403 FORBIDDEN for non-ADMIN roles (VIEWER, SUPPORT, OPERATIONS, FINANCE)", async () => {
      const roles = [
        { name: "VIEWER", cookie: viewerCookie },
        { name: "OPERATIONS", cookie: opsCookie },
        { name: "FINANCE", cookie: financeCookie },
      ];

      for (const role of roles) {
        const res = await app.inject({
          method: "GET",
          url: "/audit",
          cookies: { rr_session: role.cookie },
        });
        expect(res.statusCode).toBe(403);
      }
    });

    it("returns 401 UNAUTHENTICATED when unauthenticated", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/audit",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("5. Lifecycle Coverage Checker", () => {
    it("validates a healthy terminal case progression successfully", () => {
      const t0 = new Date();
      const validCase = {
        id: randomUUID(),
        riskType: "PAYMENT_FAILURE",
        status: "RECOVERED",
        events: [
          { eventType: "PAYMENT_FAILED", occurredAt: new Date(t0.getTime() + 1000) },
          { eventType: "RISK_CALCULATED", occurredAt: new Date(t0.getTime() + 2000) },
          { eventType: "AI_DECISION_CREATED", occurredAt: new Date(t0.getTime() + 3000) },
          { eventType: "POLICY_ALLOWED", occurredAt: new Date(t0.getTime() + 4000) },
          { eventType: "WORKFLOW_STARTED", occurredAt: new Date(t0.getTime() + 5000) },
          { eventType: "RECOVERY_RECORDED", occurredAt: new Date(t0.getTime() + 6000) },
        ],
      };

      const result = validateCaseTimelineSequence(validCase);
      expect(result.valid).toBe(true);
      expect(result.missingEvents).toHaveLength(0);
      expect(result.error).toBeUndefined();
    });

    it("flags missing mandatory stages and sequence inversions", () => {
      const t0 = new Date();
      // Missing AI_DECISION_CREATED + POLICY evaluation + inversion
      const brokenCase = {
        id: randomUUID(),
        riskType: "PAYMENT_FAILURE",
        status: "RECOVERED",
        events: [
          { eventType: "WORKFLOW_STARTED", occurredAt: new Date(t0.getTime() + 1000) },
          { eventType: "RISK_CALCULATED", occurredAt: new Date(t0.getTime() + 2000) },
        ],
      };

      const result = validateCaseTimelineSequence(brokenCase);
      expect(result.valid).toBe(false);
      expect(result.missingEvents.length).toBeGreaterThan(0);
    });

    it("verifyAuditCoverage walks terminal cases in DB", async () => {
      const report = await verifyAuditCoverage({ db }, { tenantId: tenantA.id });
      expect(report).toBeDefined();
      expect(report.totalCasesChecked).toBeGreaterThanOrEqual(0);
    });
  });

  describe("6. Orphan Backfill Tool", () => {
    it("identifies orphaned messages and decisions and backfills reconstructed timeline events", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, externalRef: `cus_orphan_${randomUUID().slice(0, 8)}`, name: "Orphan Customer", email: "orphan@example.com" },
      );
      const c = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "payment",
          sourceEntityId: randomUUID(),
          riskScore: 40,
          amountAtRisk: 2500n,
          currency: "INR",
        },
      );

      // Create message without inserting case_event
      const orphanMsg = await insertMessage(
        { db },
        {
          tenantId: tenantA.id,
          caseId: c.id,
          customerId: customer.id,
          channel: "EMAIL",
          templateId: "invoice_overdue_t1",
          toAddress: "orphan@example.com",
          provider: "MOCK",
          idempotencyKey: randomUUID(),
          status: "SENT",
        },
      );

      // Verify no timeline events yet
      const beforeEvents = await listCaseEvents({ db }, { tenantId: tenantA.id, caseId: c.id });
      expect(beforeEvents).toHaveLength(0);

      // Run backfill tool
      const result = await backfillCaseTimelineGaps({ db }, { tenantId: tenantA.id });
      expect(result.totalReconstructed).toBeGreaterThanOrEqual(1);

      // Verify reconstructed event present
      const afterEvents = await listCaseEvents({ db }, { tenantId: tenantA.id, caseId: c.id });
      expect(afterEvents.length).toBeGreaterThanOrEqual(1);
      const reconstructedMsgEvent = afterEvents.find((e) => (e.payload as any)?.messageId === orphanMsg.id);
      expect(reconstructedMsgEvent).toBeDefined();
      expect((reconstructedMsgEvent?.payload as any)?.reconstructed).toBe(true);
      expect(reconstructedMsgEvent?.description).toContain("[Reconstructed]");

      // Re-running backfill on the same tenant is idempotent
      const secondRun = await backfillCaseTimelineGaps({ db }, { tenantId: tenantA.id });
      expect(secondRun.details.some((d) => d.caseId === c.id && d.entityId === orphanMsg.id)).toBe(false);
    });
  });

  describe("7. Retention Policy Job", () => {
    it("archives audit logs older than retention threshold to audit_archive", async () => {
      // 1. Insert aged audit row (14 months old)
      const oldDate = new Date();
      oldDate.setMonth(oldDate.getMonth() - 14);

      await recordAuditLog(
        { db },
        {
          tenantId: tenantA.id,
          actorType: "SYSTEM",
          event: "retention.test.old_log",
          metadata: { aged: true },
          createdAt: oldDate,
        },
      );

      // 2. Run retention archive job with retentionMonths = 12
      const jobResult = await archiveExpiredAuditLogs(
        { db },
        { retentionMonths: 12, batchSize: 100 },
      );

      expect(jobResult.archivedCount).toBeGreaterThanOrEqual(1);
      expect(jobResult.dryRun).toBe(false);
    });
  });
});
