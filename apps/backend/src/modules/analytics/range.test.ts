import { describe, it, expect } from "vitest";
import { parseAndValidateDateRange } from "./routes";

/**
 * CODE HYGIENE: single-sided 370d cap against now().
 * `?from=X` alone covers [X, now]; old X must 400. `?to=Y` alone is unbounded
 * backwards; old Y must 400. Recent single-sided bounds stay 200.
 */
describe("parseAndValidateDateRange single-sided cap", () => {
  it("rejects ?from=X alone when older than 370d (unbounded -> capped)", () => {
    const oldFrom = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => parseAndValidateDateRange({ from: oldFrom })).toThrow(
      /exceeds maximum allowed window/,
    );
    try {
      parseAndValidateDateRange({ from: oldFrom });
    } catch (err: any) {
      expect(err?.statusCode).toBe(400);
      expect(err?.code).toBe("BAD_REQUEST");
    }
  });

  it("rejects ?to=Y alone when older than 370d", () => {
    const oldTo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => parseAndValidateDateRange({ to: oldTo })).toThrow(
      /exceeds maximum allowed window/,
    );
  });

  it("allows recent single-sided bounds within 370d", () => {
    const recentFrom = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => parseAndValidateDateRange({ from: recentFrom })).not.toThrow();
    const recentTo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => parseAndValidateDateRange({ to: recentTo })).not.toThrow();
  });

  it("allows missing both bounds (dashboard default)", () => {
    expect(parseAndValidateDateRange({})).toEqual({
      from: undefined,
      to: undefined,
    });
  });
});
