import { describe, it, expect } from "vitest";
import {
  canTransitionPtp,
  assertPtpTransition,
  isTerminalPtpStatus,
  isNonTerminalPtpStatus,
  IllegalPtpTransitionError,
  TERMINAL_PTP_STATUSES,
  NON_TERMINAL_PTP_STATUSES,
  PTP_TRANSITIONS,
} from "./promise-to-pay";
import { PROMISE_TO_PAY_STATUSES, type PromiseToPayStatus } from "../enums/promise-to-pay-status";

describe("Promise to Pay State Machine", () => {
  it("defines terminal and non-terminal statuses correctly", () => {
    expect(TERMINAL_PTP_STATUSES).toEqual(["HONORED", "BROKEN", "EXPIRED"]);
    expect(NON_TERMINAL_PTP_STATUSES).toEqual(["MADE"]);
    expect(isTerminalPtpStatus("HONORED")).toBe(true);
    expect(isTerminalPtpStatus("BROKEN")).toBe(true);
    expect(isTerminalPtpStatus("EXPIRED")).toBe(true);
    expect(isTerminalPtpStatus("MADE")).toBe(false);
    expect(isNonTerminalPtpStatus("MADE")).toBe(true);
    expect(isNonTerminalPtpStatus("HONORED")).toBe(false);
  });

  it("allows valid transitions from MADE", () => {
    expect(canTransitionPtp("MADE", "HONORED")).toBe(true);
    expect(canTransitionPtp("MADE", "BROKEN")).toBe(true);
    expect(canTransitionPtp("MADE", "EXPIRED")).toBe(true);
    expect(() => assertPtpTransition("MADE", "HONORED")).not.toThrow();
    expect(() => assertPtpTransition("MADE", "BROKEN")).not.toThrow();
    expect(() => assertPtpTransition("MADE", "EXPIRED")).not.toThrow();
  });

  it("rejects illegal transitions from terminal states", () => {
    const terminals: PromiseToPayStatus[] = ["HONORED", "BROKEN", "EXPIRED"];
    for (const from of terminals) {
      for (const to of PROMISE_TO_PAY_STATUSES) {
        expect(canTransitionPtp(from, to)).toBe(false);
        expect(() => assertPtpTransition(from, to)).toThrow(IllegalPtpTransitionError);
      }
    }
  });

  it("rejects transition from MADE to MADE", () => {
    expect(canTransitionPtp("MADE", "MADE")).toBe(false);
    expect(() => assertPtpTransition("MADE", "MADE")).toThrow(IllegalPtpTransitionError);
  });
});
