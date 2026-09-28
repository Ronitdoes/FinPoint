import {
  parseServerEnv,
  resolveCronEnabled,
  resolveMockProviders,
  type NodeEnv,
  type RawServerEnv,
} from "./env";

export interface AppConfigValues {
  readonly env: NodeEnv;
  readonly port: number;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
}

export interface DatabaseConfig {
  /** Pooled connection string for normal queries. */
  readonly url: string;
  /** Direct (unpooled) connection for migrations/DDL; falls back to `url`. */
  readonly directUrl: string;
}

export interface RedisConfig {
  readonly url: string;
}

export interface TemporalConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
}

export interface BusConfig {
  readonly driver: "redpanda" | "inprocess";
  /** Null unless EVENT_BUS_DRIVER=redpanda (enforced by the schema refinement). */
  readonly brokers: string | null;
}

export interface AiConfig {
  /** Null in mock mode; validated non-null when MOCK_PROVIDERS=false. */
  readonly apiKey: string | null;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly enableRuleFallback?: boolean;
}

export interface PaymentsConfig {
  readonly stripeSecretKey: string | null;
  readonly stripeWebhookSecret: string | null;
  readonly razorpayKeyId: string | null;
  readonly razorpayKeySecret: string | null;
  readonly razorpayWebhookSecret: string | null;
}

export interface MessagingConfig {
  readonly whatsappApiKey: string | null;
  readonly whatsappPhoneNumberId: string | null;
  readonly whatsappVerifySecret: string | null;
  readonly emailApiKey: string | null;
  readonly emailFrom: string | null;
  readonly emailWebhookSecret: string | null;
  /**
   * Null when ALLOW_UNSIGNED_WEBHOOKS is unset (each webhook route applies
   * its own documented default). True/false only when explicitly set.
   */
  readonly allowUnsignedWebhooks: boolean | null;
}

export interface DemoConfig {
  readonly mockProviders: boolean;
  readonly simulatePaymentTimeout: boolean;
  readonly simulateMessageFailure: boolean;
  readonly simulateLlmFailure: boolean;
  readonly simulateDuplicateWebhook: boolean;
}

export interface OtelConfig {
  readonly otlpEndpoint: string | null;
}

export interface MonitoringConfig {
  /** Pushgateway base URL; null ⇒ gauges refresh in-process only. */
  readonly pushGatewayUrl: string | null;
  /** Cohort label for KPI series (`staging`|`prod`). */
  readonly cohort: string;
  readonly kpiSnapshotIntervalMs: number;
  readonly infraSamplerIntervalMs: number;
}

export interface AuthConfig {
  readonly sessionSecret: string;
  readonly bootstrapAdminEmail: string | null;
  readonly bootstrapAdminPassword: string | null;
  readonly bootstrapAdminName: string | null;
  readonly bootstrapTenantName: string | null;
}

export interface CronConfig {
  /** Master toggle (CRON_ENABLED, default on except in test). */
  readonly enabled: boolean;
  /** Attribution window sweeper cadence (default hourly). */
  readonly attributionSweepIntervalMs: number;
  /** Action-cost completeness audit cadence (default daily). */
  readonly costAuditIntervalMs: number;
  /** Invoice/PTP reconciler cadence (default daily). */
  readonly reconcileIntervalMs: number;
  /** Audit-retention archive cadence (default monthly). */
  readonly retentionSweepIntervalMs: number;
}

export interface HttpConfig {
  /**
   * Extra allowed origins from CORS_ALLOWED_ORIGINS (comma-separated raw).
   * Empty array when unset; callers merge with dev defaults.
   */
  readonly corsAllowedOrigins: readonly string[];
  /**
   * Explicit COOKIE_SECURE override. Null when unset ⇒ derive from
   * `app.env === "production"` at the call site (see auth routes).
   */
  readonly cookieSecure: boolean | null;
  /**
   * Default per-request budget in ms (REQUEST_TIMEOUT_MS, default 10000).
   * Wired to Fastify `requestTimeout` (socket-level receive guard) and
   * `handlerTimeout` (app-level lifecycle guard) in `buildApp` (s-07).
   */
  readonly requestTimeoutMs: number;
  /**
   * Longer budget for provider webhook ingestion (WEBHOOK_TIMEOUT_MS,
   * default 25000). Applied per-route via `handlerTimeout` on every route
   * under `/webhooks/*` (s-07); see `modules/webhooks/routes.ts`.
   */
  readonly webhookTimeoutMs: number;
}

export interface ReleaseConfig {
  /** Non-secret build version stamp (APP_VERSION, default "dev"). */
  readonly version: string;
  /** Non-secret git SHA stamp (GIT_SHA, default "dev"). */
  readonly gitSha: string;
}

/**
 * Full server-side configuration surface (API + worker). Provider credentials
 * are reachable only from `packages/integrations` per CONVENTIONS §12 — this
 * type merely transports values that were validated at boot.
 */
export interface ServerConfig {
  readonly app: AppConfigValues;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly temporal: TemporalConfig;
  readonly bus: BusConfig;
  readonly ai: AiConfig;
  readonly payments: PaymentsConfig;
  readonly messaging: MessagingConfig;
  readonly demo: DemoConfig;
  readonly otel: OtelConfig;
  readonly monitoring: MonitoringConfig;
  readonly auth: AuthConfig;
  readonly cron: CronConfig;
  readonly http: HttpConfig;
  readonly release: ReleaseConfig;
}

function parseCorsAllowedOrigins(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return Object.freeze(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function fromRaw(raw: RawServerEnv): ServerConfig {
  const mockProviders = resolveMockProviders(raw);
  return Object.freeze({
    app: Object.freeze({
      env: raw.NODE_ENV,
      port: raw.PORT,
      logLevel: raw.LOG_LEVEL,
    }),
    database: Object.freeze({
      url: raw.DATABASE_URL,
      directUrl: raw.DIRECT_URL ?? raw.DATABASE_URL,
    }),
    redis: Object.freeze({ url: raw.REDIS_URL }),
    temporal: Object.freeze({
      address: raw.TEMPORAL_ADDRESS,
      namespace: raw.TEMPORAL_NAMESPACE,
      taskQueue: raw.TEMPORAL_TASK_QUEUE,
    }),
    bus: Object.freeze({
      driver: raw.EVENT_BUS_DRIVER,
      brokers: raw.REDPANDA_BROKERS ?? null,
    }),
    ai: Object.freeze({
      apiKey: raw.LLM_API_KEY ?? null,
      model: raw.AI_MODEL,
      baseUrl: raw.LLM_BASE_URL ?? null,
      timeoutMs: raw.LLM_TIMEOUT_MS,
      maxRetries: raw.LLM_MAX_RETRIES,
    }),
    payments: Object.freeze({
      stripeSecretKey: raw.STRIPE_SECRET_KEY ?? null,
      stripeWebhookSecret: raw.STRIPE_WEBHOOK_SECRET ?? null,
      razorpayKeyId: raw.RAZORPAY_KEY_ID ?? null,
      razorpayKeySecret: raw.RAZORPAY_KEY_SECRET ?? null,
      razorpayWebhookSecret: raw.RAZORPAY_WEBHOOK_SECRET ?? null,
    }),
    messaging: Object.freeze({
      whatsappApiKey: raw.WHATSAPP_API_KEY ?? null,
      whatsappPhoneNumberId: raw.WHATSAPP_PHONE_NUMBER_ID ?? null,
      whatsappVerifySecret: raw.WHATSAPP_VERIFY_SECRET ?? null,
      emailApiKey: raw.EMAIL_API_KEY ?? null,
      emailFrom: raw.EMAIL_FROM ?? null,
      emailWebhookSecret: raw.EMAIL_WEBHOOK_SECRET ?? null,
      allowUnsignedWebhooks: raw.ALLOW_UNSIGNED_WEBHOOKS ?? null,
    }),
    demo: Object.freeze({
      mockProviders,
      simulatePaymentTimeout: raw.SIMULATE_PAYMENT_TIMEOUT,
      simulateMessageFailure: raw.SIMULATE_MESSAGE_FAILURE,
      simulateLlmFailure: raw.SIMULATE_LLM_FAILURE,
      simulateDuplicateWebhook: raw.SIMULATE_DUPLICATE_WEBHOOK,
    }),
    otel: Object.freeze({
      otlpEndpoint: raw.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
    }),
    monitoring: Object.freeze({
      pushGatewayUrl: raw.PUSHGATEWAY_URL ?? null,
      cohort: raw.MONITORING_COHORT,
      kpiSnapshotIntervalMs: raw.KPI_SNAPSHOT_INTERVAL_MS,
      infraSamplerIntervalMs: raw.INFRA_SAMPLER_INTERVAL_MS,
    }),
    auth: Object.freeze({
      sessionSecret: raw.SESSION_SECRET,
      bootstrapAdminEmail: raw.BOOTSTRAP_ADMIN_EMAIL ?? null,
      bootstrapAdminPassword: raw.BOOTSTRAP_ADMIN_PASSWORD ?? null,
      bootstrapAdminName: raw.BOOTSTRAP_ADMIN_NAME ?? null,
      bootstrapTenantName: raw.BOOTSTRAP_TENANT_NAME ?? null,
    }),
    cron: Object.freeze({
      enabled: resolveCronEnabled(raw),
      attributionSweepIntervalMs: raw.ATTRIBUTION_SWEEP_INTERVAL_MS,
      costAuditIntervalMs: raw.COST_AUDIT_INTERVAL_MS,
      reconcileIntervalMs: raw.RECONCILE_INTERVAL_MS,
      retentionSweepIntervalMs: raw.RETENTION_SWEEP_INTERVAL_MS,
    }),
    http: Object.freeze({
      corsAllowedOrigins: parseCorsAllowedOrigins(raw.CORS_ALLOWED_ORIGINS),
      cookieSecure: raw.COOKIE_SECURE ?? null,
      requestTimeoutMs: raw.REQUEST_TIMEOUT_MS,
      webhookTimeoutMs: raw.WEBHOOK_TIMEOUT_MS,
    }),
    release: Object.freeze({
      version: raw.APP_VERSION,
      gitSha: raw.GIT_SHA,
    }),
  });
}

/**
 * Typed, validated, immutable configuration for the API (`apps/backend`).
 *
 * Fail-fast: throws ConfigValidationError on missing/invalid values.
 * Config is loaded once at boot and never re-read at runtime (CONVENTIONS:
 * no runtime re-reads → no inconsistent state mid-request).
 */
export function apiConfig(
  source: Record<string, string | undefined> = process.env,
): ServerConfig {
  return fromRaw(parseServerEnv(source));
}
