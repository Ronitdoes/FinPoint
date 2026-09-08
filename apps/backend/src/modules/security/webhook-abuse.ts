import type { FastifyInstance, FastifyRequest } from "fastify";
import type { IpBlockService } from "./ip-block.service";

/**
 * Shared abuse-accounting helper for webhook surfaces (Step 30 §Requirements 4).
 *
 * Records one authentication failure (bad/missing provider signature) for
 * the caller IP, emits a structured WARN security event, and reports whether
 * the IP crossed into a temporary block. Never throws — abuse accounting
 * must not break the webhook response path.
 */
export async function recordWebhookAuthFailure(
  fastify: FastifyInstance,
  request: FastifyRequest,
  provider: string,
): Promise<{ blocked: boolean; failures: number }> {
  try {
    const service = (fastify as unknown as { ipBlockService?: IpBlockService })
      .ipBlockService;
    if (!service) {
      request.log.warn(
        { event: "security.signature_failure", provider },
        "Webhook signature verification failed",
      );
      return { blocked: false, failures: 0 };
    }
    const ip = request.ip || "127.0.0.1";
    const result = await service.recordSignatureFailure(ip, provider, request.log);
    if (!result.blocked) {
      request.log.warn(
        {
          event: "security.signature_failure",
          provider,
          ip,
          failures: result.failures,
        },
        "Webhook signature verification failed",
      );
    }
    return result;
  } catch {
    return { blocked: false, failures: 0 };
  }
}
