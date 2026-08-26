import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    correlationId: string;
  }
}

export interface ContextPluginOptions {
  headerName?: string;
  correlationHeaderName?: string;
}

const contextPluginCallback: FastifyPluginAsync<ContextPluginOptions> = async (
  fastify,
  opts,
) => {
  const correlationHeader = (opts.correlationHeaderName || "x-correlation-id").toLowerCase();
  const requestHeader = (opts.headerName || "x-request-id").toLowerCase();

  // Decorate FastifyRequest prototype for TypeScript and V8 shape optimization
  fastify.decorateRequest("requestId", "");
  fastify.decorateRequest("correlationId", "");

  fastify.addHook("onRequest", async (req: FastifyRequest) => {
    // 1. Resolve or generate Request ID
    const incomingReqId = req.headers[requestHeader];
    const requestId =
      typeof incomingReqId === "string" && incomingReqId.trim().length > 0
        ? incomingReqId
        : (req.id || randomUUID());
    req.requestId = requestId;

    // 2. Resolve or generate Correlation ID
    const incomingCorrId = req.headers[correlationHeader];
    const traceparent = req.headers["traceparent"];
    let correlationId: string;

    if (typeof incomingCorrId === "string" && incomingCorrId.trim().length > 0) {
      correlationId = incomingCorrId;
    } else if (typeof traceparent === "string" && traceparent.trim().length > 0) {
      // Extract trace-id portion from W3C traceparent (version-traceid-parentid-traceflags)
      const parts = traceparent.split("-");
      correlationId = parts.length >= 2 && parts[1] ? parts[1] : randomUUID();
    } else {
      correlationId = randomUUID();
    }
    req.correlationId = correlationId;

    // 3. Bind request context to child logger
    req.log = req.log.child({
      requestId,
      correlationId,
    });
  });

  fastify.addHook("onSend", async (req, reply, payload) => {
    // Echo context headers back in response for traceability (CONVENTIONS §11)
    reply.header(requestHeader, req.requestId);
    reply.header(correlationHeader, req.correlationId);
    return payload;
  });
};

export const contextPlugin = fp(contextPluginCallback, {
  name: "request-context",
  fastify: "5.x",
});
