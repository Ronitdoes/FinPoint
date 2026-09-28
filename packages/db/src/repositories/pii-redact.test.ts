import { describe, expect, it } from "vitest";
import { sanitizePii } from "./pii-redact";

/**
 * DB-free unit tests for the write-path PII sanitizer (s-25 MED fix).
 * The stored-row integration assertion lives in
 * apps/backend/src/tests/audit-timeline-integration.test.ts
 * ("masks PII/secrets at write time"); these units pin the recursive
 * redaction semantics of every email/phone/secret/token/card pattern here so
 * they are verifiable without a database.
 */
describe("sanitizePii (audit write-path redaction)", () => {
  it("masks keyed email/phone/card/secret/token values", () => {
    const out = sanitizePii({
      customerEmail: "john.doe@company.com",
      customerPhone: "+919876543210",
      creditCard: "4111222233334444",
      apiKey: "sk_live_99998888777766665555",
      password: "hunter2-plain",
      retryCount: 3,
    });

    expect(out.customerEmail).toContain("*");
    expect(out.customerEmail).not.toContain("john.doe@company.com");
    expect(out.customerPhone).toContain("*");
    expect(out.customerPhone).not.toContain("+919876543210");
    expect(out.creditCard).toContain("****");
    expect(out.creditCard).not.toContain("4111222233334444");
    expect(out.apiKey).toBe("[REDACTED_SECRET]");
    expect(out.password).toBe("[REDACTED]");
    // token+count exclusion is preserved (a counter, not a credential).
    expect(out.retryCount).toBe(3);
  });

  it("redacts PII recursively in nested objects and arrays, including generic keys", () => {
    const out = sanitizePii({
      nested: {
        contactEmail: "nested@domain.org",
        // Phone under a generic (non-phone-named) key must still be masked.
        callback: "+919876543210",
        deep: { pan: "4111222233334444" },
      },
      list: ["alice@example.com", "plain note"],
      safeNote: "Payment failed due to NSF",
    });

    expect(JSON.stringify(out)).not.toContain("nested@domain.org");
    expect(JSON.stringify(out)).not.toContain("+919876543210");
    expect(JSON.stringify(out)).not.toContain("4111222233334444");
    expect(JSON.stringify(out)).not.toContain("alice@example.com");
    expect(out.list[1]).toBe("plain note");
    expect(out.safeNote).toBe("Payment failed due to NSF");
  });

  it("leaves already-masked values and non-PII data untouched", () => {
    const out = sanitizePii({
      maskedEmail: "j***e@company.com",
      last4: "4444",
      amount: 149900,
      count: 12,
      nothing: null,
    });

    expect(out.maskedEmail).toBe("j***e@company.com");
    expect(out.last4).toBe("4444");
    expect(out.amount).toBe(149900);
    expect(out.count).toBe(12);
    expect(out.nothing).toBeNull();
  });
});
