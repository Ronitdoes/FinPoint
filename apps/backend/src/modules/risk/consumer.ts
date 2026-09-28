import type { FastifyInstance } from "fastify";
import type { DomainEvent } from "@repo/domain";
import {
  GROUP_RISK_ENGINE,
  GROUP_RISK_ENGINE_RETRY,
  TOPIC_MAIN,
  TOPIC_RETRY,
  type EventContext,
} from "@repo/integrations";
import { RiskService } from "./risk.service";

/**
 * Wires the risk-engine consumer group to the revenue-events.v1 topic (Spec 01 §0, s-12 §Requirements 1).
 * Also subscribes to the RETRY topic (s-11 fix): without this, retryable
 * failures published to `revenue-events.retry` were silently dropped.
 */
export function registerRiskConsumer(app: FastifyInstance): void {
  const riskService = new RiskService(app);

  const handler = async (event: DomainEvent, ctx: EventContext) => {
    await riskService.handleDomainEvent(event, ctx);
  };

  app.eventBus.subscribe(TOPIC_MAIN, GROUP_RISK_ENGINE, handler);
  // Retry topic on its own group (s-11 fix v3): same groupId across two
  // consumers with disjoint topics stalls the retry member on Redpanda.
  // Topics are disjoint so separate groups duplicate nothing.
  void Promise.resolve(
    app.eventBus.subscribe(TOPIC_RETRY, GROUP_RISK_ENGINE_RETRY, handler),
  ).catch(() => {});

  app.log.info(
    { group: GROUP_RISK_ENGINE, topic: TOPIC_MAIN },
    "Risk engine consumer group registered",
  );
}
