import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createActivityMocks } from "../testing/mocks";
import {
  WORKFLOW_ID,
  stopSignal,
  externalCheckoutCompletedSignal,
  workflowStateQuery,
  type RecoveryWorkflowInput,
} from "./shared";
import { checkoutAbandonmentWorkflow } from "./checkout-abandonment";
import { startRecoveryWorkflow } from "../client";
// eslint-disable-next-line no-restricted-imports
import { db, createTenant, createCustomer, createCheckout, createCase, recordCheckoutEvent, findWatchable } from "@repo/db";
import { scoreCheckout } from "../../../../apps/backend/src/modules/risk/engine/score-checkout";

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

if (typeof BigInt !== "undefined" && !BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function (this: bigint) {
    return this.toString();
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Step 23 — Workflow B: Checkout Abandonment Matrix", () => {
  // Time-skipped waits can exceed the default 30s timeout on loaded machines.
  vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    // Retry time-skipping: parallel vitest files can collide starting the
    // Java test server. Fall back to an ISOLATED local test server on an
    // ephemeral port — never :7233 (real compose Temporal, no `default` ns).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        testEnv = await TestWorkflowEnvironment.createTimeSkipping();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    console.warn(
      "[worker-tests] time-skipping test server unavailable; using real-time local server",
    );
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 120000);

  afterAll(async () => {
    if (testEnv) {
      await testEnv.teardown();
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: Completes before timer -> workflow exits, NO case created
  // ---------------------------------------------------------------------------
  it("1. completes before timer: early purchase signal -> workflow exits silently, NO case created", async () => {
    const checkoutId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async checkCheckoutStatus() {
        return {
          exists: true,
          status: "COMPLETED",
          isCompleted: true,
          isAbandoned: false,
          cartValue: "799900",
          currency: "INR",
          customerId: "cust-1",
          lastActivityAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId: checkoutId,
      checkoutId,
      workflowType: "checkoutAbandonmentWorkflow",
      metadata: {
        inactivityDelay: "30m",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        checkoutAbandonmentWorkflow,
        {
          workflowId: WORKFLOW_ID(checkoutId),
          taskQueue,
          args: [input],
        },
      );

      // Signal completion early during the 30m watch window
      await handle.signal(externalCheckoutCompletedSignal, {
        checkoutId,
        completedAt: new Date().toISOString(),
      });

      return await handle.result();
    });

    expect(result.outcome).toBe("COMPLETED_BEFORE_ABANDONMENT");
    // Verify NO case was ever created
    expect(spy.calls["confirmAbandonmentAndCreateCase"]).toBeUndefined();
    expect(spy.calls["sendTemplateMessage"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Completes after reminder -> RECOVERED, exactly one reminder sent
  // ---------------------------------------------------------------------------
  it("2. completes after reminder: reminder sent -> purchase during 4h window -> RECOVERED (exactly 1 reminder sent)", async () => {
    const checkoutId = randomUUID();
    const caseId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async checkCheckoutStatus() {
        return {
          exists: true,
          status: "STARTED",
          isCompleted: false,
          isAbandoned: true,
          cartValue: "799900",
          currency: "INR",
          customerId: "cust-1",
          lastActivityAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        };
      },
      async confirmAbandonmentAndCreateCase() {
        return {
          isCompleted: false,
          caseId,
          caseNumber: 2002,
          riskScore: 75,
          riskBand: "HIGH",
          customerId: "cust-1",
          cartValueMinor: "799900",
          currency: "INR",
          reminderChannel: "WHATSAPP",
          reminderTemplate: "checkout_abandonment_reminder",
          reminderVariables: {
            customer_name: "John",
            cart_value: "7999.00",
            currency: "INR",
            checkout_url: `https://checkout.example.com/pay/${checkoutId}`,
          },
          incentiveApproved: true,
          incentiveDiscountMinor: 50000,
          incentiveChannel: "WHATSAPP",
          incentiveTemplate: "checkout_incentive_reminder",
          incentiveVariables: {
            customer_name: "John",
            discount_amount: "500",
            currency: "INR",
            checkout_url: `https://checkout.example.com/pay/${checkoutId}?coupon=SAVE500`,
          },
          actions: [
            { type: "SEND_WHATSAPP", parameters: { template: "checkout_abandonment_reminder" } },
          ],
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId: checkoutId,
      checkoutId,
      workflowType: "checkoutAbandonmentWorkflow",
      metadata: {
        inactivityDelay: "1s",
        reminderWaitDelay: "4h",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        checkoutAbandonmentWorkflow,
        {
          workflowId: WORKFLOW_ID(checkoutId),
          taskQueue,
          args: [input],
        },
      );

      // Wait until workflow enters TOUCH_1_WAIT_DELAY
      for (let i = 0; i < 50; i++) {
        const state = await handle.query(workflowStateQuery);
        if (state.currentStep === "TOUCH_1_WAIT_DELAY") {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      await handle.signal(externalCheckoutCompletedSignal, {
        checkoutId,
        paymentId: `pay_${randomUUID()}`,
        amount: "799900",
        currency: "INR",
      });

      return await handle.result();
    });

    expect(result.outcome).toBe("RECOVERED");
    expect(result.stage).toBe("AFTER_REMINDER");
    // Exactly one reminder message sent
    expect(spy.calls["sendTemplateMessage"]?.length).toBe(1);
    expect(spy.calls["recordOutcome"]).toBeDefined();
    // Touch-1 zero-discount invariant (audit s-23): first touch must carry no
    // discount*/coupon* keys in template variables.
    {
      const touch1Input = spy.calls["sendTemplateMessage"]?.[0]?.[0] as {
        templateName?: string;
        templateVariables?: Record<string, string>;
        stepKey?: string;
      };
      expect(touch1Input.templateName).toBe("checkout_abandonment_reminder");
      const varKeys = Object.keys(touch1Input.templateVariables ?? {});
      expect(varKeys.filter((k) => k.toLowerCase().includes("discount"))).toEqual([]);
      expect(varKeys.filter((k) => k.toLowerCase().includes("coupon"))).toEqual([]);
      const varValues = Object.values(touch1Input.templateVariables ?? {}).join(" ").toLowerCase();
      expect(varValues).not.toContain("coupon");
      expect(varValues).not.toContain("save500");
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Full path with incentive: abandoned -> reminder -> wait -> incentive -> purchase -> RECOVERED
  // ---------------------------------------------------------------------------
  it("3. full path with incentive: abandoned -> reminder -> wait -> incentive -> purchase -> RECOVERED", async () => {
    const checkoutId = randomUUID();
    const caseId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async checkCheckoutStatus() {
        return {
          exists: true,
          status: "STARTED",
          isCompleted: false,
          isAbandoned: true,
          cartValue: "799900",
          currency: "INR",
          customerId: "cust-1",
          lastActivityAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        };
      },
      async confirmAbandonmentAndCreateCase() {
        return {
          isCompleted: false,
          caseId,
          caseNumber: 2003,
          riskScore: 75,
          riskBand: "HIGH",
          customerId: "cust-1",
          cartValueMinor: "799900",
          currency: "INR",
          reminderChannel: "WHATSAPP",
          reminderTemplate: "checkout_abandonment_reminder",
          reminderVariables: {
            customer_name: "Alice",
            cart_value: "7999.00",
            currency: "INR",
            checkout_url: `https://checkout.example.com/pay/${checkoutId}`,
          },
          incentiveApproved: true,
          incentiveDiscountMinor: 50000,
          incentiveChannel: "WHATSAPP",
          incentiveTemplate: "checkout_incentive_reminder",
          incentiveVariables: {
            customer_name: "Alice",
            discount_amount: "500",
            currency: "INR",
            checkout_url: `https://checkout.example.com/pay/${checkoutId}?coupon=SAVE500`,
          },
          actions: [
            { type: "SEND_WHATSAPP", parameters: { template: "checkout_abandonment_reminder" } },
            { type: "OFFER_INCENTIVE", parameters: { discount_minor: 50000 } },
          ],
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId: checkoutId,
      checkoutId,
      workflowType: "checkoutAbandonmentWorkflow",
      metadata: {
        inactivityDelay: "1s",
        reminderWaitDelay: "1s",
        incentiveWaitDelay: "24h",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        checkoutAbandonmentWorkflow,
        {
          workflowId: WORKFLOW_ID(checkoutId),
          taskQueue,
          args: [input],
        },
      );

      // Wait until workflow enters TOUCH_2_WAIT_DELAY (reminder + incentive sent)
      for (let i = 0; i < 50; i++) {
        const state = await handle.query(workflowStateQuery);
        if (state.currentStep === "TOUCH_2_WAIT_DELAY") {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      await handle.signal(externalCheckoutCompletedSignal, {
        checkoutId,
        paymentId: `pay_${randomUUID()}`,
        amount: "799900",
        currency: "INR",
      });

      return await handle.result();
    });

    expect(result.outcome).toBe("RECOVERED");
    // Verifies two touches were sent (Reminder + Incentive)
    expect(spy.calls["sendTemplateMessage"]?.length).toBe(2);
    expect(spy.calls["recordOutcome"]).toBeDefined();
    // Touch-1 zero-discount + Touch-2 incentive assertions (audit s-23).
    {
      const touch1 = spy.calls["sendTemplateMessage"]?.[0]?.[0] as {
        templateName?: string;
        templateVariables?: Record<string, string>;
      };
      const touch2 = spy.calls["sendTemplateMessage"]?.[1]?.[0] as {
        templateName?: string;
        templateVariables?: Record<string, string>;
      };
      const t1Keys = Object.keys(touch1.templateVariables ?? {});
      expect(t1Keys.filter((k) => k.toLowerCase().includes("discount"))).toEqual([]);
      expect(t1Keys.filter((k) => k.toLowerCase().includes("coupon"))).toEqual([]);
      expect(Object.values(touch1.templateVariables ?? {}).join(" ").toLowerCase()).not.toContain("coupon");
      // Touch 2 must carry the policy-approved incentive.
      expect(touch2.templateName).toBe("checkout_incentive_reminder");
      const t2Keys = Object.keys(touch2.templateVariables ?? {});
      expect(t2Keys.some((k) => k.toLowerCase().includes("discount"))).toBe(true);
      const t2Values = Object.values(touch2.templateVariables ?? {}).join(" ").toLowerCase();
      expect(t2Values).toContain("coupon");
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Incentive rejected by policy (amount > cap) -> second touch skipped -> STOPPED(NO_ACTION_ALLOWED)
  // ---------------------------------------------------------------------------
  it("4. incentive rejected by policy(amount>cap): second touch skipped -> STOPPED(NO_ACTION_ALLOWED)", async () => {
    const checkoutId = randomUUID();
    const caseId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async checkCheckoutStatus() {
        return {
          exists: true,
          status: "STARTED",
          isCompleted: false,
          isAbandoned: true,
          cartValue: "799900",
          currency: "INR",
          customerId: "cust-1",
          lastActivityAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        };
      },
      async confirmAbandonmentAndCreateCase() {
        return {
          isCompleted: false,
          caseId,
          caseNumber: 2004,
          riskScore: 75,
          riskBand: "HIGH",
          customerId: "cust-1",
          cartValueMinor: "799900",
          currency: "INR",
          reminderChannel: "WHATSAPP",
          reminderTemplate: "checkout_abandonment_reminder",
          reminderVariables: {
            customer_name: "Bob",
            cart_value: "7999.00",
            currency: "INR",
            checkout_url: `https://checkout.example.com/pay/${checkoutId}`,
          },
          // Incentive rejected by policy cap
          incentiveApproved: false,
          actions: [
            { type: "SEND_WHATSAPP", parameters: { template: "checkout_abandonment_reminder" } },
          ],
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId: checkoutId,
      checkoutId,
      workflowType: "checkoutAbandonmentWorkflow",
      metadata: {
        inactivityDelay: "1s",
        reminderWaitDelay: "1s",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        checkoutAbandonmentWorkflow,
        {
          workflowId: WORKFLOW_ID(checkoutId),
          taskQueue,
          args: [input],
        },
      );

      return await handle.result();
    });

    expect(result.outcome).toBe("STOPPED");
    expect(result.stopReason).toBe("NO_ACTION_ALLOWED");
    // Only 1 reminder sent (Touch 2 was skipped because policy rejected incentive)
    expect(spy.calls["sendTemplateMessage"]?.length).toBe(1);
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
    // Touch-1 zero-discount invariant holds even when Touch-2 is skipped (audit s-23).
    {
      const touch1 = spy.calls["sendTemplateMessage"]?.[0]?.[0] as {
        templateVariables?: Record<string, string>;
      };
      const keys = Object.keys(touch1.templateVariables ?? {});
      expect(keys.filter((k) => k.toLowerCase().includes("discount"))).toEqual([]);
      expect(keys.filter((k) => k.toLowerCase().includes("coupon"))).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: Race: purchase lands between state-check and send -> send aborted (spy), closes RECOVERED
  // ---------------------------------------------------------------------------
  it("5. race: purchase lands between state-check and send -> send aborted (spy), workflow closes RECOVERED", async () => {
    const checkoutId = randomUUID();
    const caseId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async checkCheckoutStatus() {
        return {
          exists: true,
          status: "STARTED",
          isCompleted: false,
          isAbandoned: true,
          cartValue: "799900",
          currency: "INR",
          customerId: "cust-1",
          lastActivityAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        };
      },
      async confirmAbandonmentAndCreateCase() {
        return {
          isCompleted: false,
          caseId,
          caseNumber: 2005,
          riskScore: 75,
          riskBand: "HIGH",
          customerId: "cust-1",
          cartValueMinor: "799900",
          currency: "INR",
          reminderChannel: "WHATSAPP",
          reminderTemplate: "checkout_abandonment_reminder",
          reminderVariables: {
            customer_name: "Racer",
            cart_value: "7999.00",
            currency: "INR",
            checkout_url: `https://checkout.example.com/pay/${checkoutId}`,
          },
          incentiveApproved: true,
          incentiveDiscountMinor: 50000,
          actions: [],
        };
      },
      // Race guard detects concurrent completion
      async checkoutRaceGuard() {
        return {
          safeToSend: false,
          isCompleted: true,
          completedAt: new Date().toISOString(),
          status: "COMPLETED",
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId: checkoutId,
      checkoutId,
      workflowType: "checkoutAbandonmentWorkflow",
      metadata: {
        inactivityDelay: "1s",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        checkoutAbandonmentWorkflow,
        {
          workflowId: WORKFLOW_ID(checkoutId),
          taskQueue,
          args: [input],
        },
      );

      return await handle.result();
    });

    expect(result.outcome).toBe("RECOVERED");
    expect(result.stage).toBe("RACE_ABORTED_BEFORE_REMINDER");
    // Send was aborted by race guard!
    expect(spy.calls["sendTemplateMessage"]).toBeUndefined();
    expect(spy.calls["recordOutcome"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Duplicate started events -> one workflow
  // ---------------------------------------------------------------------------
  it("6. duplicate started events: second started event handled idempotently -> one workflow", async () => {
    const tenant = await createTenant(
      { db },
      { name: "Checkout Dup Tenant", slug: `chk-dup-${randomUUID()}` },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        email: `chk_dup_${randomUUID()}@example.com`,
        name: "Dup Customer",
      },
    );
    const checkout = await createCheckout(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        cartValue: 799900n,
        currency: "INR",
        status: "STARTED",
        startedAt: new Date(),
        lastActivityAt: new Date(),
      },
    );

    // Initial check: watchable is true
    const check1 = await findWatchable(
      { db },
      { tenantId: tenant.id, checkoutId: checkout.id },
    );
    expect(check1.watchable).toBe(true);

    // Record WATCH_STARTED event
    await recordCheckoutEvent(
      { db },
      {
        tenantId: tenant.id,
        checkoutId: checkout.id,
        type: "WATCH_STARTED",
        payload: { abandonment_workflow_started: true },
      },
    );

    // Second check: watchable is false (prevents duplicate workflows)
    const check2 = await findWatchable(
      { db },
      { tenantId: tenant.id, checkoutId: checkout.id },
    );
    expect(check2.watchable).toBe(false);
    expect(check2.alreadyStarted).toBe(true);

    // Create a case record to test client-level idempotency
    const caseRec = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "IN_PROGRESS",
        riskType: "CHECKOUT_ABANDONMENT",
        sourceEntityType: "CHECKOUT",
        sourceEntityId: checkout.id,
        amountAtRisk: 799900n,
        currency: "INR",
        riskScore: 75,
      },
    );

    const res1 = await startRecoveryWorkflow({
      tenantId: tenant.id,
      caseId: caseRec.id,
      workflowType: "CheckoutAbandonmentWorkflow",
    });
    expect(res1.accepted).toBe(true);

    const res2 = await startRecoveryWorkflow({
      tenantId: tenant.id,
      caseId: caseRec.id,
      workflowType: "CheckoutAbandonmentWorkflow",
    });
    expect(res2.accepted).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Opt-out after reminder -> stop, no incentive
  // ---------------------------------------------------------------------------
  it("7. opt-out after reminder: customer opt-out signal -> immediate stop, no incentive sent", async () => {
    const checkoutId = randomUUID();
    const caseId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async checkCheckoutStatus() {
        return {
          exists: true,
          status: "STARTED",
          isCompleted: false,
          isAbandoned: true,
          cartValue: "799900",
          currency: "INR",
          customerId: "cust-1",
          lastActivityAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
          startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        };
      },
      async confirmAbandonmentAndCreateCase() {
        return {
          isCompleted: false,
          caseId,
          caseNumber: 2007,
          riskScore: 75,
          riskBand: "HIGH",
          customerId: "cust-1",
          cartValueMinor: "799900",
          currency: "INR",
          reminderChannel: "WHATSAPP",
          reminderTemplate: "checkout_abandonment_reminder",
          reminderVariables: {
            customer_name: "OptOutUser",
            cart_value: "7999.00",
            currency: "INR",
            checkout_url: `https://checkout.example.com/pay/${checkoutId}`,
          },
          incentiveApproved: true,
          incentiveDiscountMinor: 50000,
          actions: [],
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId: checkoutId,
      checkoutId,
      workflowType: "checkoutAbandonmentWorkflow",
      metadata: {
        inactivityDelay: "1s",
        reminderWaitDelay: "24h",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        checkoutAbandonmentWorkflow,
        {
          workflowId: WORKFLOW_ID(checkoutId),
          taskQueue,
          args: [input],
        },
      );

      // Wait until workflow enters TOUCH_1_WAIT_DELAY
      for (let i = 0; i < 50; i++) {
        const state = await handle.query(workflowStateQuery);
        if (state.currentStep === "TOUCH_1_WAIT_DELAY") {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      await handle.signal(stopSignal, {
        reason: "CUSTOMER_OPTED_OUT",
      });

      return await handle.result();
    });

    expect(result.outcome).toBe("STOPPED");
    expect(result.stopReason).toBe("CUSTOMER_OPTED_OUT");
    // Exactly 1 message sent (Reminder). Incentive was NEVER sent.
    expect(spy.calls["sendTemplateMessage"]?.length).toBe(1);
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: High-intent scoring: cart ₹7,999 fixture -> HIGH band (Scenario B parity)
  // ---------------------------------------------------------------------------
  it("8. high-intent scoring: cart ₹7,999 fixture scores into HIGH band (Spec 03 Scenario B parity)", () => {
    const customer = {
      id: "cust-scenario-b",
      tenantId: "tenant-1",
      externalRef: "cus_002",
      name: "Scenario B Customer",
      email: "scenario.b@example.com",
      phone: "+919876543210",
      status: "ACTIVE",
      lifetimeValue: 500000n,
      optedOut: false,
      optedOutAt: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as unknown as Parameters<typeof scoreCheckout>[0]["customer"];

    const checkout = {
      id: "chk-scenario-b",
      tenantId: "tenant-1",
      customerId: customer.id,
      cartValue: 799900n, // ₹7,999 in paise (Spec 03 Scenario B fixture)
      currency: "INR",
      items: [],
      status: "ABANDONED",
      sourceRef: null,
      startedAt: new Date(Date.now() - 30 * 60 * 1000),
      lastActivityAt: new Date(Date.now() - 25 * 60 * 1000),
      completedAt: null,
      abandonedAt: new Date(),
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof scoreCheckout>[0]["checkout"];

    const paymentsHistory = [
      { id: "p1", status: "FAILED", createdAt: new Date() },
      { id: "p2", status: "FAILED", createdAt: new Date() },
      { id: "p3", status: "SUCCEEDED", createdAt: new Date() },
      { id: "p4", status: "SUCCEEDED", createdAt: new Date() },
      { id: "p5", status: "SUCCEEDED", createdAt: new Date() },
    ] as unknown as Parameters<typeof scoreCheckout>[0]["paymentsHistory"];

    const result = scoreCheckout({
      tenantId: "tenant-1",
      customerId: customer.id,
      customer,
      checkout,
      paymentsHistory,
      checkoutEvents: [],
      now: new Date(),
    });

    // Verify high checkout intent rule triggered and score is in HIGH band (60-84)
    expect(result.factors.breakdown["high_checkout_intent"]).toBe(15);
    expect(result.band).toBe("HIGH");
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.score).toBeLessThanOrEqual(84);
  });
});
