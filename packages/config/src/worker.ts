import { apiConfig, type ServerConfig } from "./api";

export type WorkerConfig = ServerConfig;

/**
 * Typed, validated, immutable configuration for the worker service
 * (`services/worker`).
 *
 * Today the worker consumes the same validated surface as the API — both are
 * server-side workloads sharing database/redis/temporal/bus access, and
 * adapter activities will read provider credentials through here until
 * `packages/integrations` owns them (s-18/s-19). If the two presets must
 * diverge later (least privilege), split them there; callers keep using
 * `workerConfig()`.
 */
export function workerConfig(
  source: Record<string, string | undefined> = process.env,
): WorkerConfig {
  return apiConfig(source);
}
