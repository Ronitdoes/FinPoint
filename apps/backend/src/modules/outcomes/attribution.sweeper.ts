import type { Database } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import type Redis from "ioredis";
import { OutcomeRecordService } from "./record.service";
import { recordAttributionSweeperMatch, getLogger } from "@repo/observability";

const logger = getLogger({ component: "attribution-sweeper" });

export interface SweepOptions {
  tenantId?: string;
  batchSize?: number;
}

export interface SweepResult {
  casesAudited: number;
  casesAttributed: number;
  attributedCaseIds: string[];
}

/**
 * AttributionSweeper (Spec 01 §25, Spec 02 §9, Step 26).
 * Hourly job / background sweeper that evaluates closed/stopped cases without an outcome
 * against the 4 strict attribution conditions.
 *
 * Attribution Conditions:
 * 1. Same customer AND same financial obligation (source_entity link or subscription link)
 * 2. Payment.occurredAt >= case.openedAt
 * 3. Payment.occurredAt <= case.openedAt + attribution_window_hours
 * 4. No OTHER live case owns that obligation at attribution time
 */
export class AttributionSweeper {
  private readonly recordService: OutcomeRecordService;

  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    redisClient?: Redis | null,
  ) {
    // Audit fix (s-26): pass Redis through so ATTRIBUTION_WINDOW outcomes bust
    // the analytics cache via OutcomeRecordService.invalidateAnalyticsCache.
    this.recordService = new OutcomeRecordService(db, repos, redisClient ?? null);
  }

  public async runSweep(options: SweepOptions = {}): Promise<SweepResult> {
    const { tenantId, batchSize = 100 } = options;

    logger.info({ tenantId, batchSize }, "Starting attribution window sweep");

    const candidateCases =
      await this.repos.findCandidateCasesForAttributionSweep(
        { db: this.db },
        { tenantId, limit: batchSize },
      );

    let casesAttributed = 0;
    const attributedCaseIds: string[] = [];

    for (const candidateCase of candidateCases) {
      try {
        const matchingPayment =
          await this.repos.findMatchingPaymentForAttribution(
            { db: this.db },
            { tenantId: candidateCase.tenantId, caseRecord: candidateCase },
          );

        if (!matchingPayment) {
          continue;
        }

        // Matching payment satisfies all 4 conditions — record outcome via ATTRIBUTION_WINDOW
        const { outcome, alreadyRecorded } =
          await this.recordService.recordOutcome({
            tenantId: candidateCase.tenantId,
            caseId: candidateCase.id,
            paymentId: matchingPayment.id,
            attributionMethod: "ATTRIBUTION_WINDOW",
            attributionWindowHours: candidateCase.attributionWindowHours,
            baselineAmount: candidateCase.amountAtRisk,
            recoveredAmount: matchingPayment.amount,
            recoveredAt:
              matchingPayment.occurredAt ?? matchingPayment.paidAt ?? undefined,
            notes: `Attributed via hourly sweeper within ${candidateCase.attributionWindowHours}h window`,
          });

        if (!alreadyRecorded) {
          casesAttributed++;
          attributedCaseIds.push(candidateCase.id);
          recordAttributionSweeperMatch();

          logger.info(
            {
              tenantId: candidateCase.tenantId,
              caseId: candidateCase.id,
              paymentId: matchingPayment.id,
              recoveredAmount: matchingPayment.amount.toString(),
              outcomeId: outcome.id,
            },
            "Late payment successfully attributed via ATTRIBUTION_WINDOW",
          );
        }
      } catch (err: any) {
        logger.error(
          {
            err: err.message,
            tenantId: candidateCase.tenantId,
            caseId: candidateCase.id,
          },
          "Failed to process candidate case in attribution sweep",
        );
      }
    }

    logger.info(
      {
        casesAudited: candidateCases.length,
        casesAttributed,
      },
      "Attribution window sweep completed",
    );

    return {
      casesAudited: candidateCases.length,
      casesAttributed,
      attributedCaseIds,
    };
  }
}
