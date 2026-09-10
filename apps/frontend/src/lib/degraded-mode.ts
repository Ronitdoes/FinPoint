/**
 * Degraded-autonomy-mode doctrine (s-34 §AI Behavior).
 *
 * When LLMFallbackRate fires sustained, the ops toggle below drives a
 * banner in dashboard Settings noting the system operates on deterministic
 * fallbacks. Bounded autonomy holds throughout (policy layer unchanged —
 * the LLM only ever recommends). Persisted per-browser in localStorage so
 * the toggle survives refresh; the alert + runbook remain authoritative.
 */

export const DEGRADED_MODE_STORAGE_KEY = "arr.degradedMode";

export const DEGRADED_MODE_COPY = {
  title: "Degraded autonomy mode — deterministic fallbacks active",
  body: "LLM fallback rate is above threshold. The system is operating on deterministic rule-based decisions until the model path recovers. Bounded autonomy holds: every action still passes policy evaluation. See runbook llm-fallback-rate.",
} as const;

export function isDegradedModeEnabled(
  storage?: Pick<Storage, "getItem"> | undefined,
): boolean {
  try {
    const store =
      storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    return store?.getItem(DEGRADED_MODE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setDegradedModeEnabled(
  enabled: boolean,
  storage?: Pick<Storage, "setItem" | "removeItem"> | undefined,
): void {
  try {
    const store =
      storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    if (!store) return;
    if (enabled) store.setItem(DEGRADED_MODE_STORAGE_KEY, "true");
    else store.removeItem(DEGRADED_MODE_STORAGE_KEY);
  } catch {
    // Banner state must never break settings rendering.
  }
}
