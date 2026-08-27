import { RISK_STATUSES } from "../enums/risk-status";
import type { RiskStatus as RiskStatusName } from "../enums/risk-status";

const TERMINAL_RISK_STATUS_VALUES = ["ASSESSED", "EXPIRED"] as const;

export const TERMINAL_RISK_STATUSES: readonly TerminalRiskStatusValues[] =
  Object.freeze(TERMINAL_RISK_STATUS_VALUES);

type TerminalRiskStatusValues = (typeof TERMINAL_RISK_STATUS_VALUES)[number];

export type TerminalRiskStatus = TerminalRiskStatusValues;

export type NonTerminalRiskStatus = Exclude<RiskStatusName, TerminalRiskStatus>;

const TRANSITION_TARGETS = {
  OPEN: ["OPEN", "ASSESSED", "EXPIRED"],
} as const satisfies Record<
  NonTerminalRiskStatus,
  readonly RiskStatusName[]
>;

export const RISK_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(TRANSITION_TARGETS).map(([from, targets]) => [
      from,
      Object.freeze([...targets]),
    ]),
  ),
) as Readonly<Record<NonTerminalRiskStatus, readonly RiskStatusName[]>>;

export function isRiskTerminal(status: RiskStatusName): boolean {
  return (TERMINAL_RISK_STATUSES as readonly string[]).includes(status);
}

export function isRiskNonTerminal(
  status: RiskStatusName,
): status is NonTerminalRiskStatus {
  return !isRiskTerminal(status);
}

export const NON_TERMINAL_RISK_STATUSES: readonly NonTerminalRiskStatus[] =
  Object.freeze(RISK_STATUSES.filter(isRiskNonTerminal));

export function canTransitionRisk(
  from: RiskStatusName,
  to: RiskStatusName,
): boolean {
  if (!isRiskNonTerminal(from)) {
    return false;
  }
  return RISK_TRANSITIONS[from].includes(to);
}

export class IllegalRiskTransitionError extends Error {
  readonly code = "ILLEGAL_RISK_TRANSITION";

  constructor(
    readonly from: RiskStatusName,
    readonly to: RiskStatusName,
  ) {
    super(`Illegal revenue-risk transition: ${from} -> ${to}`);
    this.name = "IllegalRiskTransitionError";
  }
}

export function assertRiskTransition(
  from: RiskStatusName,
  to: RiskStatusName,
): void {
  if (!canTransitionRisk(from, to)) {
    throw new IllegalRiskTransitionError(from, to);
  }
}
