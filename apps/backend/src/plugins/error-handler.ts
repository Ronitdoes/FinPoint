import type { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { ZodError } from "zod";
import { DomainError, DomainErrorCodes, type ErrorEnvelope } from "../lib/errors";

const errorHandlerPluginCallback: FastifyPluginAsync = async (fastify) => {
  // 1. Central 404 Not Found handler
  fastify.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const response: ErrorEnvelope = {
      error: {
        code: DomainErrorCodes.NOT_FOUND,
        message: `Route ${request.method} ${request.url} not found`,
        details: {
          path: request.url,
          method: request.method,
        },
      },
    };
    reply.status(404).send(response);
  });

  // 2. Central Error Handler
  fastify.setErrorHandler((error: FastifyError | Error | any, request: FastifyRequest, reply: FastifyReply) => {
    // 2a. Check if error is already formatted as a canonical error envelope (e.g. from rateLimit errorResponseBuilder)
    if (error && typeof error === "object" && error.error && typeof error.error.code === "string") {
      const code = error.error.code;
      const statusCode =
        error.statusCode ||
        (code === DomainErrorCodes.RATE_LIMITED ? 429 : code === DomainErrorCodes.VALIDATION ? 422 : 500);
      return reply.status(statusCode).send(error);
    }

    // 2b. DomainError subclasses
    if (error instanceof DomainError || (error && error.code in DomainErrorCodes)) {
      const domainErr = error as DomainError;
      if (domainErr.headers) {
        for (const [header, val] of Object.entries(domainErr.headers)) {
          reply.header(header, val);
        }
      }

      const response: ErrorEnvelope = {
        error: {
          code: domainErr.code,
          message: domainErr.message,
          details: domainErr.details ?? {},
        },
      };
      return reply.status(domainErr.statusCode || 500).send(response);
    }

    // 2c. Zod validation errors
    if (error instanceof ZodError || error?.name === "ZodError" || Array.isArray(error?.issues)) {
      const issues = (error as ZodError).issues || error?.issues;
      const response: ErrorEnvelope = {
        error: {
          code: DomainErrorCodes.VALIDATION,
          message: "Validation failed",
          details: issues,
        },
      };
      return reply.status(422).send(response);
    }

    // 2d. Fastify built-in schema validation errors
    if (error?.validation || error?.code === "FST_ERR_VALIDATION") {
      const response: ErrorEnvelope = {
        error: {
          code: DomainErrorCodes.VALIDATION,
          message: error.message || "Request schema validation failed",
          details: error.validation ?? {},
        },
      };
      return reply.status(422).send(response);
    }

    // 2e. Fastify Payload Too Large (413)
    if (error?.statusCode === 413 || error?.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      const response: ErrorEnvelope = {
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request payload exceeds limit (256KB)",
          details: {},
        },
      };
      return reply.status(413).send(response);
    }

    // 2f. Fastify Rate Limit (429) — includes temporary IP blocks (s-30)
    if (error?.statusCode === 429 || error?.code === "FST_ERR_RATE_LIMIT" || error?.code === DomainErrorCodes.RATE_LIMITED || error?.code === DomainErrorCodes.IP_BLOCKED) {
      const response: ErrorEnvelope = {
        error: {
          code: error?.code === DomainErrorCodes.IP_BLOCKED ? DomainErrorCodes.IP_BLOCKED : DomainErrorCodes.RATE_LIMITED,
          message: error.message || "Rate limit exceeded",
          details: error.details ?? {},
        },
      };
      const replyWithHeaders = reply as FastifyReply;
      if (error?.headers && typeof error.headers === "object") {
        for (const [header, val] of Object.entries(error.headers as Record<string, string>)) {
          replyWithHeaders.header(header, val);
        }
      }
      return reply.status(429).send(response);
    }

    // 2g. Fastify 404 (e.g. from plugin)
    if (error?.statusCode === 404) {
      const response: ErrorEnvelope = {
        error: {
          code: DomainErrorCodes.NOT_FOUND,
          message: error.message || "Resource not found",
          details: {},
        },
      };
      return reply.status(404).send(response);
    }

    // 2h. Fastify Bad Request (400, e.g. malformed JSON)
    if (error?.statusCode === 400 || (typeof error?.code === "string" && error.code.startsWith("FST_ERR_CTP_"))) {
      const response: ErrorEnvelope = {
        error: {
          code: "BAD_REQUEST",
          message: error.message || "Invalid request syntax or body",
          details: {},
        },
      };
      return reply.status(400).send(response);
    }

    // 2i. Unhandled internal error (500)
    // Structured log with full stack and correlation context (CONVENTIONS §6 & §7)
    request.log.error(
      {
        err: {
          name: error?.name,
          message: error?.message,
          stack: error?.stack,
        },
        requestId: request.requestId,
        correlationId: request.correlationId,
      },
      "Unhandled server exception",
    );

    // Never leak error message or stack to the client
    const response: ErrorEnvelope = {
      error: {
        code: DomainErrorCodes.INTERNAL,
        message: "An internal server error occurred",
        details: {},
      },
    };
    return reply.status(500).send(response);
  });
};

export const errorHandlerPlugin = fp(errorHandlerPluginCallback, {
  name: "app-error-handler",
  fastify: "5.x",
});
