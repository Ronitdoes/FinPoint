import { CASE_STATUSES } from "../enums/case-status";
import type { CaseStatus as CaseStatusName } from "../enums/case-status";

const TERMINAL_CASE_STATUS_VALUES = ["RECOVERED", "STOPPED", "FAILED"] as const;

export const TERMINAL_STATUSES: readonly TerminalCaseStatusValues[] =
  Object.freeze(TERMINAL_CASE_STATUS_VALUES);

type TerminalCaseStatusValues = (typeof TERMINAL_CASE_STATUS_VALUES)[number];

export type TerminalCaseStatus = TerminalCaseStatusValues;

export type NonTerminalCaseStatus = Exclude<CaseStatusName, TerminalCaseStatus>;

const TRANSITION_TARGETS = {
  DETECTED: ["QUALIFIED", "STOPPED"],
  QUALIFIED: ["DECISION_PENDING", "STOPPED"],
  DECISION_PENDING: ["POLICY_REVIEW", "FAILED"],
  POLICY_REVIEW: ["IN_PROGRESS", "ESCALATED", "STOPPED"],
  IN_PROGRESS: ["WAITING", "RECOVERED", "STOPPED", "ESCALATED", "FAILED"],
  WAITING: ["IN_PROGRESS", "RECOVERED", "STOPPED", "ESCALATED"],
  ESCALATED: ["IN_PROGRESS", "RECOVERED", "STOPPED"],
} as const satisfies Record<
  NonTerminalCaseStatus,
  readonly CaseStatusName[]
>;

export const CASE_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(TRANSITION_TARGETS).map(([from, targets]) => [
      from,
      Object.freeze([...targets]),
    ]),
  ),
) as Readonly<Record<NonTerminalCaseStatus, readonly CaseStatusName[]>>;

export function isTerminal(status: CaseStatusName): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isNonTerminal(
  status: CaseStatusName,
): status is NonTerminalCaseStatus {
  return !isTerminal(status);
}

export const NON_TERMINAL_STATUSES: readonly NonTerminalCaseStatus[] =
  Object.freeze(CASE_STATUSES.filter(isNonTerminal));

export function canTransition(
  from: CaseStatusName,
  to: CaseStatusName,
): boolean {
  if (!isNonTerminal(from)) {
    return false;
  }
  return CASE_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION";

  constructor(
    readonly from: CaseStatusName,
    readonly to: CaseStatusName,
  ) {
    super(`Illegal recovery-case transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(
  from: CaseStatusName,
  to: CaseStatusName,
): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}
