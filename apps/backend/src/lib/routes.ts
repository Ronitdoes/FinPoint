import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { metaRoutes } from "../modules/meta/routes";
import { authRoutes } from "../modules/auth/routes";
import { adminUsersRoutes } from "../modules/admin/users.routes";
import { adminApiKeysRoutes } from "../modules/admin/api-keys.routes";
import { webhooksRoutes } from "../modules/webhooks/routes";
import { eventsRoutes } from "../modules/events/routes";

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
];

export async function registerRouteModules(app: FastifyInstance): Promise<void> {
  for (const mod of routeModules) {
    await app.register(mod.plugin, {
      prefix: mod.prefix,
      ...mod.options,
    });
  }
}
