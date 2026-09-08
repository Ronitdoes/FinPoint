import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import { recordIpBlock, recordSignatureFailure } from "@repo/observability";
import { IpBlockedError } from "../../lib/errors";

declare module "fastify" {
  interface FastifyInstance {
    ipBlockService: IpBlockService;
    checkIpBlock: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface IpBlockOptions {
  /** Signature failures from one IP inside the window before a block. Default 10. */
  failureThreshold?: number;
  /** Sliding window for counting failures, seconds. Default 600 (10 min). */
  failureWindowSeconds?: number;
  /** Block duration, seconds. Default 600 (10 min). */
  blockTtlSeconds?: number;
}

interface MemoryEntry {
  count: number;
  expiresAt: number;
}

const SIGFAIL_PREFIX = "sec:sigfail:";
const IPBLOCK_PREFIX = "sec:ipblock:";

/**
 * Temporary IP blocking after repeated webhook signature failures
 * (Step 30 §Requirements 4: abuse rule).
 *
 * - Failures are counted per client IP in a sliding window (Redis-backed,
 *   in-memory fallback when Redis is unavailable).
 * - Reaching `failureThreshold` installs a block key with `blockTtlSeconds`
 *   TTL (default 10 min). Blocked callers receive 429 `IP_BLOCKED` with a
 *   `Retry-After` header (see `checkIpBlock`).
 * - Blocks are cleared early via `DELETE /admin/ip-blocks/:ip` (ADMIN).
 * - Every block emits a WARN log with structured keys plus
 *   `security_ip_blocks_total{reason}` for s-34 alerting.
 */
export class IpBlockService {
  private readonly redis: Redis | null;
  private readonly failureThreshold: number;
  private readonly failureWindowSeconds: number;
  private readonly blockTtlSeconds: number;
  private readonly memoryFailures = new Map<string, MemoryEntry>();
  private readonly memoryBlocks = new Map<string, number>();

  constructor(redis: Redis | null, opts: IpBlockOptions = {}) {
    this.redis = redis;
    this.failureThreshold = opts.failureThreshold ?? 10;
    this.failureWindowSeconds = opts.failureWindowSeconds ?? 600;
    this.blockTtlSeconds = opts.blockTtlSeconds ?? 600;
  }

  get config(): Required<IpBlockOptions> {
    return {
      failureThreshold: this.failureThreshold,
      failureWindowSeconds: this.failureWindowSeconds,
      blockTtlSeconds: this.blockTtlSeconds,
    };
  }

  private redisReady(): boolean {
    return !!this.redis && this.redis.status === "ready";
  }

  /**
   * Records one signature verification failure for `ip`. Returns whether the
   * IP is now blocked and the current failure count.
   */
  async recordSignatureFailure(
    ip: string,
    provider: string,
    log?: { warn: (obj: unknown, msg: string) => void },
  ): Promise<{ blocked: boolean; failures: number }> {
    recordSignatureFailure(provider);
    const normalizedIp = normalizeIp(ip);

    if (this.redisReady()) {
      try {
        const failKey = `${SIGFAIL_PREFIX}${normalizedIp}`;
        const failures = await this.redis!.incr(failKey);
        if (failures === 1) {
          await this.redis!.expire(failKey, this.failureWindowSeconds);
        }
        if (failures >= this.failureThreshold) {
          await this.redis!.set(
            `${IPBLOCK_PREFIX}${normalizedIp}`,
            String(Date.now()),
            "EX",
            this.blockTtlSeconds,
          );
          this.emitBlock(normalizedIp, provider, failures, log);
          return { blocked: true, failures };
        }
        return { blocked: false, failures };
      } catch {
        // Redis error mid-flight: fall through to in-memory counting.
      }
    }

    const now = Date.now();
    const entry = this.memoryFailures.get(normalizedIp);
    let failures: number;
    if (!entry || entry.expiresAt <= now) {
      failures = 1;
      this.memoryFailures.set(normalizedIp, {
        count: 1,
        expiresAt: now + this.failureWindowSeconds * 1000,
      });
    } else {
      entry.count += 1;
      failures = entry.count;
    }
    if (failures >= this.failureThreshold) {
      this.memoryBlocks.set(normalizedIp, now + this.blockTtlSeconds * 1000);
      this.emitBlock(normalizedIp, provider, failures, log);
      return { blocked: true, failures };
    }
    return { blocked: false, failures };
  }

  /** Returns block status and remaining TTL for `ip`. */
  async isBlocked(ip: string): Promise<{ blocked: boolean; ttlSeconds: number }> {
    const normalizedIp = normalizeIp(ip);
    if (this.redisReady()) {
      try {
        const ttl = await this.redis!.ttl(`${IPBLOCK_PREFIX}${normalizedIp}`);
        if (ttl > 0) {
          return { blocked: true, ttlSeconds: ttl };
        }
        return { blocked: false, ttlSeconds: 0 };
      } catch {
        // fall through to memory
      }
    }
    const expiresAt = this.memoryBlocks.get(normalizedIp);
    if (expiresAt && expiresAt > Date.now()) {
      return {
        blocked: true,
        ttlSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
      };
    }
    if (expiresAt) {
      this.memoryBlocks.delete(normalizedIp);
    }
    return { blocked: false, ttlSeconds: 0 };
  }

  /** Clears failure counters and any active block for `ip` (admin path). */
  async clearIpBlock(ip: string): Promise<void> {
    const normalizedIp = normalizeIp(ip);
    if (this.redisReady()) {
      try {
        await this.redis!.del(
          `${IPBLOCK_PREFIX}${normalizedIp}`,
          `${SIGFAIL_PREFIX}${normalizedIp}`,
        );
      } catch {
        // ignore; memory cleanup below still applies
      }
    }
    this.memoryBlocks.delete(normalizedIp);
    this.memoryFailures.delete(normalizedIp);
  }

  /** Lists currently blocked IPs with remaining TTL (admin inspection). */
  async listBlockedIps(): Promise<Array<{ ip: string; ttlSeconds: number }>> {
    if (this.redisReady()) {
      try {
        const keys = await this.redis!.keys(`${IPBLOCK_PREFIX}*`);
        const result: Array<{ ip: string; ttlSeconds: number }> = [];
        for (const key of keys) {
          const ttl = await this.redis!.ttl(key);
          if (ttl > 0) {
            result.push({ ip: key.slice(IPBLOCK_PREFIX.length), ttlSeconds: ttl });
          }
        }
        return result;
      } catch {
        // fall through to memory
      }
    }
    const now = Date.now();
    const result: Array<{ ip: string; ttlSeconds: number }> = [];
    for (const [ip, expiresAt] of this.memoryBlocks) {
      if (expiresAt > now) {
        result.push({ ip, ttlSeconds: Math.ceil((expiresAt - now) / 1000) });
      }
    }
    return result;
  }

  private emitBlock(
    ip: string,
    provider: string,
    failures: number,
    log?: { warn: (obj: unknown, msg: string) => void },
  ): void {
    recordIpBlock("signature_failures");
    const fields = {
      event: "security.ip_blocked",
      ip,
      provider,
      failures,
      ttlSeconds: this.blockTtlSeconds,
    };
    if (log) {
      log.warn(fields, "IP temporarily blocked after repeated webhook signature failures");
    }
  }
}

/**
 * Pre-handler guard: rejects requests from temporarily blocked IPs with
 * 429 `IP_BLOCKED` + `Retry-After`. Mount on all webhook surfaces.
 */
export async function checkIpBlock(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const service = (request.server as FastifyInstance).ipBlockService as
    | IpBlockService
    | undefined;
  if (!service) {
    return;
  }
  const ip = request.ip || "127.0.0.1";
  const status = await service.isBlocked(ip);
  if (status.blocked) {
    request.log.warn(
      { event: "security.ip_block_reject", ip, ttlSeconds: status.ttlSeconds },
      "Rejected request from temporarily blocked IP",
    );
    throw new IpBlockedError(
      "IP temporarily blocked due to repeated authentication failures",
      status.ttlSeconds,
      { ttlSeconds: status.ttlSeconds },
    );
  }
}

function normalizeIp(ip: string): string {
  return (ip || "unknown").trim().toLowerCase().slice(0, 64) || "unknown";
}
