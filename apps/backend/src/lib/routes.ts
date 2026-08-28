import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { metaRoutes } from "../modules/meta/routes";
import { authRoutes } from "../modules/auth/routes";
import { adminUsersRoutes } from "../modules/admin/users.routes";
import { adminApiKeysRoutes } from "../modules/admin/api-keys.routes";
import { webhooksRoutes } from "../modules/webhooks/routes";
import { eventsRoutes } from "../modules/events/routes";
import { riskRoutes } from "../modules/risk/routes";
import { customersRoutes } from "../modules/customers/routes";
import { aiRoutes } from "../modules/ai/routes";
import { policyRoutes, policiesCrudRoutes } from "../modules/policy/routes";
import { caseRoutes } from "../modules/cases/routes";
import { paymentRoutes, demoMockPaymentRoutes } from "../modules/payments/routes";
import { messagingRoutes } from "../modules/messaging/routes";

export interface RouteModuleEntry {
  prefix: string;
  plugin: FastifyPluginAsync<any>;
  options?: Record<string, unknown>;
}

/**
 * Global route module registry for apps/backend.
 * Feature modules from later steps (webhooks, events, cases, risk, etc.) register here.
 */
export const routeModules: RouteModuleEntry[] = [
  {
    prefix: "",
    plugin: metaRoutes,
  },
  {
    prefix: "/auth",
    plugin: authRoutes,
  },
  {
    prefix: "/admin",
    plugin: adminUsersRoutes,
  },
  {
    prefix: "/admin",
    plugin: adminApiKeysRoutes,
  },
  {
    prefix: "/webhooks",
    plugin: webhooksRoutes,
  },
  {
    prefix: "/events",
    plugin: eventsRoutes,
  },
  {
    prefix: "/risks",
    plugin: riskRoutes,
  },
  {
    prefix: "/customers",
    plugin: customersRoutes,
  },
  {
    prefix: "/ai",
    plugin: aiRoutes,
  },
  {
    prefix: "/policy",
    plugin: policyRoutes,
  },
  {
    prefix: "/policies",
    plugin: policiesCrudRoutes,
  },
  {
    prefix: "/cases",
    plugin: caseRoutes,
  },
  {
    prefix: "/payments",
    plugin: paymentRoutes,
  },
  {
    prefix: "/demo",
    plugin: demoMockPaymentRoutes,
  },
  {
    prefix: "/messages",
    plugin: messagingRoutes,
  },
];

export async function registerRouteModules(app: FastifyInstance): Promise<void> {
  for (const mod of routeModules) {
    await app.register(mod.plugin, {
      prefix: mod.prefix,
      ...mod.options,
    });
  }
}
