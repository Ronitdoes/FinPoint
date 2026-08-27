import { describe, it, expect } from "vitest";
import {
  canTransitionRisk,
  assertRiskTransition,
  isRiskTerminal,
  isRiskNonTerminal,
  IllegalRiskTransitionError,
  TERMINAL_RISK_STATUSES,
  NON_TERMINAL_RISK_STATUSES,
  RISK_TRANSITIONS,
} from "./revenue-risk";
import { RISK_STATUSES } from "../enums/risk-status";

describe("RevenueRisk State Machine (Step 12)", () => {
  it("partitions statuses into terminal and non-terminal correctly", () => {
    expect(NON_TERMINAL_RISK_STATUSES).toEqual(["OPEN"]);
    expect(TERMINAL_RISK_STATUSES).toEqual(["ASSESSED", "EXPIRED"]);
    expect([...NON_TERMINAL_RISK_STATUSES, ...TERMINAL_RISK_STATUSES]).toEqual(
      expect.arrayContaining([...RISK_STATUSES]),
    );
  });

  it("isRiskTerminal returns true only for terminal states", () => {
    expect(isRiskTerminal("OPEN")).toBe(false);
    expect(isRiskTerminal("ASSESSED")).toBe(true);
    expect(isRiskTerminal("EXPIRED")).toBe(true);
  });

  it("isRiskNonTerminal returns true only for non-terminal states", () => {
    expect(isRiskNonTerminal("OPEN")).toBe(true);
    expect(isRiskNonTerminal("ASSESSED")).toBe(false);
    expect(isRiskNonTerminal("EXPIRED")).toBe(false);
  });

  it("permits allowed transitions from OPEN", () => {
    expect(canTransitionRisk("OPEN", "OPEN")).toBe(true); // recomputation
    expect(canTransitionRisk("OPEN", "ASSESSED")).toBe(true); // orchestrator attaches case
    expect(canTransitionRisk("OPEN", "EXPIRED")).toBe(true); // resolved upstream
  });

  it("assertRiskTransition does not throw for allowed transitions", () => {
    expect(() => assertRiskTransition("OPEN", "OPEN")).not.toThrow();
    expect(() => assertRiskTransition("OPEN", "ASSESSED")).not.toThrow();
    expect(() => assertRiskTransition("OPEN", "EXPIRED")).not.toThrow();
  });

  it("forbids transitions from terminal states", () => {
    expect(canTransitionRisk("ASSESSED", "OPEN")).toBe(false);
    expect(canTransitionRisk("ASSESSED", "EXPIRED")).toBe(false);
    expect(canTransitionRisk("EXPIRED", "OPEN")).toBe(false);
    expect(canTransitionRisk("EXPIRED", "ASSESSED")).toBe(false);
  });

  it("assertRiskTransition throws IllegalRiskTransitionError for disallowed transitions", () => {
    expect(() => assertRiskTransition("ASSESSED", "OPEN")).toThrow(
      IllegalRiskTransitionError,
    );
    expect(() => assertRiskTransition("EXPIRED", "OPEN")).toThrow(
      IllegalRiskTransitionError,
    );
  });
});
