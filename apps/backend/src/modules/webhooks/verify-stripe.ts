import { createHmac, timingSafeEqual } from "node:crypto";
import { InvalidSignatureError } from "../../lib/errors";

export interface VerifyStripeOptions {
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/**
 * Parses the Stripe-Signature header into timestamp and v1 signatures.
 * Format: "t=1620000000,v1=abc123...,v1=def456..."
 */
export function parseStripeSignatureHeader(header: string): {
  timestamp: number;
  signatures: string[];
} {
  const parts = header.split(",").map((p) => p.trim());
  let timestamp = -1;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (!key || !value) continue;

    if (key === "t") {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        timestamp = parsed;
      }
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

/**
 * Verifies the Stripe webhook signature against raw request body bytes.
 * Constant-time HMAC-SHA256 check with ±5m tolerance window (Spec 02 §14).
 */
export function verifyStripeSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string | undefined | null,
  options: VerifyStripeOptions = {},
): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    throw new InvalidSignatureError("Missing Stripe-Signature header");
  }

  if (!secret || typeof secret !== "string") {
    throw new InvalidSignatureError("Stripe webhook secret is not configured");
  }

  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);

  if (timestamp === -1 || signatures.length === 0) {
    throw new InvalidSignatureError("Malformed Stripe-Signature header");
  }

  const tolerance = options.toleranceSeconds ?? 300; // 5 minutes
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (Math.abs(now - timestamp) > tolerance) {
    throw new InvalidSignatureError(
      `Stripe webhook timestamp ${timestamp} is outside tolerance window (current: ${now}, tolerance: ${tolerance}s)`,
    );
  }

  const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const payloadToSign = `${timestamp}.${bodyStr}`;

  const expectedSignatureHex = createHmac("sha256", secret)
    .update(payloadToSign, "utf8")
    .digest("hex");

  const expectedBuffer = Buffer.from(expectedSignatureHex, "utf8");

  // Constant-time check across all provided v1 signatures (supports secret rotation)
  for (const sig of signatures) {
    const sigBuffer = Buffer.from(sig, "utf8");
    if (
      sigBuffer.length === expectedBuffer.length &&
      timingSafeEqual(expectedBuffer, sigBuffer)
    ) {
      return true;
    }
  }

  throw new InvalidSignatureError("Stripe webhook signature mismatch");
}
