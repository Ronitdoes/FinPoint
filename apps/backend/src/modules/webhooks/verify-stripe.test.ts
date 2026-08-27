import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  parseStripeSignatureHeader,
  verifyStripeSignature,
} from "./verify-stripe";
import { InvalidSignatureError } from "../../lib/errors";

describe("Stripe Webhook Signature Verification", () => {
  const secret = "whsec_test_secret_stripe_12345";
  const payload = JSON.stringify({
    id: "evt_test_123",
    type: "payment_intent.payment_failed",
    created: Math.floor(Date.now() / 1000),
  });

  function generateStripeHeader(
    body: string,
    sec: string,
    timestamp: number = Math.floor(Date.now() / 1000),
  ): string {
    const signature = createHmac("sha256", sec)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    return `t=${timestamp},v1=${signature}`;
  }

  it("successfully parses valid Stripe-Signature header", () => {
    const header = "t=1620000000,v1=sig1_abc,v1=sig2_def,v0=sig0_ghi";
    const parsed = parseStripeSignatureHeader(header);
    expect(parsed.timestamp).toBe(1620000000);
    expect(parsed.signatures).toEqual(["sig1_abc", "sig2_def"]);
  });

  it("verifies a valid signature within tolerance window", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = generateStripeHeader(payload, secret, now);

    const verified = verifyStripeSignature(payload, header, secret, {
      nowSeconds: now,
      toleranceSeconds: 300,
    });
    expect(verified).toBe(true);
  });

  it("supports multiple v1 signatures for secret rotation", () => {
    const now = Math.floor(Date.now() / 1000);
    const oldSecret = "whsec_old_secret";
    const validSig = createHmac("sha256", secret)
      .update(`${now}.${payload}`)
      .digest("hex");
    const oldSig = createHmac("sha256", oldSecret)
      .update(`${now}.${payload}`)
      .digest("hex");
    const header = `t=${now},v1=${oldSig},v1=${validSig}`;

    const verified = verifyStripeSignature(payload, header, secret, {
      nowSeconds: now,
    });
    expect(verified).toBe(true);
  });

  it("throws InvalidSignatureError when timestamp is older than 5 minutes", () => {
    const now = 1700000000;
    const oldTimestamp = now - 301; // 301 seconds ago
    const header = generateStripeHeader(payload, secret, oldTimestamp);

    expect(() =>
      verifyStripeSignature(payload, header, secret, {
        nowSeconds: now,
        toleranceSeconds: 300,
      }),
    ).toThrow(InvalidSignatureError);
  });

  it("throws InvalidSignatureError when payload is tampered", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = generateStripeHeader(payload, secret, now);
    const tamperedPayload = payload + " ";

    expect(() =>
      verifyStripeSignature(tamperedPayload, header, secret, {
        nowSeconds: now,
      }),
    ).toThrow(InvalidSignatureError);
  });

  it("throws InvalidSignatureError when secret is wrong", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = generateStripeHeader(payload, "wrong_secret", now);

    expect(() =>
      verifyStripeSignature(payload, header, secret, {
        nowSeconds: now,
      }),
    ).toThrow(InvalidSignatureError);
  });

  it("throws InvalidSignatureError when header or secret is missing", () => {
    expect(() => verifyStripeSignature(payload, undefined, secret)).toThrow(
      InvalidSignatureError,
    );
    expect(() =>
      verifyStripeSignature(payload, "t=123,v1=abc", undefined),
    ).toThrow(InvalidSignatureError);
  });
});
