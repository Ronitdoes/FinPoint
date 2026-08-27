import type { FastifyInstance } from "fastify";
import type { DomainEvent } from "@repo/domain";
import {
  GROUP_RISK_ENGINE,
  TOPIC_MAIN,
  type EventContext,
} from "@repo/integrations";
import { RiskService } from "./risk.service";

/**
 * Wires the risk-engine consumer group to the revenue-events.v1 topic (Spec 01 §0, s-12 §Requirements 1).
 */
export function registerRiskConsumer(app: FastifyInstance): void {
  const riskService = new RiskService(app);

  app.eventBus.subscribe(
    TOPIC_MAIN,
    GROUP_RISK_ENGINE,
    async (event: DomainEvent, ctx: EventContext) => {
      await riskService.handleDomainEvent(event, ctx);
    },
  );

  app.log.info(
    { group: GROUP_RISK_ENGINE, topic: TOPIC_MAIN },
    "Risk engine consumer group registered",
  );
}
