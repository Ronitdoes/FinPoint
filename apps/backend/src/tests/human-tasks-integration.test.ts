import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { InProcessEventBus, TOPIC_MAIN } from "@repo/integrations";
import {
  db,
  createTenant,
  createUser,
  createSession,
  createCustomer,
  createInvoice,
  createCase,
  createApiKey,
  insertAction,
  findCaseById,
  findHumanTaskById,
  listActionsForCase,
  listCaseEvents,
  createHumanTask,
  type Tenant,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import { SlaSweeper } from "../modules/human-tasks/sla-sweeper";
import { escalateWorkflowFailure } from "../../../../services/worker/src/activities/escalate-workflow-failure";

describe("Step 21 Integration: Human Escalation, Approvals & SLA Subsystem", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: InProcessEventBus;
  let tenantA: Tenant;
  let tenantB: Tenant;

  let viewerCookie: string;
  let opsCookie: string;
  let financeCookie: string;
  let adminApiKeyHeader: string;
  let opsUserId: string;
  let financeUserId: string;

  beforeAll(async () => {
    eventBus = new InProcessEventBus();
    app = await buildApp({
      customDb: db,
      eventBus,
      disableRateLimit: true,
    });
    await app.ready();

    // 1. Seed Tenant A & Tenant B
    tenantA = await createTenant(
      { db },
      { name: `Tenant Human A ${randomUUID()}`, slug: `tenant-ht-a-${randomUUID().slice(0, 8)}` },
    );

    tenantB = await createTenant(
      { db },
      { name: `Tenant Human B ${randomUUID()}`, slug: `tenant-ht-b-${randomUUID().slice(0, 8)}` },
    );

    // 2. Seed Users & Sessions for Tenant A
    const viewerUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `viewer-${randomUUID().slice(0, 6)}@test.com`,
        passwordHash: "hashed",
        name: "Viewer User",
        role: "VIEWER",
      },
    );
    const viewerSessionToken = `sess_viewer_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: viewerUser.id,
        tokenHash: sha256(viewerSessionToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );
    viewerCookie = `rr_session=${viewerSessionToken}`;

    const opsUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `ops-${randomUUID().slice(0, 6)}@test.com`,
        passwordHash: "hashed",
        name: "Operations User",
        role: "OPERATIONS",
      },
    );
    opsUserId = opsUser.id;
    const opsSessionToken = `sess_ops_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: opsUser.id,
        tokenHash: sha256(opsSessionToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );
    opsCookie = `rr_session=${opsSessionToken}`;

    const financeUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `fin-${randomUUID().slice(0, 6)}@test.com`,
        passwordHash: "hashed",
        name: "Finance User",
        role: "FINANCE",
      },
    );
    financeUserId = financeUser.id;
    const financeSessionToken = `sess_fin_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: financeUser.id,
        tokenHash: sha256(financeSessionToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );
    financeCookie = `rr_session=${financeSessionToken}`;

    // Machine API key (ADMIN)
    const rawApiKey = `rrk_${tenantA.slug}_${randomUUID()}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantA.id,
        name: "Admin API Key",
        keyHash: sha256(rawApiKey),
        scopes: ["*"],
      },
    );
    adminApiKeyHeader = `Bearer ${rawApiKey}`;
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  describe("1. Task Creation & Default SLA Timers", () => {
    it("creates a human task with default SLA due duration per type", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Test Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "INVOICE",
          sourceEntityId: randomUUID(),
          riskType: "INVOICE_OVERDUE",
          amountAtRisk: BigInt(500000),
          currency: "INR",
          riskScore: 85,
          status: "ESCALATED",
        },
      );

      const beforeCreation = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/human-tasks",
        headers: { cookie: opsCookie },
        payload: {
          case_id: caseRow.id,
          type: "APPROVAL",
          title: "Approve high-value invoice recovery action",
          description: "Customer requested a payment plan for large invoice",
          priority: "HIGH",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.caseId).toBe(caseRow.id);
      expect(body.type).toBe("APPROVAL");
      expect(body.status).toBe("PENDING");
      expect(body.priority).toBe("HIGH");
      expect(body.isOverdue).toBe(false);

      // Default APPROVAL SLA is 24 hours
      const slaDueAt = new Date(body.slaDueAt).getTime();
      const expectedSlaMin = beforeCreation + 23.9 * 60 * 60 * 1000;
      const expectedSlaMax = beforeCreation + 24.1 * 60 * 60 * 1000;
      expect(slaDueAt).toBeGreaterThanOrEqual(expectedSlaMin);
      expect(slaDueAt).toBeLessThanOrEqual(expectedSlaMax);
    }, 30000);

    it("enforces length caps and payload validation", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/human-tasks",
        headers: { cookie: opsCookie },
        payload: {
          case_id: randomUUID(),
          type: "APPROVAL",
          title: "", // empty title
        },
      });

      expect(res.statusCode).toBe(422);
    }, 30000);
  });

  describe("2. Task Listing, Filtering & Isolation", () => {
    it("lists tasks with embedded case summary and filters by status, type, overdue", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Dispute Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "INVOICE",
          sourceEntityId: randomUUID(),
          riskType: "INVOICE_OVERDUE",
          amountAtRisk: BigInt(250000),
          currency: "INR",
          riskScore: 70,
          status: "ESCALATED",
        },
      );

      // Create a pending dispute task
      await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "DISPUTE_REVIEW",
          title: "Disputed invoice review",
          priority: "MEDIUM",
          status: "PENDING",
          slaDueAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      );

      const res = await app.inject({
        method: "GET",
        url: "/human-tasks?type=DISPUTE_REVIEW&status=PENDING",
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      const found = body.items.find((t: any) => t.title === "Disputed invoice review");
      expect(found).toBeDefined();
      expect(found.case).toBeDefined();
      expect(found.case.id).toBe(caseRow.id);
      expect(found.case.amountAtRisk).toBe("250000");
    }, 30000);

    it("enforces tenant isolation: Tenant B cannot access Tenant A task", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Isolated Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          riskType: "PAYMENT_FAILURE",
          amountAtRisk: BigInt(10000),
          currency: "INR",
          riskScore: 60,
          status: "ESCALATED",
        },
      );

      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "APPROVAL",
          title: "Tenant A Private Task",
          status: "PENDING",
        },
      );

      // Create Tenant B session
      const userB = await createUser(
        { db },
        {
          tenantId: tenantB.id,
          email: `userb-${randomUUID()}@test.com`,
          passwordHash: "hashed",
          name: "Admin User B",
          role: "ADMIN",
        },
      );
      const tokenB = `sess_b_${randomUUID()}`;
      await createSession(
        { db },
        {
          userId: userB.id,
          tokenHash: sha256(tokenB),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      );

      const res = await app.inject({
        method: "GET",
        url: `/human-tasks/${task.id}`,
        headers: { cookie: `rr_session=${tokenB}` },
      });

      expect(res.statusCode).toBe(404);
    }, 30000);
  });

  describe("3. Task Approval Workflow & Guarded Side Effects", () => {
    it("full approve path transitions task, flips case to IN_PROGRESS, approves pending actions, and is idempotent", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Approve Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "INVOICE",
          sourceEntityId: randomUUID(),
          riskType: "INVOICE_OVERDUE",
          amountAtRisk: BigInt(1000000),
          currency: "INR",
          riskScore: 90,
          status: "ESCALATED",
        },
      );

      // Create action in APPROVAL_REQUIRED
      const action = await insertAction(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "OFFER_INCENTIVE",
          parameters: { kind: "DISCOUNT", amount_minor: 50000 },
          status: "APPROVAL_REQUIRED",
          idempotencyKey: `${tenantA.id}:${caseRow.id}:OFFER_INCENTIVE:1`,
        },
      );

      // Create APPROVAL human task
      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "APPROVAL",
          title: "Approve 5% invoice incentive",
          status: "PENDING",
        },
      );

      // 1. Approve task via OPERATIONS user
      const approveRes = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/approve`,
        headers: { cookie: opsCookie },
        payload: {
          notes: "Approved incentive after manager sign-off",
        },
      });

      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.json()).toEqual({ status: "APPROVED", taskId: task.id });

      // 2. Verify task state in DB
      const updatedTask = await findHumanTaskById(
        { db },
        { tenantId: tenantA.id, taskId: task.id },
      );
      expect(updatedTask?.status).toBe("APPROVED");
      expect(updatedTask?.decidedBy).toBe(opsUserId);
      expect(updatedTask?.decisionNotes).toBe("Approved incentive after manager sign-off");
      expect(updatedTask?.decidedAt).toBeDefined();
      expect(updatedTask?.temporalSignalSent).toBe(true);

      // 3. Verify case state flipped from ESCALATED to IN_PROGRESS
      const updatedCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: caseRow.id },
      );
      expect(updatedCase?.status).toBe("IN_PROGRESS");

      // 4. Verify action flipped from APPROVAL_REQUIRED to APPROVED
      const actions = await listActionsForCase(
        { db },
        { tenantId: tenantA.id, caseId: caseRow.id },
      );
      const updatedAction = actions.find((a) => a.id === action.id);
      expect(updatedAction?.status).toBe("APPROVED");

      // 5. Verify timeline event HUMAN_DECISION_RECORDED was logged
      const events = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: caseRow.id },
      );
      const decisionEvent = events.find((e) => e.eventType === "HUMAN_DECISION_RECORDED");
      expect(decisionEvent).toBeDefined();
      expect(decisionEvent?.description).toContain("Human task approved");

      // 6. Idempotency / conflict check: second approve call returns 409 Conflict
      const secondApproveRes = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/approve`,
        headers: { cookie: opsCookie },
        payload: { notes: "Another approval attempt" },
      });
      expect(secondApproveRes.statusCode).toBe(409);
    }, 30000);
  });

  describe("4. Task Rejection Flow & Mandatory Notes", () => {
    it("rejects task with mandatory notes, cancels pending actions, and prevents empty notes", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Reject Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "INVOICE",
          sourceEntityId: randomUUID(),
          riskType: "INVOICE_OVERDUE",
          amountAtRisk: BigInt(400000),
          currency: "INR",
          riskScore: 75,
          status: "ESCALATED",
        },
      );

      const action = await insertAction(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "OFFER_INCENTIVE",
          parameters: { kind: "DISCOUNT", amount_minor: 20000 },
          status: "APPROVAL_REQUIRED",
          idempotencyKey: `${tenantA.id}:${caseRow.id}:OFFER_INCENTIVE:2`,
        },
      );

      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "APPROVAL",
          title: "Approve discount",
          status: "PENDING",
        },
      );

      // Attempt rejection with empty notes -> 422
      const emptyNotesRes = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/reject`,
        headers: { cookie: opsCookie },
        payload: { notes: "" },
      });
      expect(emptyNotesRes.statusCode).toBe(422);

      // Valid rejection with notes
      const rejectRes = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/reject`,
        headers: { cookie: opsCookie },
        payload: { notes: "Customer history shows repeated default; discount rejected" },
      });
      expect(rejectRes.statusCode).toBe(200);
      expect(rejectRes.json()).toEqual({ status: "REJECTED", taskId: task.id });

      // Verify actions in APPROVAL_REQUIRED became CANCELLED (HUMAN_REJECTED)
      const actions = await listActionsForCase(
        { db },
        { tenantId: tenantA.id, caseId: caseRow.id },
      );
      const rejectedAction = actions.find((a) => a.id === action.id);
      expect(rejectedAction?.status).toBe("CANCELLED");
      expect((rejectedAction?.result as any)?.reason).toBe("HUMAN_REJECTED");
    }, 30000);
  });

  describe("5. Assignment, Cancellation & RBAC Matrix", () => {
    it("allows FINANCE to assign and cancel tasks", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Assign Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          riskType: "PAYMENT_FAILURE",
          amountAtRisk: BigInt(50000),
          currency: "INR",
          riskScore: 50,
          status: "ESCALATED",
        },
      );

      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "GENERAL",
          title: "General inquiry task",
          status: "PENDING",
        },
      );

      // Assign to ops user
      const assignRes = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/assign`,
        headers: { cookie: financeCookie },
        payload: { assignee_user_id: opsUserId },
      });

      expect(assignRes.statusCode).toBe(200);
      expect(assignRes.json().status).toBe("ASSIGNED");
      expect(assignRes.json().assignedTo).toBe(opsUserId);

      // Cancel task
      const cancelRes = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/cancel`,
        headers: { cookie: financeCookie },
        payload: { reason: "Duplicate customer inquiry" },
      });

      expect(cancelRes.statusCode).toBe(200);
      expect(cancelRes.json().status).toBe("CANCELLED");
    }, 30000);

    it("rejects API key attempting task approval with 403 (session-only invariant)", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "ApiKey Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          riskType: "PAYMENT_FAILURE",
          amountAtRisk: BigInt(10000),
          currency: "INR",
          riskScore: 40,
          status: "ESCALATED",
        },
      );

      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "APPROVAL",
          title: "API Key test task",
          status: "PENDING",
        },
      );

      const res = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/approve`,
        headers: { authorization: adminApiKeyHeader },
        payload: { notes: "API key trying to approve" },
      });

      expect(res.statusCode).toBe(403);
    }, 30000);

    it("rejects VIEWER role attempting task approval with 403", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Viewer Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          riskType: "PAYMENT_FAILURE",
          amountAtRisk: BigInt(10000),
          currency: "INR",
          riskScore: 40,
          status: "ESCALATED",
        },
      );

      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "APPROVAL",
          title: "Viewer role test task",
          status: "PENDING",
        },
      );

      const res = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/approve`,
        headers: { cookie: viewerCookie },
        payload: { notes: "Viewer trying to approve" },
      });

      expect(res.statusCode).toBe(403);
    }, 30000);
  });

  describe("6. SLA Sweeper & Event Bus Notification", () => {
    it("sweeps overdue tasks, marks overdueAt, and emits human-task.sla-breached event once", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "SLA Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "INVOICE",
          sourceEntityId: randomUUID(),
          riskType: "INVOICE_OVERDUE",
          amountAtRisk: BigInt(300000),
          currency: "INR",
          riskScore: 80,
          status: "ESCALATED",
        },
      );

      // Create an overdue task (SLA was 2 hours ago)
      const pastSla = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const overdueTask = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "COMPLIANCE_REVIEW",
          title: "Overdue Compliance Review",
          status: "PENDING",
          slaDueAt: pastSla,
        },
      );

      const publishedEvents: any[] = [];
      await eventBus.subscribe(TOPIC_MAIN, "test-sla-subscriber", async (event) => {
        if (event.type === "human-task.sla-breached") {
          publishedEvents.push(event);
        }
      });

      const sweeper = new SlaSweeper(db, app.repos, eventBus);
      const sweepResult = await sweeper.sweepOverdueTasks(new Date(), tenantA.id);

      expect(sweepResult.sweptCount).toBeGreaterThanOrEqual(1);

      // Verify task in DB has overdueAt set
      const reloaded = await findHumanTaskById(
        { db },
        { tenantId: tenantA.id, taskId: overdueTask.id },
      );
      expect(reloaded?.overdueAt).toBeDefined();

      // Verify domain event was published
      const matchingEvent = publishedEvents.find((e) => e.payload?.taskId === overdueTask.id);
      expect(matchingEvent).toBeDefined();
      expect(matchingEvent?.payload.taskType).toBe("COMPLIANCE_REVIEW");
      // s-21 audit fix: entity must reference the HUMAN_TASK, customer resolved
      // from the owning case (never task.caseId masquerading as customer_id).
      expect(matchingEvent?.entity_type).toBe("HUMAN_TASK");
      expect(matchingEvent?.entity_id).toBe(overdueTask.id);
      expect(matchingEvent?.customer_id).toBe(customer.id);
      expect(matchingEvent?.customer_id).not.toBe(caseRow.id);
      expect(matchingEvent?.tenant_id).toBe(tenantA.id);
      expect(matchingEvent?.payload.caseId).toBe(caseRow.id);
      expect(matchingEvent?.payload.customerId).toBe(customer.id);

      // Idempotency: second sweep should not re-flag the same task
      const secondSweep = await sweeper.sweepOverdueTasks(new Date(), tenantA.id);
      const secondMatch = publishedEvents.filter((e) => e.payload?.taskId === overdueTask.id);
      expect(secondMatch.length).toBe(1);
    }, 30000);
  });

  describe("7. Re-escalation Deduplication Guard (Step 21 Requirement 6)", () => {
    it("deduplicates repeated workflow failure escalations for the same case within 1 hour", async () => {
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: `cust-${randomUUID()}@example.com`, name: "Dedupe Customer" },
      );

      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          riskType: "PAYMENT_FAILURE",
          amountAtRisk: BigInt(80000),
          currency: "INR",
          riskScore: 70,
          status: "IN_PROGRESS",
        },
      );

      const actCtx = {
        tenantId: tenantA.id,
        caseId: caseRow.id,
        workflowId: `recover:${caseRow.id}`,
        runId: randomUUID(),
      };

      // 1. First failure -> creates new WORKFLOW_FAILURE task
      const res1 = await escalateWorkflowFailure({
        ...actCtx,
        errorName: "TimeoutError",
        errorMessage: "Network timed out contacting payment gateway",
        failedStep: "RETRY_PAYMENT",
      });

      expect(res1.success).toBe(true);
      expect(res1.isDeduplicated).toBe(false);
      const firstTaskId = res1.taskId;

      // 2. Second failure within 1h -> deduplicates to existing task
      const res2 = await escalateWorkflowFailure({
        ...actCtx,
        errorName: "TimeoutError",
        errorMessage: "Network timed out again",
        failedStep: "RETRY_PAYMENT",
      });

      expect(res2.success).toBe(true);
      expect(res2.isDeduplicated).toBe(true);
      expect(res2.taskId).toBe(firstTaskId);

      // Verify escalation_count was incremented
      const task = await findHumanTaskById(
        { db },
        { tenantId: tenantA.id, taskId: firstTaskId },
      );
      expect(task?.escalationCount).toBeGreaterThanOrEqual(2);
    }, 30000);
  });

  describe("8. Spec 03 §8 High-Value Invoice Approval Acceptance Test", () => {
    it("Scenario C: Enterprise invoice requires human approval, pauses until approved, then resumes", async () => {
      // Customer: CUS-003, Invoice: ₹4,80,000 (₹48000000 minor paise)
      const customer = await createCustomer(
        { db },
        { tenantId: tenantA.id, email: "enterprise-cus003@acme.com", name: "CUS-003 Enterprise" },
      );

      const invoice = await createInvoice(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          number: `INV-CUS003-${randomUUID().slice(0, 6)}`,
          amount: BigInt(48000000), // ₹4,80,000
          currency: "INR",
          status: "OVERDUE",
          dueAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days overdue
        },
      );

      // 1. Recovery case opens for high-value overdue invoice
      const caseRow = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          sourceEntityType: "INVOICE",
          sourceEntityId: invoice.id,
          riskType: "INVOICE_OVERDUE",
          amountAtRisk: BigInt(48000000),
          currency: "INR",
          riskScore: 92,
          status: "ESCALATED",
        },
      );

      // 2. Policy engine requires human approval for high value discount (> ₹5,000 cap)
      const action = await insertAction(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "OFFER_INCENTIVE",
          parameters: { kind: "DISCOUNT", amount_minor: 100000 }, // ₹1,000 discount
          status: "APPROVAL_REQUIRED",
          policyResult: { policyResult: "REQUIRE_APPROVAL", reason: "HIGH_VALUE_APPROVAL" },
          idempotencyKey: `${tenantA.id}:${caseRow.id}:OFFER_INCENTIVE:enterprise`,
        },
      );

      const task = await createHumanTask(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRow.id,
          type: "APPROVAL",
          title: "Enterprise Invoice Incentive Approval Required",
          description: "High-value invoice (₹4,80,000) incentive requires human sign-off",
          priority: "HIGH",
          status: "PENDING",
        },
      );

      // 3. Verify case is locked in ESCALATED and action is in APPROVAL_REQUIRED
      const lockedCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: caseRow.id },
      );
      expect(lockedCase?.status).toBe("ESCALATED");

      // 4. Operator reviews and approves task
      const approveRes = await app.inject({
        method: "POST",
        url: `/human-tasks/${task.id}/approve`,
        headers: { cookie: opsCookie },
        payload: { notes: "Enterprise discount authorized by Finance Director" },
      });

      expect(approveRes.statusCode).toBe(200);

      // 5. Verify case is now IN_PROGRESS and action is APPROVED for execution
      const resolvedCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: caseRow.id },
      );
      expect(resolvedCase?.status).toBe("IN_PROGRESS");

      const resolvedActions = await listActionsForCase(
        { db },
        { tenantId: tenantA.id, caseId: caseRow.id },
      );
      const approvedAction = resolvedActions.find((a) => a.id === action.id);
      expect(approvedAction?.status).toBe("APPROVED");
    }, 30000);
  });
});
