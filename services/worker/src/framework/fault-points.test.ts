import { describe, it, expect, afterEach } from "vitest";
import {
  armFaultPoint,
  checkFaultPoint,
  clearFaultHooks,
  clearFaultPoints,
  FaultInjectedError,
  isFaultPointArmed,
  listArmedFaultPoints,
  parseFaultPoints,
  registerFaultHook,
} from "./fault-points";

describe("fault-point harness", () => {
  afterEach(() => {
    clearFaultPoints();
    clearFaultHooks();
    delete process.env.FAULT_POINTS;
    delete process.env.CHAOS_ENABLED;
  });

  it("parses FAULT_POINTS env entries and ignores unknown phases", () => {
    const armed = parseFaultPoints("claim:after_claim, executeRetryPayment:before_provider_call, bogus:oops, *");
    expect(armed).toHaveLength(2);
    expect(armed[0]).toMatchObject({ activity: "claim", phase: "after_claim" });
    expect(armed[1]).toMatchObject({
      activity: "executeRetryPayment",
      phase: "before_provider_call",
    });
    expect(parseFaultPoints(undefined)).toEqual([]);
    expect(parseFaultPoints("")).toEqual([]);
  });

  it("env-armed points throw FaultInjectedError with crash semantics", async () => {
    process.env.FAULT_POINTS = "claim:after_claim";
    expect(isFaultPointArmed("claim", "after_claim")).toBe(true);
    expect(isFaultPointArmed("claim", "before_provider_call")).toBe(false);
    await expect(checkFaultPoint("claim", "after_claim")).rejects.toBeInstanceOf(
      FaultInjectedError,
    );
    await expect(checkFaultPoint("claim", "after_claim")).rejects.toMatchObject({
      code: "FAULT_INJECTED",
      crash: true,
    });
    // Disarmed points resolve silently.
    await expect(
      checkFaultPoint("claim", "before_provider_call"),
    ).resolves.toBeUndefined();
  });

  it("programmatic arms support transient and delay behaviors", async () => {
    armFaultPoint("pay", "before_provider_call", { kind: "throw-transient" });
    await expect(checkFaultPoint("pay", "before_provider_call")).rejects.toMatchObject({
      crash: false,
    });

    armFaultPoint("pay", "before_provider_call", { kind: "delay", delayMs: 20 });
    const started = Date.now();
    await expect(
      checkFaultPoint("pay", "before_provider_call"),
    ).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);

    expect(listArmedFaultPoints()).toHaveLength(1);
    clearFaultPoints("pay", "before_provider_call");
    expect(isFaultPointArmed("pay", "before_provider_call")).toBe(false);
  });

  it("wildcard activity arms every activity for a phase", async () => {
    armFaultPoint("*", "pre");
    expect(isFaultPointArmed("anything", "pre")).toBe(true);
  });

  it("registered pre/post hooks run through the choke point", async () => {
    const seen: string[] = [];
    const unregister = registerFaultHook("myActivity", "pre", (ctx) => {
      seen.push(`${ctx.activity}:${ctx.phase}`);
    });
    await checkFaultPoint("myActivity", "pre", { tenantId: "t" });
    expect(seen).toEqual(["myActivity:pre"]);
    unregister();
    await checkFaultPoint("myActivity", "pre");
    expect(seen).toHaveLength(1);
  });

  it("harness is a no-op in production unless CHAOS_ENABLED", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      armFaultPoint("claim", "after_claim");
      await expect(
        checkFaultPoint("claim", "after_claim"),
      ).resolves.toBeUndefined();
      process.env.CHAOS_ENABLED = "true";
      await expect(checkFaultPoint("claim", "after_claim")).rejects.toBeInstanceOf(
        FaultInjectedError,
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
