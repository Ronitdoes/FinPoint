import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyRazorpaySignature } from "./verify-razorpay";
import { InvalidSignatureError } from "../../lib/errors";

describe("Razorpay Webhook Signature Verification", () => {
  const secret = "rzp_sec_test_razorpay_67890";
  const payload = JSON.stringify({
    event: "payment.failed",
    created_at: 1620000000,
    payload: {
      payment: {
        entity: {
          id: "pay_test_123",
          amount: 50000,
          currency: "INR",
        },
      },
    },
  });

  function generateRazorpayHeader(body: string, sec: string): string {
    return createHmac("sha256", sec).update(body).digest("hex");
  }

  it("verifies a valid signature against exact raw body bytes", () => {
    const signature = generateRazorpayHeader(payload, secret);
    const verified = verifyRazorpaySignature(payload, signature, secret);
    expect(verified).toBe(true);
  });

  it("throws InvalidSignatureError when payload is modified", () => {
    const signature = generateRazorpayHeader(payload, secret);
    const modifiedPayload = payload.replace("INR", "USD");

    expect(() =>
      verifyRazorpaySignature(modifiedPayload, signature, secret),
    ).toThrow(InvalidSignatureError);
  });

  it("throws InvalidSignatureError when secret is wrong", () => {
    const signature = generateRazorpayHeader(payload, "wrong_secret");

    expect(() => verifyRazorpaySignature(payload, signature, secret)).toThrow(
      InvalidSignatureError,
    );
  });

  it("throws InvalidSignatureError when header or secret is missing", () => {
    expect(() => verifyRazorpaySignature(payload, undefined, secret)).toThrow(
      InvalidSignatureError,
    );
    expect(() => verifyRazorpaySignature(payload, "sig_123", undefined)).toThrow(
      InvalidSignatureError,
    );
  });
});
