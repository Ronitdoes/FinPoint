import { createHmac, timingSafeEqual } from "node:crypto";
import { InvalidSignatureError } from "../../lib/errors";

/**
 * Verifies the Razorpay webhook signature against raw request body bytes.
 * Constant-time HMAC-SHA256 comparison (Spec 02 §14).
 */
export function verifyRazorpaySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string | undefined | null,
): boolean {
  if (!signatureHeader || typeof signatureHeader !== "string") {
    throw new InvalidSignatureError("Missing x-razorpay-signature header");
  }

  if (!secret || typeof secret !== "string") {
    throw new InvalidSignatureError("Razorpay webhook secret is not configured");
  }

  const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

  const expectedSignatureHex = createHmac("sha256", secret)
    .update(bodyStr, "utf8")
    .digest("hex");

  const expectedBuffer = Buffer.from(expectedSignatureHex, "utf8");
  const receivedBuffer = Buffer.from(signatureHeader.trim(), "utf8");

  if (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return true;
  }

  throw new InvalidSignatureError("Razorpay webhook signature mismatch");
}
