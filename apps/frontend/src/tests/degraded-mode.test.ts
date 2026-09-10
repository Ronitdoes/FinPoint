import { describe, it, expect } from "vitest";
import {
  DEGRADED_MODE_STORAGE_KEY,
  DEGRADED_MODE_COPY,
  isDegradedModeEnabled,
  setDegradedModeEnabled,
} from "../lib/degraded-mode";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("Degraded autonomy mode doctrine (s-34)", () => {
  it("is off by default and toggles explicitly", () => {
    const store = memoryStorage();
    expect(isDegradedModeEnabled(store)).toBe(false);
    setDegradedModeEnabled(true, store);
    expect(isDegradedModeEnabled(store)).toBe(true);
    expect(store.getItem(DEGRADED_MODE_STORAGE_KEY)).toBe("true");
    setDegradedModeEnabled(false, store);
    expect(isDegradedModeEnabled(store)).toBe(false);
  });

  it("banner copy states fallback operation and bounded-autonomy hold", () => {
    expect(DEGRADED_MODE_COPY.title).toMatch(/degraded autonomy/i);
    expect(DEGRADED_MODE_COPY.body).toMatch(/deterministic/);
    expect(DEGRADED_MODE_COPY.body).toMatch(/policy/);
    expect(DEGRADED_MODE_COPY.body).toMatch(/llm-fallback-rate/);
  });

  it("never throws on hostile storage (banner must not break settings)", () => {
    const hostile = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(isDegradedModeEnabled(hostile)).toBe(false);
    expect(() => setDegradedModeEnabled(true, hostile)).not.toThrow();
  });
});
