/**
 * Chaos fault-point test helpers (Step 31).
 *
 * Canonical fault-point registry lives in the worker activity framework
 * (`@repo/worker/fault-points`); this module re-exports it and adds the
 * scoped helpers chaos scenarios use to arm deterministic crash windows
 * without process restarts or scattered env branches.
 */
export {
  armFaultPoint,
  clearFaultPoints,
  clearFaultHooks,
  isFaultPointArmed,
  listArmedFaultPoints,
  parseFaultPoints,
  registerFaultHook,
  checkFaultPoint,
  FaultInjectedError,
} from "@repo/worker/fault-points";
export type {
  FaultBehavior,
  FaultBehaviorKind,
  FaultHook,
  FaultHookContext,
  FaultPhase,
} from "@repo/worker/fault-points";

import {
  armFaultPoint,
  clearFaultHooks,
  clearFaultPoints,
} from "@repo/worker/fault-points";
import type {
  FaultBehavior,
  FaultPhase,
} from "@repo/worker/fault-points";
import {
  MockMessagingProvider,
  MockPaymentProvider,
} from "@repo/integrations";

/**
 * Arms a fault point for the duration of `fn`, then always disarms it.
 * Guarantees no armed fault leaks between scenarios.
 */
export async function withFaultPoint<T>(
  activity: string,
  phase: FaultPhase,
  fn: () => Promise<T>,
  behavior: FaultBehavior = { kind: "throw-crash" },
): Promise<T> {
  armFaultPoint(activity, phase, behavior);
  try {
    return await fn();
  } finally {
    clearFaultPoints(activity, phase);
  }
}

/**
 * Full harness reset for `afterEach` hooks: disarms fault points, clears
 * registered hooks, and resets mock provider scripted state.
 */
export function resetChaosHarness(): void {
  clearFaultPoints();
  clearFaultHooks();
  MockPaymentProvider.clearOverrides();
  MockMessagingProvider.clearHistory();
  delete process.env.FAULT_POINTS;
}
