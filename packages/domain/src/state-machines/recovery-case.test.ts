import { describe, expect, it } from "vitest";

import {
  CASE_STATUSES,
  CaseStatus,
} from "../enums/case-status";
import {
  CASE_TRANSITIONS,
  IllegalTransitionError,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
} from "./recovery-case";

const SPEC_TRANSITION_TABLE: Record<string, readonly string[]> = {
  DETECTED: ["QUALIFIED", "STOPPED"],
  QUALIFIED: ["DECISION_PENDING", "STOPPED"],
  DECISION_PENDING: ["POLICY_REVIEW", "FAILED"],
  POLICY_REVIEW: ["IN_PROGRESS", "ESCALATED", "STOPPED"],
  IN_PROGRESS: ["WAITING", "RECOVERED", "STOPPED", "ESCALATED", "FAILED"],
  WAITING: ["IN_PROGRESS", "RECOVERED", "STOPPED", "ESCALATED"],
  ESCALATED: ["IN_PROGRESS", "RECOVERED", "STOPPED"],
};

describe("transition table", () => {
  it("matches the spec 02 §4 table exactly (no drift in either direction)", () => {
    const table = CASE_TRANSITIONS as Record<string, readonly string[]>;
    const actual = Object.fromEntries(
      Object.entries(table).map(([from, targets]) => [from, [...targets]]),
    );
    expect(actual).toEqual(SPEC_TRANSITION_TABLE);
    expect(Object.keys(table).sort()).toEqual(
      Object.keys(SPEC_TRANSITION_TABLE).sort(),
    );
  });

  it("leaves terminal statuses with no outgoing edges", () => {
    const table = CASE_TRANSITIONS as Record<string, readonly string[] | undefined>;
    for (const status of TERMINAL_STATUSES) {
      expect(table[status]).toBeUndefined();
      expect(isTerminal(status)).toBe(true);
    }
  });
});

describe("exhaustive transition matrix", () => {
  const legalPairs = new Set(
    Object.entries(SPEC_TRANSITION_TABLE).flatMap(([from, targets]) =>
      targets.map((to) => `${from}->${to}`),
    ),
  );

  const allStatuses = CASE_STATUSES;
  const allPairs = allStatuses.flatMap((from) =>
    allStatuses.map((to) => [from, to] as const),
  );

  it.each(allPairs)("%s -> %s matches the table", (from, to) => {
    const legal = legalPairs.has(`${from}->${to}`);
    expect(canTransition(from, to)).toBe(legal);

    if (legal) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      try {
        assertTransition(from, to);
        expect.fail(`expected ${from} -> ${to} to be illegal`);
      } catch (error) {
        if (error instanceof Error && error.message.includes("expected")) throw error;
        expect(error).toBeInstanceOf(IllegalTransitionError);
        const illegal = error as IllegalTransitionError;
        expect(illegal.code).toBe("ILLEGAL_TRANSITION");
        expect(illegal.from).toBe(from);
        expect(illegal.to).toBe(to);
      }
    }
  });

  it("treats every self-transition as illegal", () => {
    for (const status of allStatuses) {
      expect(canTransition(status as CaseStatus, status)).toBe(false);
      expect(() => assertTransition(status, status)).toThrow(IllegalTransitionError);
    }
  });

  it("gives every non-terminal status at least one outgoing transition", () => {
    const nonTerminal = allStatuses.filter((s) => !isTerminal(s));
    expect(nonTerminal.length).toBeGreaterThan(0);
    const table = CASE_TRANSITIONS as Record<string, readonly string[]>;
    for (const from of nonTerminal) {
      expect((table[from] ?? []).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps recoverable paths reachable without illegal jumps", () => {
    const happyPath: CaseStatus[] = [
      CaseStatus.DETECTED,
      CaseStatus.QUALIFIED,
      CaseStatus.DECISION_PENDING,
      CaseStatus.POLICY_REVIEW,
      CaseStatus.IN_PROGRESS,
      CaseStatus.RECOVERED,
    ];
    for (let i = 0; i < happyPath.length - 1; i += 1) {
      expect(() =>
        assertTransition(happyPath[i] as CaseStatus, happyPath[i + 1] as CaseStatus),
      ).not.toThrow();
    }
    expect(isTerminal(CaseStatus.RECOVERED)).toBe(true);
  });
});
