import { z } from "zod";

/**
 * Raw, per-group zod schemas for environment variables.
 *
 * `packages/config` is the only place `process.env` is read in this monorepo
 * (CONVENTIONS §1). Everything else consumes the typed, frozen configs built
 * by the presets in api.ts / worker.ts / web.ts.
 *
 * Vetted edge-read allowlist (mirrors `scripts/audit-boundaries.ts` rule 6,
 * reported as INFO not WARN): `scripts/**` (gates/ops CLIs), `tests/**`
 * (harness wiring), `apps/backend/scripts/seed-admin.ts` (bootstrap CLI),
 * `apps/frontend/src/lib/api.ts` (NEXT_PUBLIC_* public base URL),
 * `packages/db/drizzle.config.ts` (drizzle-kit CLI, build-time only),
 * `packages/db/src/client.ts` + `packages/db/src/migrate.ts` + seed tenant
 * overrides (connection bootstrap). Gateway webhook *verification* secrets and
 * demo loopback signers resolve through typed config first (`ServerConfig`
 * payments/messaging/demo groups); see `audit-boundaries.ts` rule 2 for the
 * vetted INFO paths. All other `process.env` reads are WARN (grandfathered,
 * migrate to typed config).
 */

export type EnvSource = Record<string, string | undefined>;

const booleanFlag = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/** Defaults to false before transforming, since `.default` sees the raw string. */
const booleanFlagDefaultFalse = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalBooleanFlag = booleanFlag.optional();

export const nodeEnvSchema = z.enum(["development", "test", "production"]);

export const appSchema = z.object({
  NODE_ENV: nodeEnvSchema.default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export const databaseSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().min(1).optional(),
});

export const redisSchema = z.object({
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
});

export const temporalSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1, "TEMPORAL_ADDRESS is required"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("revenue-recovery"),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default("recovery-main"),
});

export const busSchema = z.object({
  EVENT_BUS_DRIVER: z.enum(["redpanda", "inprocess"]).default("inprocess"),
  REDPANDA_BROKERS: z.string().min(1).optional(),
});

export const aiSchema = z.object({
  LLM_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).default("gpt-4o"),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
});

export const paymentsSchema = z.object({
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
});

export const messagingSchema = z.object({
  WHATSAPP_API_KEY: z.string().min(1).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  WHATSAPP_VERIFY_SECRET: z.string().min(1).optional(),
  EMAIL_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  EMAIL_WEBHOOK_SECRET: z.string().min(1).optional(),
  /**
   * Test/local-dev escape hatch for messaging webhooks (see
   * `apps/backend/src/modules/messaging/webhooks/*`). Null when unset:
   * WhatsApp defaults to non-prod bypass unless explicitly "false";
   * email defaults to requiring a token unless explicitly "true".
   */
  ALLOW_UNSIGNED_WEBHOOKS: optionalBooleanFlag,
});

export const demoSchema = z.object({
  MOCK_PROVIDERS: optionalBooleanFlag,
  SIMULATE_PAYMENT_TIMEOUT: booleanFlagDefaultFalse,
  SIMULATE_MESSAGE_FAILURE: booleanFlagDefaultFalse,
  SIMULATE_LLM_FAILURE: booleanFlagDefaultFalse,
  SIMULATE_DUPLICATE_WEBHOOK: booleanFlagDefaultFalse,
});

export const otelSchema = z.object({
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

/**
 * Monitoring & alerting surface (s-34, docs/SLO.md, ADR-016). All optional:
 * gauges still refresh in-process for `GET /metrics` when the pushgateway
 * is unset; the cohort label keeps business KPI series to staging|prod.
 */
export const monitoringSchema = z.object({
  PUSHGATEWAY_URL: z.string().url().optional(),
  MONITORING_COHORT: z.string().min(1).default("staging"),
  KPI_SNAPSHOT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  INFRA_SAMPLER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 1000),
});

export const authSchema = z.object({
  SESSION_SECRET: z
    .string()
    .min(16)
    .default("arr-session-secret-key-development-32chars"),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().min(1).optional(),
  BOOTSTRAP_TENANT_NAME: z.string().min(1).optional(),
});

export const webPublicSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:8000"),
});

/**
 * HTTP edge surface (s-02 audit fix). CORS allowlist and cookie-secure
 * override were previously read via raw `process.env` in
 * `apps/backend/src/plugins/cors.ts` and `modules/auth/routes.ts`.
 * Centralized here so the backend consumes `config.http` instead.
 *
 * s-07 §Technical Implementation: `REQUEST_TIMEOUT_MS` bounds the default
 * per-request budget (10s); `WEBHOOK_TIMEOUT_MS` gives provider webhooks a
 * longer 25s budget for signature verification + idempotent ingest while
 * still acking fast. Backend-only surface: never exposed via `webConfig`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 25_000;

export const httpSchema = z.object({
  CORS_ALLOWED_ORIGINS: z.string().min(1).optional(),
  COOKIE_SECURE: optionalBooleanFlag,
  REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  WEBHOOK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_WEBHOOK_TIMEOUT_MS),
});

/**
 * Release metadata (s-02 audit fix). Non-secret build stamping consumed by
 * `apps/backend/src/server.ts` boot log and `modules/meta` `/version`.
 * Previously read via raw `process.env.APP_VERSION` / `GIT_SHA`.
 */
export const releaseSchema = z.object({
  APP_VERSION: z.string().min(1).default("dev"),
  GIT_SHA: z.string().min(1).default("dev"),
});

/**
 * Background cron inventory (s-33, docs/deploy/crons.md). Intervals are
 * millisecond durations; all jobs are idempotent and overlap-guarded, so a
 * missed or doubled tick is harmless. CRON_ENABLED defaults ON except in
 * `test` (same convention as MOCK_PROVIDERS defaulting by NODE_ENV).
 */
export const cronSchema = z.object({
  CRON_ENABLED: optionalBooleanFlag,
  ATTRIBUTION_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),
  COST_AUDIT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  RETENTION_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60 * 1000),
});

/**
 * Provider credentials are nullable at startup when mock mode is on; required
 * otherwise (spec 03 §2). MOCK_PROVIDERS defaults to true except in
 * production, where live providers are assumed.
 */
const REQUIRED_LIVE_PROVIDER_KEYS = [
  "LLM_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "WHATSAPP_API_KEY",
  "WHATSAPP_PHONE_NUMBER_ID",
  "EMAIL_API_KEY",
] as const;

const serverSchemaBase = appSchema
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(temporalSchema)
  .merge(busSchema)
  .merge(aiSchema)
  .merge(paymentsSchema)
  .merge(messagingSchema)
  .merge(demoSchema)
  .merge(otelSchema)
  .merge(monitoringSchema)
  .merge(authSchema)
  .merge(cronSchema)
  .merge(httpSchema)
  .merge(releaseSchema);

export const serverEnvSchema = serverSchemaBase.superRefine((value, ctx) => {
  const mockProviders = value.MOCK_PROVIDERS ?? value.NODE_ENV !== "production";

  if (!mockProviders) {
    for (const key of REQUIRED_LIVE_PROVIDER_KEYS) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate !== "string" || candidate.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when MOCK_PROVIDERS=false (live provider mode)`,
        });
      }
    }
  }

  if (value.EVENT_BUS_DRIVER === "redpanda" && !value.REDPANDA_BROKERS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REDPANDA_BROKERS"],
      message:
        "REDPANDA_BROKERS is required when EVENT_BUS_DRIVER=redpanda",
    });
  }
});

export type RawServerEnv = z.output<typeof serverEnvSchema>;
export type RawAppValues = z.infer<typeof appSchema>;
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/** Error thrown when environment validation fails. Carries a readable summary. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return `- ${path || "(env)"}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Env maps may contain empty strings (e.g. `LLM_API_KEY=` in `.env`); treat
 * those as unset so optionality works as intended.
 */
export function normalizeSource(source: EnvSource): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") {
      normalized[key] = value;
    }
  }
  return normalized;
}

/** Parse and validate all server-side env vars. Throws ConfigValidationError. */
export function parseServerEnv(source: EnvSource = process.env): RawServerEnv {
  const result = serverEnvSchema.safeParse(normalizeSource(source));
  if (!result.success) {
    throw new ConfigValidationError(
      `Invalid environment configuration:\n${formatIssues(result.error)}`,
    );
  }
  return result.data;
}

/** Effective mock-mode flag for an already-validated env. */
export function resolveMockProviders(env: RawServerEnv): boolean {
  return env.MOCK_PROVIDERS ?? env.NODE_ENV !== "production";
}

/** Effective cron master toggle for an already-validated env. */
export function resolveCronEnabled(env: RawServerEnv): boolean {
  return env.CRON_ENABLED ?? env.NODE_ENV !== "test";
}
