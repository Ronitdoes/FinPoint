import { getLogger, recordChaosFaultInjected } from "@repo/observability";

const logger = getLogger({ component: "fault-points" });

/**
 * Fault-point harness (Step 31 §Requirements 1).
 *
 * Deterministic breakpoints in activities/services, armed via the `FAULT_POINTS`
 * environment variable (`FAULT_POINTS=claim:after_provider_call,...` style) or
 * programmatically via `armFaultPoint` (preferred in tests — no env restarts).
 *
 * Entry format: `<activity>:<phase>` or `<scope>:<phase>`, comma-separated.
 * The activity name may be `*` to match every activity. Phases:
 * `pre` | `post` | `after_claim` | `before_provider_call` | `after_provider_call`.
 *
 * Business code contains no scattered `if (process.env...)` branches: it calls
 * the single choke point `checkFaultPoint(name, phase, detail)`, and the
 * activity framework (`withActivityContext`) automatically runs `pre`/`post`
 * hooks around every activity body via the registered hook table.
 *
 * Chaos runs only against dev/test tenants; the harness is a no-op in
 * production unless `CHAOS_ENABLED=true` is explicitly set.
 */

export type FaultPhase =
  | "pre"
  | "post"
  | "after_claim"
  | "before_provider_call"
  | "after_provider_call";

export type FaultBehaviorKind = "throw-crash" | "throw-transient" | "delay";

export interface FaultBehavior {
  kind: FaultBehaviorKind;
  /** Delay in ms for `delay` behavior. */
  delayMs?: number;
  /** Message attached to injected errors. */
  message?: string;
}

export interface FaultHookContext {
  activity: string;
  phase: FaultPhase;
  detail?: Record<string, unknown>;
}

export type FaultHook = (ctx: FaultHookContext) => Promise<void> | void;

export class FaultInjectedError extends Error {
  readonly code = "FAULT_INJECTED";
  /** `true` simulates a SIGKILL-style crash (no result persisted, retry resumes from history). */
  readonly crash: boolean;

  constructor(message: string, crash = true) {
    super(message);
    this.name = "FaultInjectedError";
    this.crash = crash;
  }
}

interface ArmedFault {
  activity: string;
  phase: FaultPhase;
  behavior: FaultBehavior;
}

const programmaticArms = new Map<string, ArmedFault>();
const hookTable = new Map<string, FaultHook[]>();

function armKey(activity: string, phase: FaultPhase): string {
  return `${activity}::${phase}`;
}

function isHarnessActive(): boolean {
  if (process.env.NODE_ENV === "production" && process.env.CHAOS_ENABLED !== "true") {
    return false;
  }
  return true;
}

/**
 * Parses a `FAULT_POINTS` env string into armed entries.
 * Unknown phases are ignored (fail-safe: never crash on config typos).
 */
export function parseFaultPoints(raw: string | undefined | null): ArmedFault[] {
  if (!raw) return [];
  const validPhases: FaultPhase[] = [
    "pre",
    "post",
    "after_claim",
    "before_provider_call",
    "after_provider_call",
  ];
  const armed: ArmedFault[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.lastIndexOf(":");
    if (sep <= 0) continue;
    const activity = trimmed.slice(0, sep).trim() || "*";
    const phase = trimmed.slice(sep + 1).trim() as FaultPhase;
    if (!validPhases.includes(phase)) continue;
    armed.push({ activity, phase, behavior: { kind: "throw-crash" } });
  }
  return armed;
}

function envArmed(activity: string, phase: FaultPhase): boolean {
  const entries = parseFaultPoints(process.env.FAULT_POINTS);
  return entries.some(
    (e) => e.phase === phase && (e.activity === "*" || e.activity === activity),
  );
}

function programmaticArm(activity: string, phase: FaultPhase): ArmedFault | undefined {
  return (
    programmaticArms.get(armKey(activity, phase)) ??
    programmaticArms.get(armKey("*", phase))
  );
}

/** Returns true when a fault point is armed (env or programmatic). */
export function isFaultPointArmed(activity: string, phase: FaultPhase): boolean {
  if (!isHarnessActive()) return false;
  if (programmaticArm(activity, phase)) return true;
  return envArmed(activity, phase);
}

/**
 * Arms a fault point programmatically for the current process.
 * Used by chaos tests to induce deterministic crashes without restarts.
 */
export function armFaultPoint(
  activity: string,
  phase: FaultPhase,
  behavior: FaultBehavior = { kind: "throw-crash" },
): void {
  programmaticArms.set(armKey(activity, phase), { activity, phase, behavior });
}

/** Clears one armed fault point (or all when called without arguments). */
export function clearFaultPoints(activity?: string, phase?: FaultPhase): void {
  if (activity === undefined) {
    programmaticArms.clear();
    return;
  }
  if (phase === undefined) {
    for (const key of [...programmaticArms.keys()]) {
      if (key.startsWith(`${activity}::`)) programmaticArms.delete(key);
    }
    return;
  }
  programmaticArms.delete(armKey(activity, phase));
}

/** Lists currently armed programmatic fault points (env entries excluded). */
export function listArmedFaultPoints(): ArmedFault[] {
  return [...programmaticArms.values()];
}

/**
 * Registers a pre/post hook for an activity fault point.
 * Hooks run inside `withActivityContext` (pre/post) — no business-code ifdefs.
 */
export function registerFaultHook(
  activity: string,
  phase: Extract<FaultPhase, "pre" | "post">,
  hook: FaultHook,
): () => void {
  const key = armKey(activity, phase);
  const existing = hookTable.get(key) ?? [];
  existing.push(hook);
  hookTable.set(key, existing);
  return () => {
    const hooks = hookTable.get(key) ?? [];
    hookTable.set(
      key,
      hooks.filter((h) => h !== hook),
    );
  };
}

/** Clears all registered fault hooks (test teardown). */
export function clearFaultHooks(): void {
  hookTable.clear();
}

async function runHooks(activity: string, phase: FaultPhase, ctx: FaultHookContext): Promise<void> {
  const hooks = [
    ...(hookTable.get(armKey(activity, phase)) ?? []),
    ...(hookTable.get(armKey("*", phase)) ?? []),
  ];
  for (const hook of hooks) {
    await hook(ctx);
  }
}

function applyBehavior(activity: string, phase: FaultPhase): Promise<void> {
  const armed =
    programmaticArm(activity, phase) ??
    (envArmed(activity, phase)
      ? { activity, phase, behavior: { kind: "throw-crash" as const } }
      : undefined);
  if (!armed) return Promise.resolve();
  const { behavior } = armed;
  if (behavior.kind === "delay") {
    return new Promise((resolve) => setTimeout(resolve, behavior.delayMs ?? 100));
  }
  const message =
    behavior.message ?? `Chaos fault injected at ${activity}:${phase}`;
  return Promise.reject(
    new FaultInjectedError(message, behavior.kind === "throw-crash"),
  );
}

/**
 * Single choke point for deterministic fault injection.
 * Call from activities/services at exact crash windows
 * (after claim, before/after provider call). Resolves silently when disarmed.
 */
export async function checkFaultPoint(
  activity: string,
  phase: FaultPhase,
  detail?: Record<string, unknown>,
): Promise<void> {
  if (!isHarnessActive()) return;
  const ctx: FaultHookContext = { activity, phase, detail };
  if (phase === "pre" || phase === "post") {
    await runHooks(activity, phase, ctx);
  }
  if (isFaultPointArmed(activity, phase)) {
    logger.warn({ activity, phase }, "Fault point armed — injecting failure");
    try {
      recordChaosFaultInjected(activity, phase);
    } catch {
      // metrics must never break fault injection
    }
    await applyBehavior(activity, phase);
  }
}
