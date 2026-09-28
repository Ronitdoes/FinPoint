import { describe, expect, it } from "vitest";
import { isRetryableProviderError } from "../modules/payments/execution.service";

/**
 * s-18 audit: the adapter retry loop must retry ONLY network/timeout/5xx
 * errors — programming errors (TypeError, validation bugs) and definitive
 * outcomes must surface immediately instead of burning retries.
 */
describe("isRetryableProviderError (s-18 narrow retry classifier)", () => {
  it("retries timeouts and aborts", () => {
    expect(
      isRetryableProviderError(new Error("Provider call timeout exceeded")),
    ).toBe(true);
    expect(isRetryableProviderError(new Error("Request timed out"))).toBe(
      true,
    );
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isRetryableProviderError(abort)).toBe(true);
    expect(
      isRetryableProviderError({ code: "ETIMEDOUT", message: "socket idle" }),
    ).toBe(true);
  });

  it("retries transport-level network failures", () => {
    expect(isRetryableProviderError(new TypeError("fetch failed"))).toBe(true);
    expect(
      isRetryableProviderError({
        code: "ECONNREFUSED",
        message: "connect ECONNREFUSED 127.0.0.1:443",
      }),
    ).toBe(true);
    expect(
      isRetryableProviderError({ code: "ENOTFOUND", message: "getaddrinfo" }),
    ).toBe(true);
    expect(
      isRetryableProviderError(new Error("socket hang up (ECONNRESET)")),
    ).toBe(true);
  });

  it("retries provider 5xx surfaced as thrown errors", () => {
    expect(
      isRetryableProviderError(
        new Error("Stripe API returned 5xx status: 502"),
      ),
    ).toBe(true);
    expect(
      isRetryableProviderError(
        new Error("Razorpay API returned 5xx status: 503"),
      ),
    ).toBe(true);
    expect(
      isRetryableProviderError({ status: 503, message: "unavailable" }),
    ).toBe(true);
    expect(
      isRetryableProviderError({ statusCode: 500, message: "boom" }),
    ).toBe(true);
  });

  it("honors explicit transient markers", () => {
    expect(
      isRetryableProviderError({ message: "slow", retryable: true }),
    ).toBe(true);
    expect(
      isRetryableProviderError({ message: "slow", transient: true }),
    ).toBe(true);
  });

  it("does NOT retry programming errors", () => {
    expect(
      isRetryableProviderError(
        new TypeError("Cannot read properties of undefined (reading 'id')"),
      ),
    ).toBe(false);
    expect(isRetryableProviderError(new RangeError("oops"))).toBe(false);
    expect(
      isRetryableProviderError(new SyntaxError("Unexpected token < in JSON")),
    ).toBe(false);
    expect(
      isRetryableProviderError(new Error("validation failed: amount < 0")),
    ).toBe(false);
  });

  it("does NOT retry definitive 4xx-style outcomes", () => {
    expect(
      isRetryableProviderError(new Error("Stripe error HTTP 402")),
    ).toBe(false);
    expect(
      isRetryableProviderError({ status: 400, message: "bad request" }),
    ).toBe(false);
    expect(
      isRetryableProviderError({ statusCode: 404, message: "not found" }),
    ).toBe(false);
  });

  it("handles nullish and primitive inputs safely", () => {
    expect(isRetryableProviderError(null)).toBe(false);
    expect(isRetryableProviderError(undefined)).toBe(false);
    expect(isRetryableProviderError(42)).toBe(false);
    expect(isRetryableProviderError("plain string")).toBe(false);
    expect(isRetryableProviderError("fetch failed: boom")).toBe(true);
  });
});
