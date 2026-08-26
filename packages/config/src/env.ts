import { z } from "zod";

/**
 * Raw, per-group zod schemas for environment variables.
 *
 * `packages/config` is the only place `process.env` is read in this monorepo
 * (CONVENTIONS §1). Everything else consumes the typed, frozen configs built
 * by the presets in api.ts / worker.ts / web.ts.
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
  EMAIL_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
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

export const webPublicSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:8000"),
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
  .merge(otelSchema);

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
