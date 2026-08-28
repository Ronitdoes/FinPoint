import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

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
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createActivityMocks } from "./mocks";
import {
  WORKFLOW_ID,
  pauseSignal,
  resumeSignal,
  stopSignal,
  humanDecisionSignal,
  workflowStateQuery,
  type RecoveryWorkflowInput,
} from "../workflows/shared";
import { recoveryWorkflowTemplate } from "../workflows/_template";
import { createNonRetryableFailure } from "../framework";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Step 20 — Temporal Recovery Worker & Workflow Harness", () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    try {
      testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    } catch {
      // If time-skipping binary is unavailable in local environment, connect to local compose Temporal server
      testEnv = await TestWorkflowEnvironment.createLocal({
        server: { port: 7233 },
      });
    }
  }, 60000);

  afterAll(async () => {
    if (testEnv) {
      await testEnv.teardown();
    }
  });

  it("executes happy path recovery workflow skeleton to completion (time-skipped)", async () => {
    const { mockActivities, spy } = createActivityMocks();
    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const tenantId = `tenant_${randomUUID()}`;
    const caseId = randomUUID();
    const workflowId = WORKFLOW_ID(caseId);

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "recoveryWorkflowTemplate",
      amountMinor: "50000",
      currency: "INR",
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(recoveryWorkflowTemplate, {
        workflowId,
        taskQueue,
        args: [input],
      });

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED" });
    expect(spy.calls["loadCaseSnapshot"]).toBeDefined();
    expect(spy.calls["checkPolicyAgain"]).toBeDefined();
    expect(spy.calls["recordOutcome"]).toBeDefined();
    expect(spy.calls["emitMetric"]).toBeDefined();
  });

  it("handles pause and resume signals cleanly across workflow execution checkpoints", async () => {
    const { mockActivities, spy } = createActivityMocks();
    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const tenantId = `tenant_${randomUUID()}`;
    const caseId = randomUUID();
    const workflowId = WORKFLOW_ID(caseId);

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "recoveryWorkflowTemplate",
    };

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(recoveryWorkflowTemplate, {
        workflowId,
        taskQueue,
        args: [input],
      });

      // Signal pause
      await handle.signal(pauseSignal);

      // Verify query state shows paused
      const state = await handle.query(workflowStateQuery);
      expect(state.isPaused).toBe(true);

      // Give worker a moment to process the checkpoint
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Signal resume
      await handle.signal(resumeSignal);

      const finalResult = await handle.result();
      expect(finalResult.outcome).toBe("RECOVERED");
    });

    expect(spy.calls["markCaseWaiting"]).toBeDefined();
    expect(spy.calls["markCaseInProgress"]).toBeDefined();
  });

  it("stops during execution and unwinds cleanly when stop signal is received", async () => {
    const { mockActivities, spy } = createActivityMocks();
    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const tenantId = `tenant_${randomUUID()}`;
    const caseId = randomUUID();
    const workflowId = WORKFLOW_ID(caseId);

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "recoveryWorkflowTemplate",
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(recoveryWorkflowTemplate, {
        workflowId,
        taskQueue,
        args: [input],
      });

      await handle.signal(stopSignal, { reason: "MANUAL_OPERATOR_OVERRIDE" });

      return await handle.result();
    });

    expect(result.outcome).toBe("STOPPED");
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
  });

  it("escalates workflow failure when non-retryable activity error occurs", async () => {
    const { mockActivities, spy } = createActivityMocks({
      async loadCaseSnapshot() {
        throw createNonRetryableFailure(
          "Unrecoverable snapshot failure",
          "VALIDATION_FAILED",
        );
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const tenantId = `tenant_${randomUUID()}`;
    const caseId = randomUUID();
    const workflowId = WORKFLOW_ID(caseId);

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "recoveryWorkflowTemplate",
    };

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(recoveryWorkflowTemplate, {
        workflowId,
        taskQueue,
        args: [input],
      });

      await expect(handle.result()).rejects.toThrow();
    });

    expect(spy.calls["escalateWorkflowFailure"]).toBeDefined();
  });

  it("resumes execution when human approval signal is received (Step 21)", async () => {
    let capturedTaskId = "";
    const { mockActivities, spy } = createActivityMocks({
      async createHumanTask() {
        capturedTaskId = `task_${randomUUID()}`;
        return {
          taskId: capturedTaskId,
          status: "PENDING",
          createdAt: new Date().toISOString(),
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const tenantId = `tenant_${randomUUID()}`;
    const caseId = randomUUID();
    const workflowId = WORKFLOW_ID(caseId);

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "recoveryWorkflowTemplate",
      metadata: {
        requireApproval: true,
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(recoveryWorkflowTemplate, {
        workflowId,
        taskQueue,
        args: [input],
      });

      // Allow workflow to advance to HUMAN_APPROVAL_WAIT
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Signal human approval
      await handle.signal(humanDecisionSignal, {
        taskId: capturedTaskId,
        approved: true,
        notes: "Approved by test operator",
        decidedBy: "ops-user-1",
        decidedAt: new Date().toISOString(),
      });

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED" });
    expect(spy.calls["createHumanTask"]).toBeDefined();
    expect(spy.calls["recordOutcome"]).toBeDefined();
  });

  it("unwinds cleanly and stops when human rejection signal is received (Step 21)", async () => {
    let capturedTaskId = "";
    const { mockActivities, spy } = createActivityMocks({
      async createHumanTask() {
        capturedTaskId = `task_${randomUUID()}`;
        return {
          taskId: capturedTaskId,
          status: "PENDING",
          createdAt: new Date().toISOString(),
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const tenantId = `tenant_${randomUUID()}`;
    const caseId = randomUUID();
    const workflowId = WORKFLOW_ID(caseId);

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "recoveryWorkflowTemplate",
      metadata: {
        requireApproval: true,
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(recoveryWorkflowTemplate, {
        workflowId,
        taskQueue,
        args: [input],
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Signal rejection
      await handle.signal(humanDecisionSignal, {
        taskId: capturedTaskId,
        approved: false,
        notes: "Rejected due to high credit risk",
      });

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "STOPPED", stopReason: "HUMAN_REJECTED" });
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
  });

  it("recovers via condition heartbeat DB fallback when signal is dropped / worker restarts (Step 21)", async () => {
    let capturedTaskId = "";
    const { mockActivities, spy } = createActivityMocks({
      async createHumanTask() {
        capturedTaskId = `task_${randomUUID()}`;
        return {
          taskId: capturedTaskId,
          status: "PENDING",
          createdAt: new Date().toISOString(),
        };
      },
      async waitForHumanDecision(input) {
        // Mock DB status returned as APPROVED via crash repair polling fallback
        return {
          taskId: input.taskId,
          status: "APPROVED",
          approved: true,
          decidedBy: "recovery-operator",
          decisionNotes: "Approved in DB while worker was down",
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "../workflows/index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const tenantId = `tenant_${randomUUID()}`;
    const caseId = randomUUID();
    const workflowId = WORKFLOW_ID(caseId);

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "recoveryWorkflowTemplate",
      metadata: {
        requireApproval: true,
        heartbeatInterval: "50ms", // short heartbeat for testing fallback
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(recoveryWorkflowTemplate, {
        workflowId,
        taskQueue,
        args: [input],
      });

      // DO NOT send signal; let condition timeout trigger the heartbeat activity check
      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED" });
    expect(spy.calls["waitForHumanDecision"]).toBeDefined();
    expect(spy.calls["recordOutcome"]).toBeDefined();
  });
});
