"use client";

import React, { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert } from "./ui/Alert";
import {
  DEGRADED_MODE_COPY,
  isDegradedModeEnabled,
  setDegradedModeEnabled,
} from "../lib/degraded-mode";

/**
 * Ops toggle + banner for degraded autonomy mode (s-34 §AI Behavior).
 * Rendered in Settings so operators can mark (and unmark) fallback operation.
 */
export function DegradedModeBanner() {
  const [enabled, setEnabled] = useState(() => isDegradedModeEnabled());

  const toggle = (next: boolean) => {
    setDegradedModeEnabled(next);
    setEnabled(next);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3.5">
        <div className="flex items-center gap-2.5">
          <AlertTriangle className="h-4 w-4 text-amber-300" />
          <div>
            <p className="text-xs font-semibold text-white">Degraded autonomy mode</p>
            <p className="text-[11px] text-white/45">
              Turn on while LLMFallbackRate is firing (runbook llm-fallback-rate)
            </p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Degraded autonomy mode"
          onClick={() => toggle(!enabled)}
          className={`relative h-6 w-11 rounded-full border transition-colors cursor-pointer ${
            enabled ? "bg-amber-400/80 border-amber-300" : "bg-white/10 border-white/15"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white transition-all ${
              enabled ? "left-[22px]" : "left-0.5"
            }`}
            style={{ width: 18, height: 18 }}
          />
        </button>
      </div>
      {enabled && (
        <Alert variant="warning" title={DEGRADED_MODE_COPY.title}>
          {DEGRADED_MODE_COPY.body}
        </Alert>
      )}
    </div>
  );
}
