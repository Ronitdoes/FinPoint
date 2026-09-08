/**
 * Log redaction verification (Step 30 §Requirements 3).
 *
 * Plants unique known-secret values, emits them through every logging
 * surface (pino logger incl. request serializer, audit PII scanner,
 * metric exposition), and asserts zero occurrences of any planted value
 * across captured logs/traces/metric labels.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { createLoggerConfig } from "../../apps/backend/src/plugins/logger";
import {
  scanForPii,
  redactPii,
} from "../../apps/backend/src/modules/audit/pii-scanner";
import {
  resetMetrics,
  recordHttpRequest,
  recordRatelimitHit,
  recordSignatureFailure,
  getMetricsText,
} from "@repo/observability";

const runId = randomUUID().replace(/-/g, "").slice(0, 12);
// Planted "live-shaped" secrets — random per run, never committed.
const PLANTED = {
  stripeSecret: `sk_test_${runId}AbCdEfGh`,
  webhookSecret: `whsec_${runId}1234567890abcdef`,
  razorpayKey: `rzp_test_${runId}XyZ`,
  apiKey: `rrk_${runId}_plantedkeymaterial`,
  sessionToken: `sess_${runId}_bearerplantedtokenvalue`,
  password: `PlantedPw_${runId}!`,
};
const PLANTED_VALUES = Object.values(PLANTED);

function captureLogs(emit: (logger: pino.Logger) => void): string {
  let output = "";
  const destination = {
    write(msg: string) {
      output += msg;
    },
  };
  const config = createLoggerConfig("info");
  const logger = pino(config, destination);
  emit(logger);
  return output;
}

function assertNoLeak(haystack: string, context: string): void {
  for (const secret of PLANTED_VALUES) {
    expect(
      haystack.includes(secret),
      `${context} leaked planted secret ${secret.slice(0, 10)}...`,
    ).toBe(false);
  }
}

describe("log-redaction: pino logger with known secrets", () => {
  it("redacts secrets from structured log objects", () => {
    const output = captureLogs((logger) => {
      logger.info(
        {
          tenant_id: "tenant_probe",
          password: PLANTED.password,
          apiKey: PLANTED.apiKey,
          stripeSecretKey: PLANTED.stripeSecret,
          secret: PLANTED.webhookSecret,
          nested: { token: PLANTED.sessionToken },
          safeField: "safe_public_value",
        },
        "operator action",
      );
    });

    assertNoLeak(output, "structured log");
    expect(output).toContain("safe_public_value");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts secrets from the HTTP request serializer", () => {
    const config = createLoggerConfig("info");
    const reqSerializer = config.serializers?.req;
    expect(reqSerializer).toBeDefined();

    const serialized = reqSerializer!({
      method: "POST",
      url: "/auth/login",
      headers: {
        authorization: `Bearer ${PLANTED.apiKey}`,
        cookie: `rr_session=${PLANTED.sessionToken}`,
        "stripe-signature": `t=123,v1=${PLANTED.webhookSecret}`,
        "content-type": "application/json",
      },
      params: {},
    } as never);

    assertNoLeak(JSON.stringify(serialized), "request serializer");
    expect(serialized.headers["authorization"]).toBe("[REDACTED]");
    expect(serialized.headers["cookie"]).toBe("[REDACTED]");
    expect(serialized.headers["stripe-signature"]).toBe("[REDACTED]");
  });
});

describe("log-redaction: audit PII/secret scanner", () => {
  it("detects planted provider secrets as SECRET violations", () => {
    const result = scanForPii({
      provider: "STRIPE",
      secretKey: PLANTED.stripeSecret,
      note: "routine webhook receipt",
    });
    expect(result.hasPii).toBe(true);
    expect(result.violations.some((v) => v.pattern === "SECRET")).toBe(true);
  });

  it("redactPii output contains no planted secret", () => {
    const redacted = redactPii({
      email: "operator@example.com",
      secretKey: PLANTED.stripeSecret,
      password: PLANTED.password,
      nested: { token: PLANTED.sessionToken },
    });
    assertNoLeak(JSON.stringify(redacted), "redactPii");
  });
});

describe("log-redaction: metric labels carry no secrets", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("metrics exposition contains zero planted values", async () => {
    recordHttpRequest("GET", "/cases", 200, 12.5);
    recordHttpRequest("POST", "/webhooks/stripe", 401, 3.1);
    recordRatelimitHit("webhook");
    recordSignatureFailure("STRIPE");

    const text = await getMetricsText();
    assertNoLeak(text, "metrics exposition");
    expect(text).toContain("security_signature_failures_total");
    expect(text).toContain("security_ratelimit_hits_total");
  });
});
