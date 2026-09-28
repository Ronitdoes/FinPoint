import type Redis from "ioredis";
import { connect } from "node:net";

export interface ReadinessChecks {
  db: "up" | "down";
  redis: "up" | "down" | "disabled";
  temporal: "up" | "down" | "unconfigured";
}

export interface ReadinessResult {
  isReady: boolean;
  status: "ready" | "unhealthy";
  checks: ReadinessChecks;
  timestamp: string;
}

export interface MetaServiceOptions {
  name?: string;
  version?: string;
  gitSha?: string;
  env?: string;
  dbHealthCheck: () => Promise<boolean>;
  redisClient?: Redis | null;
  temporalAddress?: string | null;
}

export class MetaService {
  private readonly name: string;
  private readonly version: string;
  private readonly gitSha: string;
  private readonly env: string;
  private readonly dbHealthCheck: () => Promise<boolean>;
  private readonly redisClient?: Redis | null;
  private readonly temporalAddress?: string | null;

  private cachedReadiness: ReadinessResult | null = null;
  private lastReadinessCheckTime: number = 0;
  private readonly cacheTtlMs: number = 5000; // 5s cache per spec

  constructor(opts: MetaServiceOptions) {
    this.name = opts.name || "AI-Revenue-Recovery Backend";
    this.version = opts.version || "0.1.0";
    // Typed-config injection only (CONVENTIONS §1): callers pass
    // `config.release.gitSha` / `config.app.env` (see meta/routes.ts).
    // Defaults preserve standalone/test usage without env reads.
    this.gitSha = opts.gitSha || "dev";
    this.env = opts.env || "development";
    this.dbHealthCheck = opts.dbHealthCheck;
    this.redisClient = opts.redisClient;
    this.temporalAddress = opts.temporalAddress;
  }

  public getHealth(): { status: "ok"; uptime: number; timestamp: string } {
    return {
      status: "ok",
      uptime: Math.round(process.uptime() * 100) / 100,
      timestamp: new Date().toISOString(),
    };
  }

  public getVersion(): {
    name: string;
    version: string;
    gitSha: string;
    env: string;
  } {
    return {
      name: this.name,
      version: this.version,
      gitSha: this.gitSha,
      env: this.env,
    };
  }

  public async getReadiness(forceRefresh: boolean = false): Promise<ReadinessResult> {
    const now = Date.now();
    if (!forceRefresh && this.cachedReadiness && now - this.lastReadinessCheckTime < this.cacheTtlMs) {
      return this.cachedReadiness;
    }

    // 1. Check DB
    let dbStatus: "up" | "down" = "down";
    try {
      const isDbHealthy = await Promise.race([
        this.dbHealthCheck(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error("DB health check timeout")), 2000),
        ),
      ]);
      dbStatus = isDbHealthy ? "up" : "down";
    } catch {
      dbStatus = "down";
    }

    // 2. Check Redis
    let redisStatus: "up" | "down" | "disabled" = "disabled";
    if (this.redisClient) {
      try {
        const pingResult = await Promise.race([
          this.redisClient.ping(),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("Redis ping timeout")), 1500),
          ),
        ]);
        redisStatus = pingResult === "PONG" ? "up" : "down";
      } catch {
        redisStatus = "down";
      }
    }

    // 3. Check Temporal — real TCP reachability probe against the configured
    // address (host:port). `unconfigured` only when no address is set;
    // reachable within the probe timeout ⇒ `up`, otherwise `down`.
    // Note: informational only — `isReady` below deliberately gates on DB/Redis
    // (the API serves requests without Temporal; the worker has its own
    // supervision). Operators still see a truthful `temporal: down`.
    let temporalStatus: "up" | "down" | "unconfigured" = "unconfigured";
    if (this.temporalAddress) {
      try {
        temporalStatus = await Promise.race([
          this.temporalReachable(this.temporalAddress),
          new Promise<"down">((_, reject) =>
            setTimeout(() => reject(new Error("Temporal probe timeout")), 1500),
          ),
        ]);
      } catch {
        temporalStatus = "down";
      }
    }

    const isReady = dbStatus === "up" && (redisStatus === "up" || redisStatus === "disabled");

    const result: ReadinessResult = {
      isReady,
      status: isReady ? "ready" : "unhealthy",
      checks: {
        db: dbStatus,
        redis: redisStatus,
        temporal: temporalStatus,
      },
      timestamp: new Date().toISOString(),
    };

    this.cachedReadiness = result;
    this.lastReadinessCheckTime = now;

    return result;
  }

  /** TCP connect probe against `host:port`; `down` on error/timeout/malformed. */
  private temporalReachable(address: string): Promise<"up" | "down"> {
    const sep = address.lastIndexOf(":");
    const host = sep > 0 ? address.slice(0, sep) : "";
    const port = sep > 0 ? Number(address.slice(sep + 1)) : Number.NaN;
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      return Promise.resolve("down"); // malformed address — surface, don't crash
    }
    return new Promise<"up" | "down">((resolve) => {
      const socket = connect({ host, port });
      const settle = (status: "up" | "down") => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(status);
      };
      socket.setTimeout(1000, () => settle("down"));
      socket.once("connect", () => settle("up"));
      socket.once("error", () => settle("down"));
    });
  }
}
