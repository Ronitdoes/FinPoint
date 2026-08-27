import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { createLoggerConfig, getLogger, REDACT_PATHS } from "./logger";

describe("Observability Logger & Redaction", () => {
  it("redacts configured secret keys and header values", () => {
    let capturedLog = "";
    const testStream = new Writable({
      write(chunk, _encoding, callback) {
        capturedLog += chunk.toString();
        callback();
      },
    });

    const config = createLoggerConfig({ pretty: false });
    const logger = pino(config, testStream);

    logger.info({
      tenant_id: "tenant_1",
      password: "supersecretpassword",
      apiKey: "sk_live_1234567890",
      stripeSecretKey: "sk_live_stripe_secret",
      token: "jwt.secret.token",
      nested: {
        secret: "deep_secret_value",
      },
      safeField: "safe_public_value",
    });

    const parsed = JSON.parse(capturedLog);
    expect(parsed.tenant_id).toBe("tenant_1");
    expect(parsed.safeField).toBe("safe_public_value");
    expect(parsed.password).toBe("[REDACTED]");
    expect(parsed.apiKey).toBe("[REDACTED]");
    expect(parsed.stripeSecretKey).toBe("[REDACTED]");
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.nested.secret).toBe("[REDACTED]");
  });

  it("binds domain context fields via getLogger", () => {
    const logger = getLogger({
      tenant_id: "tenant_abc",
      case_id: "case_xyz",
      correlationId: "corr-111-222",
    });

    expect(logger.bindings()).toMatchObject({
      tenant_id: "tenant_abc",
      case_id: "case_xyz",
      correlationId: "corr-111-222",
    });
  });
});
