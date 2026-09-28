import { describe, expect, it } from "vitest";

import {
  apiConfig,
  ConfigValidationError,
  webConfig,
  workerConfig,
} from "./index";

/** Baseline env satisfying every hard requirement; tests mutate from here. */
function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "development",
    PORT: "8000",
    LOG_LEVEL: "info",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/revenue_recovery",
    DIRECT_URL: "postgres://postgres:postgres@localhost:5432/revenue_recovery",
    REDIS_URL: "redis://localhost:6379",
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_NAMESPACE: "revenue-recovery",
    EVENT_BUS_DRIVER: "inprocess",
    AI_MODEL: "gpt-4o",
    MOCK_PROVIDERS: "true",
  };
}

function expectConfigError(run: () => unknown, needle: string): void {
  try {
    run();
    expect.fail(`expected ConfigValidationError containing "${needle}"`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect((error as ConfigValidationError).message).toContain(needle);
  }
}

describe("apiConfig", () => {
  it("parses a valid env and applies defaults", () => {
    const config = apiConfig(baseEnv());

    expect(config.app).toEqual({
      env: "development",
      port: 8000,
      logLevel: "info",
    });
    // Defaults applied for omitted optional values:
    const env = baseEnv();
    delete env.TEMPORAL_NAMESPACE;
    delete env.PORT;
    delete env.LOG_LEVEL;
    delete env.AI_MODEL;
    const minimal = apiConfig(env);
    expect(minimal.temporal.namespace).toBe("revenue-recovery");
    expect(minimal.temporal.taskQueue).toBe("recovery-main");
    expect(minimal.app.port).toBe(8000);
    expect(minimal.app.logLevel).toBe("info");
    expect(minimal.ai.model).toBe("gpt-4o");
    expect(minimal.ai.timeoutMs).toBe(20000);
    expect(minimal.ai.maxRetries).toBe(2);
    expect(minimal.bus.driver).toBe("inprocess");
    expect(minimal.demo.mockProviders).toBe(true);
    expect(minimal.demo.simulatePaymentTimeout).toBe(false);
    expect(minimal.database.directUrl).toBe(env.DATABASE_URL);
  });

  it("returns a deeply frozen object", () => {
    const config = apiConfig(baseEnv());
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.app)).toBe(true);
    expect(Object.isFrozen(config.demo)).toBe(true);
  });

  it("throws with a clear message when DATABASE_URL is missing", () => {
    const env = baseEnv();
    delete env.DATABASE_URL;
    expectConfigError(() => apiConfig(env), "DATABASE_URL");
  });

  it("rejects an invalid EVENT_BUS_DRIVER value", () => {
    const env = baseEnv();
    env.EVENT_BUS_DRIVER = "kafka";
    expectConfigError(() => apiConfig(env), "EVENT_BUS_DRIVER");
  });

  it("requires REDPANDA_BROKERS when the redpanda driver is selected", () => {
    const env = baseEnv();
    env.EVENT_BUS_DRIVER = "redpanda";
    expectConfigError(() => apiConfig(env), "REDPANDA_BROKERS");

    env.REDPANDA_BROKERS = "localhost:9092";
    const config = apiConfig(env);
    expect(config.bus).toEqual({ driver: "redpanda", brokers: "localhost:9092" });
  });

  describe("mock mode relaxes provider credentials (spec 03 §2)", () => {
    it("accepts missing provider keys when MOCK_PROVIDERS=true", () => {
      const config = apiConfig(baseEnv());
      expect(config.payments.stripeSecretKey).toBeNull();
      expect(config.messaging.whatsappApiKey).toBeNull();
      expect(config.ai.apiKey).toBeNull();
    });

    it("MOCK_PROVIDERS defaults to true outside production", () => {
      const env = baseEnv();
      delete env.MOCK_PROVIDERS;
      expect(apiConfig(env).demo.mockProviders).toBe(true);
    });

    it("requires provider keys when MOCK_PROVIDERS=false", () => {
      const env = baseEnv();
      env.MOCK_PROVIDERS = "false";
      const error = (() => {
        try {
          apiConfig(env);
          return null;
        } catch (e) {
          return e as ConfigValidationError;
        }
      })();
      expect(error).toBeInstanceOf(ConfigValidationError);
      for (const key of [
        "LLM_API_KEY",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "RAZORPAY_KEY_ID",
        "RAZORPAY_KEY_SECRET",
        "RAZORPAY_WEBHOOK_SECRET",
        "WHATSAPP_API_KEY",
        "WHATSAPP_PHONE_NUMBER_ID",
        "EMAIL_API_KEY",
      ]) {
        expect(error?.message).toContain(key);
      }
    });

    it("defaults to live-provider requirements in production", () => {
      const env = baseEnv();
      env.NODE_ENV = "production";
      delete env.MOCK_PROVIDERS;
      expect(() => apiConfig(env)).toThrow(ConfigValidationError);

      env.MOCK_PROVIDERS = "false";
      env.LLM_API_KEY = "llm-key";
      env.STRIPE_SECRET_KEY = "sk_test_x";
      env.STRIPE_WEBHOOK_SECRET = "whsec_x";
      env.RAZORPAY_KEY_ID = "rzp_test_x";
      env.RAZORPAY_KEY_SECRET = "rzp_secret_x";
      env.RAZORPAY_WEBHOOK_SECRET = "rzp_whsec_x";
      env.WHATSAPP_API_KEY = "wa-key";
      env.WHATSAPP_PHONE_NUMBER_ID = "wa-phone-id";
      env.EMAIL_API_KEY = "email-key";
      const config = apiConfig(env);
      expect(config.demo.mockProviders).toBe(false);
      expect(config.payments.stripeSecretKey).toBe("sk_test_x");
    });
  });

  it("treats empty-string variables as unset", () => {
    const env = baseEnv();
    env.LLM_BASE_URL = "";
    const config = apiConfig(env);
    expect(config.ai.baseUrl).toBeNull();
  });

  describe("http + release groups (s-02 audit fix)", () => {
    it("defaults CORS allowlist to empty, cookieSecure to null, release stamps to dev", () => {
      const config = apiConfig(baseEnv());
      expect(config.http.corsAllowedOrigins).toEqual([]);
      expect(config.http.cookieSecure).toBeNull();
      expect(config.release.version).toBe("dev");
      expect(config.release.gitSha).toBe("dev");
      expect(Object.isFrozen(config.http)).toBe(true);
      expect(Object.isFrozen(config.release)).toBe(true);
    });

    it("parses CORS_ALLOWED_ORIGINS comma-separated with trimming", () => {
      const config = apiConfig({
        ...baseEnv(),
        CORS_ALLOWED_ORIGINS:
          "https://app.example.com, https://admin.example.com ,,",
      });
      expect([...config.http.corsAllowedOrigins]).toEqual([
        "https://app.example.com",
        "https://admin.example.com",
      ]);
    });

    it("honors COOKIE_SECURE + release overrides", () => {
      const config = apiConfig({
        ...baseEnv(),
        COOKIE_SECURE: "true",
        APP_VERSION: "v0.1.0",
        GIT_SHA: "abc123",
      });
      expect(config.http.cookieSecure).toBe(true);
      expect(config.release.version).toBe("v0.1.0");
      expect(config.release.gitSha).toBe("abc123");
    });

    it("defaults request timeouts to 10s global / 25s webhook (s-07)", () => {
      const config = apiConfig(baseEnv());
      expect(config.http.requestTimeoutMs).toBe(10000);
      expect(config.http.webhookTimeoutMs).toBe(25000);
      expect(Object.isFrozen(config.http)).toBe(true);
    });

    it("honors REQUEST_TIMEOUT_MS + WEBHOOK_TIMEOUT_MS overrides", () => {
      const config = apiConfig({
        ...baseEnv(),
        REQUEST_TIMEOUT_MS: "5000",
        WEBHOOK_TIMEOUT_MS: "30000",
      });
      expect(config.http.requestTimeoutMs).toBe(5000);
      expect(config.http.webhookTimeoutMs).toBe(30000);
    });

    it("rejects non-positive timeout values", () => {
      expectConfigError(
        () => apiConfig({ ...baseEnv(), REQUEST_TIMEOUT_MS: "0" }),
        "REQUEST_TIMEOUT_MS",
      );
      expectConfigError(
        () => apiConfig({ ...baseEnv(), WEBHOOK_TIMEOUT_MS: "-1" }),
        "WEBHOOK_TIMEOUT_MS",
      );
    });

    it("defaults allowUnsignedWebhooks to null and honors explicit values", () => {
      expect(apiConfig(baseEnv()).messaging.allowUnsignedWebhooks).toBeNull();
      expect(
        apiConfig({ ...baseEnv(), ALLOW_UNSIGNED_WEBHOOKS: "true" }).messaging
          .allowUnsignedWebhooks,
      ).toBe(true);
      expect(
        apiConfig({ ...baseEnv(), ALLOW_UNSIGNED_WEBHOOKS: "false" }).messaging
          .allowUnsignedWebhooks,
      ).toBe(false);
    });
  });
});

describe("workerConfig", () => {
  it("returns the same validated surface as the API config", () => {
    const worker = workerConfig(baseEnv());
    const api = apiConfig(baseEnv());
    expect(worker).toEqual(api);
    expect(worker.temporal.address).toBe("localhost:7233");
    expect(worker.database.url).toContain("revenue_recovery");
  });
});

describe("webConfig", () => {
  it("exposes only browser-safe values with defaults", () => {
    const config = webConfig({ NODE_ENV: "development" });
    expect(config).toEqual({
      env: "development",
      publicApiUrl: "http://localhost:8000",
    });
  });

  it("reads NEXT_PUBLIC_API_URL when provided", () => {
    const config = webConfig({
      NODE_ENV: "production",
      NEXT_PUBLIC_API_URL: "https://api.example.com",
    });
    expect(config.publicApiUrl).toBe("https://api.example.com");
  });
});
