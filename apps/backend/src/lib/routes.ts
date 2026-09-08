import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { metaRoutes } from "../modules/meta/routes";
import { authRoutes } from "../modules/auth/routes";
import { adminUsersRoutes } from "../modules/admin/users.routes";
import { adminApiKeysRoutes } from "../modules/admin/api-keys.routes";
import { ipBlocksRoutes } from "../modules/admin/ip-blocks.routes";
import { webhooksRoutes } from "../modules/webhooks/routes";
import { eventsRoutes } from "../modules/events/routes";
import { riskRoutes } from "../modules/risk/routes";
import { customersRoutes } from "../modules/customers/routes";
import { aiRoutes } from "../modules/ai/routes";
import { policyRoutes, policiesCrudRoutes } from "../modules/policy/routes";
import { caseRoutes } from "../modules/cases/routes";
import { paymentRoutes } from "../modules/payments/routes";
import { demoRoutes } from "../modules/demo/routes";
import { messagingRoutes } from "../modules/messaging/routes";
import { humanTasksRoutes } from "../modules/human-tasks/routes";
import { promisesToPayRoutes } from "../modules/promises-to-pay/routes";
import { auditRoutes } from "../modules/audit/routes";
import { outcomesRoutes } from "../modules/outcomes/routes";
import { analyticsRoutes } from "../modules/analytics/routes";

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
    prefix: "/admin",
    plugin: ipBlocksRoutes,
  },
  {
    prefix: "/audit",
    plugin: auditRoutes,
  },
  {
    prefix: "/outcomes",
    plugin: outcomesRoutes,
  },
  {
    prefix: "/analytics",
    plugin: analyticsRoutes,
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
    plugin: demoRoutes,
  },
  {
    prefix: "/messages",
    plugin: messagingRoutes,
  },
  {
    prefix: "/human-tasks",
    plugin: humanTasksRoutes,
  },
  {
    prefix: "/promises-to-pay",
    plugin: promisesToPayRoutes,
  },
];

export async function registerRouteModules(app: FastifyInstance): Promise<void> {
  const isProdWithoutMock =
    app.config.app.env === "production" &&
    app.config.demo?.mockProviders === false;

  for (const mod of routeModules) {
    if (mod.prefix === "/demo" && isProdWithoutMock) {
      app.log.info("Demo routes disabled and omitted in production without mock providers");
      continue;
    }
    await app.register(mod.plugin, {
      prefix: mod.prefix,
      ...mod.options,
    });
  }
}
