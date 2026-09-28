import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import type { Database, Tx } from "@repo/db";
import { withTransaction } from "@repo/db";
import type { ServerConfig } from "@repo/config";
import {
  type RecoveryWorkflowClient,
} from "@repo/orchestration";
import { LiveWorkflowClient } from "../../lib/live-workflow-client";
import {
  getLogger,
  recordCaseFunnel,
  recordPipelineStageDuration,
  withSpan,
} from "@repo/observability";
import type { Repositories } from "../../plugins/db";
import { CaseNotFoundError, IdempotencyInFlightError } from "../../lib/errors";
import { CustomerContextService } from "../customers/customer-context.service";
import { AiDecideService } from "../ai/decide.service";
import { PolicyService } from "../policy/policy.service";
import type { PipelineRunOptions, PipelineStageName, StageLedgerEntry } from "./case.types";

const logger = getLogger({ component: "case-pipeline-service" });

/**
 * Timeline event type carrying StageLedgerEntry payloads (s-17 audit fix).
 *
 * Spec s-17 describes the stage ledger as `recovery_cases.metadata.pipeline[]`,
 * but no metadata column was ever migrated — and a mutable JSONB blob would
 * violate the append-only audit conventions (CONVENTIONS §9). The durable
 * stage ledger is therefore the append-only case_events timeline filtered by
 * this type, plus the guarded case status itself: status + events ARE the
 * ledger. Each entry is persisted transactionally with its stage's state
 * transition (see recordStageLedger), and read back via getPipelineLedger.
 * Re-invoking runPipeline resumes from the first incomplete stage.
 */
export const PIPELINE_STAGE_EVENT_TYPE = "PIPELINE_STAGE";

function buildStageEntry(
  stage: PipelineStageName,
  status: StageLedgerEntry["status"],
  ref?: string,
): StageLedgerEntry {
  return {
    stage,
    status,
    at: new Date().toISOString(),
    ...(ref ? { ref } : {}),
  };
}

export interface PipelineServiceOptions {
  db: Database;
  repos: Repositories;
  config: ServerConfig;
  redis?: Redis | null;
  workflowClient?: RecoveryWorkflowClient;
  customFetch?: typeof fetch;
}

export class CasePipelineService {
  private readonly db: Database;
  private readonly repos: Repositories;
  private readonly config: ServerConfig;
  private readonly redis?: Redis | null;
  private readonly workflowClient: RecoveryWorkflowClient;
  private readonly policyService: PolicyService;
  private readonly customFetch?: typeof fetch;

  constructor(options: PipelineServiceOptions) {
    this.db = options.db;
    this.repos = options.repos;
    this.config = options.config;
    this.redis = options.redis;
    // L1: live Temporal dispatch via worker client with DB-row fallback.
    this.workflowClient =
      options.workflowClient ?? new LiveWorkflowClient(options.db);
    this.policyService = new PolicyService(options.db, options.repos);
    this.customFetch = options.customFetch;
  }

  /**
   * Runs or resumes the multi-stage recovery case qualification pipeline (Spec 01 §12, Step 17).
   *
   * Stage 1: QUALIFIED        -> DECISION_PENDING : Context Build (s-13) + AI Decide (s-14)
   * Stage 2: DECISION_PENDING -> POLICY_REVIEW    : Policy Evaluation (s-16)
   *            ├─ REJECTED (all)       -> STOPPED (reason=POLICY_ALL_REJECTED) + timeline POLICY_REJECTED
   *            ├─ REQUIRE_APPROVAL     -> ESCALATED + Human Task (s-21 primitives)
   *            └─ ALLOWED              -> Persist recovery_actions (APPROVED)
   *                                    -> Start Temporal workflow
   *                                    -> IN_PROGRESS + timeline WORKFLOW_STARTED
   */
  async runPipeline(options: PipelineRunOptions): Promise<void> {
    const { tenantId, caseId, correlationId } = options;

    const currentCase = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId },
    );

    if (!currentCase) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    // Terminal or already executing cases need no further qualification
    if (["RECOVERED", "STOPPED", "FAILED", "IN_PROGRESS", "WAITING", "ESCALATED"].includes(currentCase.status)) {
      logger.info(
        { tenantId, caseId, status: currentCase.status },
        "Recovery case is already past qualification; skipping pipeline run",
      );
      return;
    }

    // =========================================================================
    // STAGE 1: CONTEXT & AI DECISION (QUALIFIED -> DECISION_PENDING)
    // =========================================================================
    if (currentCase.status === "QUALIFIED") {
      await this.runDecisionStage(tenantId, caseId, currentCase, correlationId);
    }

    // Reload case after decision stage
    const afterDecisionCase = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId },
    );

    if (
      !afterDecisionCase ||
      (afterDecisionCase.status !== "DECISION_PENDING" &&
        afterDecisionCase.status !== "POLICY_REVIEW")
    ) {
      return;
    }

    // =========================================================================
    // STAGE 2: POLICY REVIEW & WORKFLOW START (DECISION_PENDING -> POLICY_REVIEW -> IN_PROGRESS/STOPPED/ESCALATED)
    // =========================================================================
    await this.runPolicyAndExecutionStage(
      tenantId,
      caseId,
      afterDecisionCase,
      correlationId,
    );
  }

  /**
   * Reads the durable per-stage ledger for a case (s-17 audit fix).
   * Returns StageLedgerEntry rows in chronological order; an empty array
   * means no stage has completed yet.
   */
  async getPipelineLedger(
    tenantId: string,
    caseId: string,
  ): Promise<StageLedgerEntry[]> {
    const { items } = await this.repos.listCaseEventsWithCursor(
      { db: this.db },
      {
        tenantId,
        caseId,
        types: [PIPELINE_STAGE_EVENT_TYPE],
        order: "asc",
        limit: 100,
      },
    );
    const entries: StageLedgerEntry[] = [];
    for (const event of items) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (
        typeof payload.stage === "string" &&
        typeof payload.status === "string" &&
        typeof payload.at === "string"
      ) {
        entries.push({
          stage: payload.stage as StageLedgerEntry["stage"],
          status: payload.status as StageLedgerEntry["status"],
          at: payload.at,
          ...(typeof payload.ref === "string" ? { ref: payload.ref } : {}),
        });
      }
    }
    return entries;
  }

  /**
   * Persists one StageLedgerEntry to the append-only timeline (s-17 audit fix).
   * Accepts a repo context so callers join the stage's transaction: the ledger
   * row commits atomically with the stage's guarded transition + timeline +
   * audit writes (CONVENTIONS §9).
   */
  private async recordStageLedger(
    ctx: { db?: Database; tx?: Tx },
    tenantId: string,
    caseId: string,
    entry: StageLedgerEntry,
  ): Promise<void> {
    await this.repos.recordCaseEvent(ctx, {
      tenantId,
      caseId,
      eventType: PIPELINE_STAGE_EVENT_TYPE,
      actorType: "SYSTEM",
      description: `Pipeline stage ${entry.stage} ${entry.status}`,
      payload: { ...entry },
    });
  }

  /**
   * Stage 1: Gathers customer context and generates AI Decision.
    */
  private async runDecisionStage(
    tenantId: string,
    caseId: string,
    caseRow: any,
    correlationId?: string,
  ): Promise<void> {
    const startTime = performance.now();

    await withSpan(
      "case.pipeline.context_and_decision",
      {
        "tenant.id": tenantId,
        "case.id": caseId,
        "case.status": caseRow.status,
      },
      async () => {
        try {
          // 1. Context Build
          await withSpan("case.pipeline.context", { "case.id": caseId }, async () => {
            await CustomerContextService.buildForCase({
              tenantId,
              caseId,
              purpose: "ai_decision",
              db: this.db,
              repos: this.repos,
              redis: this.redis,
            });
          });

          // 2. AI Decision
          const decisionResult = await withSpan(
            "case.pipeline.ai_decision",
            { "case.id": caseId },
            async () => {
              const idempotencyKey = `${caseId}:decision:1`;
              return await AiDecideService.decide({
                tenantId,
                caseId,
                riskId: caseRow.riskId ?? undefined,
                purpose: "CASE_OPENING",
                idempotencyKey,
                db: this.db,
                repos: this.repos,
                redis: this.redis,
                config: this.config,
                customFetch: this.customFetch,
              });
            },
          );

          // 3. Guarded State Transition: QUALIFIED -> DECISION_PENDING, with the
          // stage's timeline + audit + ledger appends in ONE transaction
          // (s-17 audit: stage ledger persisted transactionally per stage,
          // CONVENTIONS §9). A concurrent transition wins the guard and this
          // attempt writes nothing (idempotent resume).
          await withTransaction({ db: this.db }, async (tx) => {
            const updated = await this.repos.transitionCaseStatus(
              { tx },
              {
                tenantId,
                caseId,
                from: ["QUALIFIED"],
                to: "DECISION_PENDING",
                reason: "AI decision completed",
              },
            );

            if (!updated) {
              return;
            }

            recordCaseFunnel("decided");
            const durationMs = performance.now() - startTime;
            recordPipelineStageDuration("AI_DECISION", durationMs);

            // Append timeline event
            await this.repos.recordCaseEvent(
              { tx },
              {
                tenantId,
                caseId,
                eventType: "AI_DECISION_CREATED",
                actorType: "SYSTEM",
                description: `AI recommended ${decisionResult.actions.length} recovery action(s) (${decisionResult.status})`,
                payload: {
                  decisionId: decisionResult.decisionId,
                  status: decisionResult.status,
                  diagnosis: decisionResult.diagnosis,
                  actionCount: decisionResult.actions.length,
                  model: decisionResult.model,
                },
              },
            );

            // Audit log
            await this.repos.recordAuditLog(
              { tx },
              {
                tenantId,
                caseId,
                actorType: "SYSTEM",
                event: "AI_DECISION_ATTACHED",
                metadata: {
                  decisionId: decisionResult.decisionId,
                  status: decisionResult.status,
                },
                correlationId,
              },
            );

            // Stage ledger: CONTEXT built above, AI_DECISION completed here.
            await this.recordStageLedger(
              { tx },
              tenantId,
              caseId,
              buildStageEntry("CONTEXT", "DONE"),
            );
            await this.recordStageLedger(
              { tx },
              tenantId,
              caseId,
              buildStageEntry(
                "AI_DECISION",
                "DONE",
                decisionResult.decisionId,
              ),
            );
          });
        } catch (error: any) {
          // Concurrent-pipeline guard (s-17 fix): another worker holds the
          // decide lease for this case (same `${caseId}:decision:1` key).
          // Yield without marking FAILED — the lease holder drives the case
          // and this run's FAILED transition would poison its in-flight work
          // (guarded `from` includes DECISION_PENDING, so the loser would win
          // the race to a terminal state).
          if (error instanceof IdempotencyInFlightError) {
            logger.info(
              { tenantId, caseId },
              "AI Decision lease held by concurrent pipeline run; yielding",
            );
            return;
          }

          logger.error(
            { tenantId, caseId, err: error.message },
            "AI Decision stage failed; transitioning case to FAILED (NO_DECISION_AVAILABLE)",
          );

          // Transition to FAILED if AI decision fails completely without fallback.
          // s-17 audit: transition + timeline + audit + FAILED ledger entry in
          // ONE transaction; a lost guard race writes nothing (resume-safe).
          await withTransaction({ db: this.db }, async (tx) => {
            const failed = await this.repos.transitionCaseStatus(
              { tx },
              {
                tenantId,
                caseId,
                from: ["QUALIFIED", "DECISION_PENDING"],
                to: "FAILED",
                reason: "NO_DECISION_AVAILABLE",
              },
            );

            if (!failed) {
              return;
            }

            await this.repos.recordCaseEvent(
              { tx },
              {
                tenantId,
                caseId,
                eventType: "CASE_FAILED",
                actorType: "SYSTEM",
                description: "Case failed: No valid AI decision or fallback available",
                payload: { error: error.message },
              },
            );

            await this.repos.recordAuditLog(
              { tx },
              {
                tenantId,
                caseId,
                actorType: "SYSTEM",
                event: "CASE_FAILED",
                metadata: { reason: "NO_DECISION_AVAILABLE", error: error.message },
                correlationId,
              },
            );

            await this.recordStageLedger(
              { tx },
              tenantId,
              caseId,
              buildStageEntry("AI_DECISION", "FAILED"),
            );
          });
        }
      },
    );
  }

  /**
   * Stage 2: Evaluates Policy rules on proposed actions and executes workflow.
   */
  private async runPolicyAndExecutionStage(
    tenantId: string,
    caseId: string,
    caseRow: any,
    correlationId?: string,
  ): Promise<void> {
    const startTime = performance.now();

    await withSpan(
      "case.pipeline.policy_and_execution",
      {
        "tenant.id": tenantId,
        "case.id": caseId,
      },
      async () => {
        // 1. Guarded transition: DECISION_PENDING -> POLICY_REVIEW.
        // Resume-safe: a crash after the transition leaves the case in
        // POLICY_REVIEW; re-invocation must continue, not stall.
        if (caseRow.status === "POLICY_REVIEW") {
          logger.info(
            { tenantId, caseId },
            "Resuming policy stage from POLICY_REVIEW",
          );
        } else if (caseRow.status === "DECISION_PENDING") {
          const inReviewCase = await this.repos.transitionCaseStatus(
            { db: this.db },
            {
              tenantId,
              caseId,
              from: ["DECISION_PENDING"],
              to: "POLICY_REVIEW",
              reason: "Evaluating policy rules on proposed actions",
            },
          );

          if (!inReviewCase) {
            const reread = await this.repos.findCaseById(
              { db: this.db },
              { tenantId, caseId },
            );
            if (
              !reread ||
              (reread.status !== "POLICY_REVIEW" &&
                reread.status !== "DECISION_PENDING")
            ) {
              logger.warn(
                { tenantId, caseId },
                "Could not transition case to POLICY_REVIEW (concurrent modification)",
              );
              return;
            }
            if (reread.status === "DECISION_PENDING") {
              logger.warn(
                { tenantId, caseId },
                "Could not transition case to POLICY_REVIEW (concurrent modification)",
              );
              return;
            }
            logger.info(
              { tenantId, caseId },
              "Resuming policy stage from POLICY_REVIEW after guard race",
            );
          }
        } else {
          logger.warn(
            { tenantId, caseId, status: caseRow.status },
            "Unexpected status for policy stage; skipping",
          );
          return;
        }

        // 2. Load latest decision to retrieve proposed actions
        const latestDecision = await this.repos.findLatestDecisionForCase(
          { db: this.db },
          { tenantId, caseId },
        );

        const proposedActions =
          (latestDecision?.recommendedActions as unknown[]) ?? [];

        // 3. Evaluate Policy Engine
        const policyResponse = await withSpan(
          "case.pipeline.policy",
          { "case.id": caseId },
          async () => {
            return await this.policyService.evaluatePolicy(tenantId, {
              caseId,
              decisionId: latestDecision?.id,
              actions: proposedActions as any[],
            });
          },
        );

        const policyDurationMs = performance.now() - startTime;
        recordPipelineStageDuration("POLICY", policyDurationMs);

        // =====================================================================
        // CASE A: ALL ACTIONS REJECTED -> STOPPED (reason=POLICY_ALL_REJECTED)
        // =====================================================================
        if (
          policyResponse.result === "REJECTED" ||
          (!policyResponse.allowed &&
            !policyResponse.required_approval &&
            policyResponse.effective_actions.length === 0)
        ) {
          logger.info(
            { tenantId, caseId, rejections: policyResponse.rejections },
            "All proposed actions rejected by policy; stopping case",
          );

          // Guarded STOPPED transition + timeline + audit + POLICY ledger in
          // ONE transaction (matches CONTEXT/AI_DECISION pattern, CONVENTIONS §9).
          // Guard loss writes nothing (resume-safe: STOPPED early-returns).
          await withTransaction({ db: this.db }, async (tx) => {
            const stopped = await this.repos.transitionCaseStatus(
              { tx },
              {
                tenantId,
                caseId,
                from: ["POLICY_REVIEW"],
                to: "STOPPED",
                reason: "POLICY_ALL_REJECTED",
              },
            );

            if (!stopped) {
              return;
            }

            await this.repos.recordCaseEvent(
              { tx },
              {
                tenantId,
                caseId,
                eventType: "POLICY_REJECTED",
                actorType: "SYSTEM",
                description: "All recovery actions rejected by policy engine",
                payload: {
                  evaluationId: policyResponse.evaluationId,
                  rejections: policyResponse.rejections,
                },
              },
            );

            await this.repos.recordAuditLog(
              { tx },
              {
                tenantId,
                caseId,
                actorType: "SYSTEM",
                event: "CASE_STOPPED_BY_POLICY",
                metadata: {
                  reason: "POLICY_ALL_REJECTED",
                  evaluationId: policyResponse.evaluationId,
                },
                correlationId,
              },
            );

            await this.recordStageLedger(
              { tx },
              tenantId,
              caseId,
              buildStageEntry(
                "POLICY",
                "DONE",
                policyResponse.evaluationId,
              ),
            );
          });
          return;
        }

        // =====================================================================
        // CASE B: REQUIRE APPROVAL -> ESCALATED + HUMAN_TASK(APPROVAL)
        // =====================================================================
        if (
          policyResponse.required_approval ||
          policyResponse.result === "REQUIRE_APPROVAL"
        ) {
          logger.info(
            { tenantId, caseId },
            "Policy requires human approval; escalating case and creating human task",
          );

          // Guarded ESCALATED transition + task + timeline + audit + POLICY
          // ledger in ONE transaction (matches CONTEXT/AI_DECISION pattern).
          // Transition first: guard loss creates no task (resume-safe).
          await withTransaction({ db: this.db }, async (tx) => {
            const escalated = await this.repos.transitionCaseStatus(
              { tx },
              {
                tenantId,
                caseId,
                from: ["POLICY_REVIEW"],
                to: "ESCALATED",
                reason: "POLICY_REQUIRES_APPROVAL",
              },
            );

            if (!escalated) {
              return;
            }

            // Create Human Task for approval
            const task = await this.repos.createHumanTask(
              { tx },
              {
                tenantId,
                caseId,
                type: "APPROVAL",
                title: "Approve recovery action plan",
                description:
                  "Policy engine flagged proposed actions as requiring human authorization",
                priority: "HIGH",
                status: "PENDING",
                slaDueAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h SLA
              },
            );

            await this.repos.recordCaseEvent(
              { tx },
              {
                tenantId,
                caseId,
                eventType: "HUMAN_TASK_CREATED",
                actorType: "SYSTEM",
                description: `Human task created: ${task.title} (ID: ${task.id})`,
                payload: { taskId: task.id, type: task.type, priority: task.priority },
              },
            );

            await this.repos.recordCaseEvent(
              { tx },
              {
                tenantId,
                caseId,
                eventType: "CASE_ESCALATED",
                actorType: "SYSTEM",
                description: "Case escalated for human approval",
                payload: { taskId: task.id, reason: "POLICY_REQUIRES_APPROVAL" },
              },
            );

            await this.repos.recordAuditLog(
              { tx },
              {
                tenantId,
                caseId,
                actorType: "SYSTEM",
                event: "CASE_ESCALATED_POLICY_APPROVAL",
                metadata: { taskId: task.id, evaluationId: policyResponse.evaluationId },
                correlationId,
              },
            );

            await this.recordStageLedger(
              { tx },
              tenantId,
              caseId,
              buildStageEntry(
                "POLICY",
                "DONE",
                policyResponse.evaluationId,
              ),
            );
          });
          return;
        }

        // =====================================================================
        // CASE C: ALLOWED -> PERSIST ACTIONS + START WORKFLOW -> IN_PROGRESS
        // =====================================================================
        recordCaseFunnel("allowed");

        // 4. Persist recovery_actions rows with status APPROVED & deterministic idempotency keys
        const effectiveActions = (policyResponse.effective_actions as any[]) as Array<{
          type: any;
          params?: Record<string, unknown>;
          parameters?: Record<string, unknown>;
          [key: string]: unknown;
        }>;

        const actionRows: Array<{ id: string }> = [];
        let attemptIdx = 1;

        for (const act of effectiveActions) {
          const actionType = act.type;
          const actionParams = act.parameters ?? act.params ?? {};
          const idempotencyKey = `${tenantId}:${caseId}:${actionType}:${attemptIdx}`;

          try {
            const existingAction = await this.repos.findActionByIdempotencyKey(
              { db: this.db },
              { tenantId, idempotencyKey },
            );

            if (existingAction) {
              actionRows.push(existingAction);
            } else {
              const createdAction = await this.repos.insertAction(
                { db: this.db },
                {
                  tenantId,
                  caseId,
                  decisionId: latestDecision?.id,
                  type: actionType,
                  parameters: actionParams,
                  status: "APPROVED",
                  attemptNumber: attemptIdx,
                  idempotencyKey,
                  scheduledAt: new Date(),
                },
              );
              actionRows.push(createdAction);
            }
          } catch (err: any) {
            logger.warn(
              { tenantId, caseId, idempotencyKey, err: err.message },
              "Action insert handled collision idempotently",
            );
          }
          attemptIdx++;
        }

        recordPipelineStageDuration("ACTIONS", performance.now() - startTime);

        // 5. Start Recovery Workflow via client interface
        const workflowType =
          caseRow.riskType === "PAYMENT_FAILURE"
            ? "FailedPaymentRecoveryWorkflow"
            : caseRow.riskType === "CHECKOUT_ABANDONMENT"
              ? "CheckoutRecoveryWorkflow"
              : "InvoiceRecoveryWorkflow";

        const workflowResult = await this.workflowClient.startRecoveryWorkflow({
          tenantId,
          caseId,
          workflowType,
          actions: effectiveActions,
          db: this.db,
        });

        recordPipelineStageDuration("WORKFLOW", performance.now() - startTime);

        // 6. Guarded POLICY_REVIEW -> IN_PROGRESS + timeline + audit +
        // POLICY/ACTIONS/WORKFLOW ledger in ONE transaction (matches
        // CONTEXT/AI_DECISION pattern, CONVENTIONS §9). Guard loss writes
        // nothing (resume-safe: IN_PROGRESS early-returns, no duplicate ledger).
        let transitionedToInProgress = false;
        await withTransaction({ db: this.db }, async (tx) => {
          const inProgress = await this.repos.transitionCaseStatus(
            { tx },
            {
              tenantId,
              caseId,
              from: ["POLICY_REVIEW"],
              to: "IN_PROGRESS",
              workflowId: workflowResult.workflowId,
              reason: "Workflow initiated with approved recovery actions",
            },
          );

          if (!inProgress) {
            return;
          }
          transitionedToInProgress = true;

          // POLICY_ALLOWED timeline (policy decision point)
          await this.repos.recordCaseEvent(
            { tx },
            {
              tenantId,
              caseId,
              eventType: "POLICY_ALLOWED",
              actorType: "SYSTEM",
              description: `Policy approved ${policyResponse.effective_actions.length} action(s)`,
              payload: {
                evaluationId: policyResponse.evaluationId,
                effectiveActionCount: policyResponse.effective_actions.length,
              },
            },
          );

          // 7. Record timeline event WORKFLOW_STARTED
          await this.repos.recordCaseEvent(
            { tx },
            {
              tenantId,
              caseId,
              eventType: "WORKFLOW_STARTED",
              actorType: "SYSTEM",
              description: `Recovery workflow initiated (${workflowType})`,
              payload: {
                workflowId: workflowResult.workflowId,
                temporalWorkflowId: workflowResult.temporalWorkflowId,
                workflowType,
                approvedActionCount: actionRows.length,
              },
            },
          );

          // 8. Record audit log
          await this.repos.recordAuditLog(
            { tx },
            {
              tenantId,
              caseId,
              actorType: "SYSTEM",
              event: "WORKFLOW_STARTED",
              metadata: {
                workflowId: workflowResult.workflowId,
                workflowType,
                actionCount: actionRows.length,
              },
              correlationId,
            },
          );

          // Stage ledger: POLICY decided, ACTIONS persisted, WORKFLOW started.
          await this.recordStageLedger(
            { tx },
            tenantId,
            caseId,
            buildStageEntry(
              "POLICY",
              "DONE",
              policyResponse.evaluationId,
            ),
          );
          await this.recordStageLedger(
            { tx },
            tenantId,
            caseId,
            buildStageEntry(
              "ACTIONS",
              "DONE",
              actionRows[0]?.id,
            ),
          );
          await this.recordStageLedger(
            { tx },
            tenantId,
            caseId,
            buildStageEntry(
              "WORKFLOW",
              "DONE",
              workflowResult.workflowId,
            ),
          );
        });

        if (!transitionedToInProgress) {
          logger.warn(
            { tenantId, caseId },
            "Could not transition case to IN_PROGRESS (concurrent modification); skipping duplicate ledger",
          );
          return;
        }

        recordCaseFunnel("started");

        logger.info(
          {
            tenantId,
            caseId,
            workflowId: workflowResult.workflowId,
            status: "IN_PROGRESS",
          },
          "Recovery case successfully moved to IN_PROGRESS",
        );
      },
    );
  }
}
