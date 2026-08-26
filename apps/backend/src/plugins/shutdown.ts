import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    getInFlightCount: () => number;
    drainInFlight: (timeoutMs?: number) => Promise<void>;
  }
}

export interface ShutdownPluginOptions {
  drainTimeoutMs?: number;
}

const shutdownPluginCallback: FastifyPluginAsync<ShutdownPluginOptions> = async (
  fastify,
  opts,
) => {
  let inFlight = 0;
  const defaultTimeout = opts.drainTimeoutMs ?? 20000;

  fastify.addHook("onRequest", async (_req) => {
    inFlight += 1;
  });

  fastify.addHook("onResponse", async (_req, _reply) => {
    inFlight = Math.max(0, inFlight - 1);
  });

  fastify.addHook("onError", async (_req, _reply, _error) => {
    // onResponse will also fire in most Fastify error scenarios,
    // but Math.max(0, inFlight - 1) safeguards against negative counts.
  });

  fastify.decorate("getInFlightCount", () => inFlight);

  fastify.decorate("drainInFlight", async (timeoutMs?: number): Promise<void> => {
    const timeout = timeoutMs ?? defaultTimeout;
    const startTime = Date.now();

    while (inFlight > 0) {
      if (Date.now() - startTime >= timeout) {
        fastify.log.warn(
          { inFlight, timeoutMs: timeout },
          "Drain timeout reached while requests were still in-flight",
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
};

export const shutdownPlugin = fp(shutdownPluginCallback, {
  name: "app-shutdown",
  fastify: "5.x",
});
