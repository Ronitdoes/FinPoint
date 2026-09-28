import { describe, it, expect, vi, beforeEach } from "vitest";

// L1 regression: mock the live dispatcher so delegation is deterministic and
// DB/Temporal-free. The mock mirrors the worker client's contract
// (services/worker/src/client.ts).
vi.mock("@repo/worker/client", () => ({
  startRecoveryWorkflow: vi.fn(async (input: {
    tenantId: string;
    caseId: string;
  }) => ({
    workflowId: "wf-live-1",
    temporalWorkflowId: `recover:${input.caseId}`,
    runId: "run-live-1",
    accepted: true,
  })),
  signalCase: vi.fn(async () => {}),
  cancelWorkflow: vi.fn(async () => {}),
}));

import * as workerClient from "@repo/worker/client";
import {
  LiveWorkflowClient,
  resetLiveWorkflowClientCache,
} from "./live-workflow-client";

beforeEach(() => {
  resetLiveWorkflowClientCache();
  vi.clearAllMocks();
});

describe("LiveWorkflowClient L1 delegation (offline-safe)", () => {
  it("delegates start to the worker client, mapping actions to metadata", async () => {
    const client = new LiveWorkflowClient(undefined);
    const actions = [{ type: "RETRY_PAYMENT" }];
    const res = await client.startRecoveryWorkflow({
      tenantId: "t1",
      caseId: "case-123",
      workflowType: "FailedPaymentRecoveryWorkflow",
      actions,
    });

    expect(res).toEqual({
      workflowId: "wf-live-1",
      temporalWorkflowId: "recover:case-123",
      runId: "run-live-1",
      accepted: true,
    });
    expect(workerClient.startRecoveryWorkflow).toHaveBeenCalledOnce();
    expect(workerClient.startRecoveryWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        caseId: "case-123",
        workflowType: "FailedPaymentRecoveryWorkflow",
        metadata: { actions },
      }),
    );
  });

  it("falls back to the DB-row client (in-memory when no db) when live dispatch throws", async () => {
    vi.mocked(workerClient.startRecoveryWorkflow).mockRejectedValueOnce(
      new Error("Temporal unavailable"),
    );
    const client = new LiveWorkflowClient(undefined);
    const res = await client.startRecoveryWorkflow({
      tenantId: "t1",
      caseId: "case-fallback",
      workflowType: "FailedPaymentRecoveryWorkflow",
      actions: [],
    });

    expect(res.accepted).toBe(true);
    expect(res.temporalWorkflowId).toBe("recover:case-fallback");
  });

  it("delegates signal/cancel to the worker client when tenantId is present", async () => {
    const client = new LiveWorkflowClient(undefined);
    await client.signalCase({
      tenantId: "t1",
      caseId: "case-123",
      signal: "pause",
      payload: { actorId: "u1" },
    });
    await client.cancelWorkflow({
      tenantId: "t1",
      caseId: "case-123",
      reason: "test",
    });

    expect(workerClient.signalCase).toHaveBeenCalledOnce();
    expect(workerClient.cancelWorkflow).toHaveBeenCalledOnce();
  });

  it("resolves signal/cancel via the stub path when tenantId is absent", async () => {
    const client = new LiveWorkflowClient(undefined);
    await expect(
      client.signalCase({ caseId: "case-123", signal: "pause" }),
    ).resolves.toBeUndefined();
    await expect(
      client.cancelWorkflow({ caseId: "case-123", reason: "test" }),
    ).resolves.toBeUndefined();
    expect(workerClient.signalCase).not.toHaveBeenCalled();
    expect(workerClient.cancelWorkflow).not.toHaveBeenCalled();
  });
});
