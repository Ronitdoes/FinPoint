import { randomUUID } from "node:crypto";
import type { Database } from "@repo/db";
import type { DomainEvent } from "@repo/domain";
import { TOPIC_MAIN, type EventBus } from "@repo/integrations";
import { getLogger, recordSlaBreach, withSpan } from "@repo/observability";
import type { Repositories } from "../../plugins/db";

const logger = getLogger({ component: "sla-sweeper" });

export class SlaSweeper {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Sweeps for pending/assigned human tasks past their SLA due date that haven't been flagged yet.
   * Idempotently marks them as overdue and publishes `human-task.sla-breached` to the event bus.
   */
  async sweepOverdueTasks(
    asOf: Date = new Date(),
    tenantId?: string,
  ): Promise<{ sweptCount: number }> {
    return await withSpan("human_tasks.sla_sweep", {}, async () => {
      const overdueTasks = await this.repos.findOverdueHumanTasks(
        { db: this.db },
        { asOf, limit: 100, tenantId },
      );

      if (overdueTasks.length === 0) {
        return { sweptCount: 0 };
      }

      let sweptCount = 0;

      for (const task of overdueTasks) {
        // Idempotently mark overdue in DB
        const marked = await this.repos.markTaskOverdue(
          { db: this.db },
          {
            tenantId: task.tenantId,
            taskId: task.id,
            overdueAt: asOf,
          },
        );

        if (!marked) {
          // Task was already marked or resolved concurrently
          continue;
        }

        sweptCount += 1;

        // 1. Record SLA breach metric
        recordSlaBreach(task.type);

        // 2. Publish human-task.sla-breached domain event
        if (this.eventBus) {
          // Resolve owning customer from the case (task.caseId is NOT a customer id).
          const caseRow = await this.repos.findCaseById(
            { db: this.db },
            { tenantId: task.tenantId, caseId: task.caseId },
          );
          const event: DomainEvent = {
            id: randomUUID(),
            type: "human-task.sla-breached",
            occurred_at: asOf.toISOString(),
            source: "sla_sweeper",
            tenant_id: task.tenantId,
            customer_id: caseRow?.customerId ?? task.caseId,
            entity_id: task.id,
            entity_type: "HUMAN_TASK",
            payload: {
              taskId: task.id,
              caseId: task.caseId,
              customerId: caseRow?.customerId ?? null,
              taskType: task.type,
              priority: task.priority,
              slaDueAt: task.slaDueAt ? task.slaDueAt.toISOString() : null,
              overdueAt: asOf.toISOString(),
            },
            correlation_id: randomUUID(),
          };

          await this.eventBus.publish(event, {
            topic: TOPIC_MAIN,
            key: task.tenantId,
          });
        }

        // 3. Record case audit log
        await this.repos.recordAuditLog(
          { db: this.db },
          {
            tenantId: task.tenantId,
            caseId: task.caseId,
            actorType: "SYSTEM",
            event: "HUMAN_TASK_SLA_BREACHED",
            metadata: {
              taskId: task.id,
              taskType: task.type,
              slaDueAt: task.slaDueAt ? task.slaDueAt.toISOString() : null,
              overdueAt: asOf.toISOString(),
            },
          },
        );

        logger.warn(
          {
            tenantId: task.tenantId,
            caseId: task.caseId,
            taskId: task.id,
            type: task.type,
            slaDueAt: task.slaDueAt,
          },
          "Human task SLA breached",
        );
      }

      return { sweptCount };
    });
  }
}
