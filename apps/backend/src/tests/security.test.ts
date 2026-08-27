import { describe, it, expect } from "vitest";
import pino from "pino";
import { createLoggerConfig } from "../plugins/logger";

describe("Security & Redaction Unit Tests (Step 09)", () => {
  it("redacts sensitive fields like passwords, secrets, authorization headers, and cookies", async () => {
    let logOutput = "";

    const destination = {
      write(msg: string) {
        logOutput += msg;
      },
    };

    const config = createLoggerConfig("info");
    const logger = pino(config, destination);

    const sensitiveObject = {
      email: "operator@example.com",
      password: "SuperSecretPassword123!",
      apiKey: "rrk_live_super_secret_key_12345",
      secret: "shhh-dont-log-this",
      user: {
        id: "12345",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$...",
      },
    };

    logger.info(sensitiveObject, "User logged in");

    expect(logOutput).toContain("operator@example.com");
    // Secrets must NOT be present in log output
    expect(logOutput).not.toContain("SuperSecretPassword123!");
    expect(logOutput).not.toContain("rrk_live_super_secret_key_12345");
    expect(logOutput).not.toContain("shhh-dont-log-this");
    expect(logOutput).toContain("[REDACTED]");
  });

  it("redacts sensitive headers in HTTP request serializer", () => {
    const config = createLoggerConfig("info");
    const reqSerializer = config.serializers?.req;

    expect(reqSerializer).toBeDefined();

    const mockReq = {
      method: "POST",
      url: "/auth/login",
      headers: {
        authorization: "Bearer rrk_12345_secret",
        cookie: "rr_session=sensitive_session_token_12345",
        "stripe-signature": "t=123,v1=signature_secret",
        "content-type": "application/json",
      },
      params: {},
    };

    const serialized = reqSerializer!(mockReq as any);

    expect(serialized.headers["authorization"]).toBe("[REDACTED]");
    expect(serialized.headers["cookie"]).toBe("[REDACTED]");
    expect(serialized.headers["stripe-signature"]).toBe("[REDACTED]");
    expect(serialized.headers["content-type"]).toBe("application/json");
  });
});
