import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

export interface OtelPluginOptions {
  enabled?: boolean;
}

const otelPluginCallback: FastifyPluginAsync<OtelPluginOptions> = async (
  fastify,
  _opts,
) => {
  // Step 07 registration hook point; full OpenTelemetry tracing & metric exports land in s-08.
  fastify.decorate("isOtelActive", false);
};

export const otelPlugin = fp(otelPluginCallback, {
  name: "app-otel",
  fastify: "5.x",
});
