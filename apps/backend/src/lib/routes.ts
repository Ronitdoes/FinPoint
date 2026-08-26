import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { metaRoutes } from "../modules/meta/routes";

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
];

export async function registerRouteModules(app: FastifyInstance): Promise<void> {
  for (const mod of routeModules) {
    await app.register(mod.plugin, {
      prefix: mod.prefix,
      ...mod.options,
    });
  }
}
