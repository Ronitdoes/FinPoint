import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import type { IpBlockService } from "../security/ip-block.service";

const ipParamSchema = z.object({
  ip: z
    .string()
    .min(1)
    .max(64)
    .refine((v) => /^[0-9a-fA-F:.]+$/.test(v), {
      message: "Invalid IP address format",
    }),
});

/**
 * Admin IP-block management (Step 30 §Reliability).
 *
 * Temporary signature-abuse blocks expire on their own after 10 minutes;
 * these endpoints give ADMIN operators an explicit clear path plus
 * inspection for incident response.
 */
export const ipBlocksRoutes: FastifyPluginAsync = async (fastify) => {
  const service = (): IpBlockService => fastify.ipBlockService;

  /**
   * GET /admin/ip-blocks — List currently blocked IPs (ADMIN only).
   */
  fastify.get(
    "/ip-blocks",
    { preHandler: [fastify.requireAuth, fastify.requireRole("ADMIN")] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const blocked = await service().listBlockedIps();
      return reply.status(200).send({ blocked });
    },
  );

  /**
   * DELETE /admin/ip-blocks/:ip — Clear failure counters + block early (ADMIN only).
   */
  fastify.delete(
    "/ip-blocks/:ip",
    { preHandler: [fastify.requireAuth, fastify.requireRole("ADMIN")] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = ipParamSchema.safeParse(request.params);
      if (!parseResult.success) {
        throw new ValidationError("Invalid IP parameter", {
          issues: parseResult.error.issues,
        });
      }
      await service().clearIpBlock(parseResult.data.ip);
      request.log.warn(
        { event: "security.ip_block_cleared", ip: parseResult.data.ip },
        "Admin cleared temporary IP block",
      );
      return reply.status(204).send();
    },
  );
};
