import type { Database } from "@repo/db";
import {
  DefaultWorkflowClient,
  type CancelWorkflowInput,
  type RecoveryWorkflowClient,
  type SignalWorkflowInput,
  type StartWorkflowInput,
  type StartWorkflowResult,
} from "@repo/orchestration";
import { getLogger } from "@repo/observability";

const logger = getLogger({ component: "live-workflow-client" });

type WorkerClientModule = typeof import("@repo/worker/client");

// Cached worker module handle: `undefined` = not attempted yet, `null` =
// unavailable (native/loader failure). Cached so the offline fallback path
// pays the failed-import cost exactly once per process.
let cachedWorkerModule: WorkerClientModule | null | undefined;

/**
 * Lazily loads the live Temporal dispatcher (`@repo/worker/client`).
 *
 * L1 unification note: this dynamic import is load-bearing. A static import
 * would create a hard dependency cycle (worker already depends on
 * orchestration) and would drag `@temporalio/worker`'s native chain into the
 * backend bundle (see the s-35 `loader-utils` precedent in
 * `apps/backend/src/jobs/infra-sampler.ts`, which uses the same "./client"
 * subpath — never the package root — for exactly that reason). Lazy loading
 * keeps the API bootable with zero Temporal availability: a failed import
 * resolves to `null` and every method below falls back to the DB-row client.
 */
async function loadWorkerClientModule(): Promise<WorkerClientModule | null> {
  if (cachedWorkerModule !== undefined) {
    return cachedWorkerModule;
  }
  try {
    cachedWorkerModule = await import("@repo/worker/client");
    return cachedWorkerModule;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Worker Temporal client unavailable; using DB-row workflow fallback",
    );
    cachedWorkerModule = null;
    return null;
  }
}

/**
 * Test/operator hatch: clears the cached worker module handle so the next
 * call re-attempts the dynamic import (mirrors `resetTemporalClient`).
 */
export function resetLiveWorkflowClientCache(): void {
  cachedWorkerModule = undefined;
}

/**
 * L1 live Temporal dispatch unification (RELEASE-v0.1.0 §10 L1, ADR-005).
 *
 * Backend-facing `RecoveryWorkflowClient` that prefers the real dispatcher —
 * `startRecoveryWorkflow` in `@repo/worker/client` (`recover:{caseId}` +
 * `ALLOW_DUPLICATE_FAILED_ONLY` + DB row + its own offline fallback) — and
 * falls back to the offline-safe `DefaultWorkflowClient` DB-row path when the
 * worker module cannot load or the dispatch throws.
 *
 * Fallback-after-throw is idempotent, not a double-write: both halves share
 * the RUNNING-only fast-path, so a row the worker half already persisted is
 * returned as `accepted: false` (duplicate) or re-activated, never duplicated.
 * Constructor injection of any `RecoveryWorkflowClient` is preserved, so unit
 * tests can keep passing mocks and never touch Temporal.
 */
export class LiveWorkflowClient implements RecoveryWorkflowClient {
  private readonly fallback: RecoveryWorkflowClient;

  constructor(private readonly db?: Database) {
    this.fallback = new DefaultWorkflowClient(db);
  }

  async startRecoveryWorkflow(
    input: StartWorkflowInput,
  ): Promise<StartWorkflowResult> {
    const worker = await loadWorkerClientModule();
    if (worker) {
      try {
        // The worker input carries optional rich dispatch fields the
        // orchestration input does not model; the plan's actions travel as
        // metadata (the worker persists them via its own ledger path).
        return await worker.startRecoveryWorkflow({
          tenantId: input.tenantId,
          caseId: input.caseId,
          workflowType: input.workflowType,
          metadata: { actions: input.actions },
          db: input.db ?? this.db,
        });
      } catch (err) {
        logger.warn(
          {
            tenantId: input.tenantId,
            caseId: input.caseId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Live workflow dispatch failed; falling back to DB-row path",
        );
      }
    }
    return this.fallback.startRecoveryWorkflow(input);
  }

  async signalCase(input: SignalWorkflowInput): Promise<void> {
    const worker = input.tenantId
      ? await loadWorkerClientModule()
      : null;
    if (worker && input.tenantId) {
      try {
        await worker.signalCase({
          tenantId: input.tenantId,
          caseId: input.caseId,
          signal: input.signal,
          payload: input.payload,
          db: input.db ?? this.db,
        });
        return;
      } catch (err) {
        logger.warn(
          {
            caseId: input.caseId,
            signal: input.signal,
            err: err instanceof Error ? err.message : String(err),
          },
          "Live workflow signal failed; falling back to DB-row path",
        );
      }
    }
    return this.fallback.signalCase(input);
  }

  async cancelWorkflow(input: CancelWorkflowInput): Promise<void> {
    const worker = input.tenantId
      ? await loadWorkerClientModule()
      : null;
    if (worker && input.tenantId) {
      try {
        await worker.cancelWorkflow({
          tenantId: input.tenantId,
          caseId: input.caseId,
          reason: input.reason,
          db: input.db ?? this.db,
        });
        return;
      } catch (err) {
        logger.warn(
          {
            caseId: input.caseId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Live workflow cancel failed; falling back to DB-row path",
        );
      }
    }
    return this.fallback.cancelWorkflow(input);
  }
}
