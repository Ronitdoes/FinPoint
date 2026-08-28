import type { Database } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import { recordCostEntryGap, getLogger } from "@repo/observability";

const logger = getLogger({ component: "cost-completeness-job" });

/**
 * Standard unit costs in minor currency units (paise for INR) (Spec 02 §8, Step 26).
 */
export const MESSAGING_UNIT_COSTS_PAISE: Record<string, bigint> = {
  SEND_WHATSAPP: 50n, // ₹0.50 per WhatsApp message
  SEND_EMAIL: 5n,     // ₹0.05 per transactional email
  SEND_SMS: 25n,      // ₹0.25 per SMS
};

export interface CostAuditOptions {
  tenantId?: string;
  batchSize?: number;
}

export interface CostAuditResult {
  actionsAudited: number;
  gapsRemediated: number;
  remediatedActionIds: string[];
}

/**
 * CostCompletenessJob (Spec 01 §25, Spec 02 §8, Step 26).
 * Daily audit job verifying that every executed recovery action has an authoritative cost entry,
 * remediating any gaps detected in messaging or execution ledgers.
 */
export class CostCompletenessJob {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
  ) {}

  public async runAudit(options: CostAuditOptions = {}): Promise<CostAuditResult> {
    const { tenantId, batchSize = 100 } = options;

    logger.info({ tenantId, batchSize }, "Starting cost completeness audit");

    const missingActions = await this.repos.findMissingActionCosts(
      { db: this.db },
      { tenantId, limit: batchSize },
    );

    let gapsRemediated = 0;
    const remediatedActionIds: string[] = [];

    for (const action of missingActions) {
      try {
        const caseRecord = await this.repos.findCaseById(
          { db: this.db },
          { tenantId: action.tenantId, caseId: action.caseId },
        );

        let category: "MESSAGING" | "DISCOUNT" | "MANUAL_HANDLING" | "PROVIDER" =
          "MESSAGING";
        let amount = 0n;

        if (action.type in MESSAGING_UNIT_COSTS_PAISE) {
          category = "MESSAGING";
          amount = MESSAGING_UNIT_COSTS_PAISE[action.type] ?? 50n;
        } else if (action.type === "OFFER_INCENTIVE") {
          category = "DISCOUNT";
          const params = (action.parameters as any) ?? {};
          amount = params.discount_amount_minor
            ? BigInt(params.discount_amount_minor)
            : 0n;
        } else if (action.type === "CREATE_HUMAN_TASK") {
          category = "MANUAL_HANDLING";
          amount = 0n;
        } else {
          category = "PROVIDER";
          amount = 0n;
        }

        await this.repos.recordCostEntry(
          { db: this.db },
          {
            tenantId: action.tenantId,
            caseId: action.caseId,
            category,
            amount,
            currency: caseRecord?.currency ?? "INR",
            metadata: {
              action_id: action.id,
              action_type: action.type,
              remediated_by: "cost_completeness_audit_job",
              remediated_at: new Date().toISOString(),
            },
            incurredAt: action.completedAt ?? action.createdAt ?? new Date(),
          },
        );

        gapsRemediated++;
        remediatedActionIds.push(action.id);
        recordCostEntryGap(category);

        logger.info(
          {
            tenantId: action.tenantId,
            caseId: action.caseId,
            actionId: action.id,
            category,
            amount: amount.toString(),
          },
          "Missing cost entry remediated by completeness audit",
        );
      } catch (err: any) {
        logger.error(
          {
            err: err.message,
            tenantId: action.tenantId,
            caseId: action.caseId,
            actionId: action.id,
          },
          "Failed to remediate cost entry gap for action",
        );
      }
    }

    logger.info(
      {
        actionsAudited: missingActions.length,
        gapsRemediated,
      },
      "Cost completeness audit completed",
    );

    return {
      actionsAudited: missingActions.length,
      gapsRemediated,
      remediatedActionIds,
    };
  }
}
