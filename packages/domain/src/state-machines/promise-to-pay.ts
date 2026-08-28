import { PROMISE_TO_PAY_STATUSES } from "../enums/promise-to-pay-status";
import type { PromiseToPayStatus as PromiseToPayStatusName } from "../enums/promise-to-pay-status";

const TERMINAL_PTP_STATUS_VALUES = [
  "HONORED",
  "BROKEN",
  "EXPIRED",
] as const;

export const TERMINAL_PTP_STATUSES: readonly TerminalPromiseToPayStatusValues[] =
  Object.freeze(TERMINAL_PTP_STATUS_VALUES);

type TerminalPromiseToPayStatusValues =
  (typeof TERMINAL_PTP_STATUS_VALUES)[number];

export type TerminalPromiseToPayStatus = TerminalPromiseToPayStatusValues;

export type NonTerminalPromiseToPayStatus = Exclude<
  PromiseToPayStatusName,
  TerminalPromiseToPayStatus
>;

const TRANSITION_TARGETS = {
  MADE: ["HONORED", "BROKEN", "EXPIRED"],
} as const satisfies Record<
  NonTerminalPromiseToPayStatus,
  readonly PromiseToPayStatusName[]
>;

export const PTP_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(TRANSITION_TARGETS).map(([from, targets]) => [
      from,
      Object.freeze([...targets]),
    ]),
  ),
) as Readonly<
  Record<NonTerminalPromiseToPayStatus, readonly PromiseToPayStatusName[]>
>;

export function isTerminalPtpStatus(status: PromiseToPayStatusName): boolean {
  return (TERMINAL_PTP_STATUSES as readonly string[]).includes(status);
}

export function isNonTerminalPtpStatus(
  status: PromiseToPayStatusName,
): status is NonTerminalPromiseToPayStatus {
  return !isTerminalPtpStatus(status);
}

export const NON_TERMINAL_PTP_STATUSES: readonly NonTerminalPromiseToPayStatus[] =
  Object.freeze(PROMISE_TO_PAY_STATUSES.filter(isNonTerminalPtpStatus));

export function canTransitionPtp(
  from: PromiseToPayStatusName,
  to: PromiseToPayStatusName,
): boolean {
  if (!isNonTerminalPtpStatus(from)) {
    return false;
  }
  return PTP_TRANSITIONS[from].includes(to);
}

export class IllegalPtpTransitionError extends Error {
  readonly code = "ILLEGAL_PTP_TRANSITION";

  constructor(
    readonly from: PromiseToPayStatusName,
    readonly to: PromiseToPayStatusName,
  ) {
    super(`Illegal promise-to-pay transition: ${from} -> ${to}`);
    this.name = "IllegalPtpTransitionError";
  }
}

export function assertPtpTransition(
  from: PromiseToPayStatusName,
  to: PromiseToPayStatusName,
): void {
  if (!canTransitionPtp(from, to)) {
    throw new IllegalPtpTransitionError(from, to);
  }
}
