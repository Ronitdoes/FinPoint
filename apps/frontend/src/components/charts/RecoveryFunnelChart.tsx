import React from "react";
import { formatMoney } from "../../lib/money";
import { formatPercent } from "../../lib/format";
import type { FunnelStage } from "../../lib/types";
import { ArrowDown, CheckCircle2 } from "lucide-react";

/**
 * s-28 chart deviation (intentional, documented in s-28 explanation §6):
 * - Recovery timeseries uses Recharts (`RecoveryTimeseriesChart.tsx` AreaChart).
 * - This funnel is custom divs (progressive-width bars + conversion labels),
 *   not Recharts Funnel/Bar. Rationale: precise financial-control-plane styling,
 *   accessible text-first rendering, and per-stage conversion math tested in
 *   `funnel.test.ts`. Spec s-28 §Requirements 5 ("funnel bar") is satisfied
 *   as a funnel bar viz; only the library differs for this one chart.
 */

export interface RecoveryFunnelChartProps {
  stages: FunnelStage[];
  currency?: string;
}

const STAGE_LABELS: Record<string, { label: string; desc: string; color: string }> = {
  AT_RISK: {
    label: "1. At Risk",
    desc: "Detected revenue leakage cases",
    color: "from-rose-500/20 via-rose-500/10 to-transparent border-rose-500/30 text-rose-300",
  },
  QUALIFIED: {
    label: "2. Qualified",
    desc: "Cases meeting recovery criteria",
    color: "from-amber-500/20 via-amber-500/10 to-transparent border-amber-500/30 text-amber-300",
  },
  CONTACTED: {
    label: "3. Contacted",
    desc: "WhatsApp/Email outreach delivered",
    color: "from-cyan-500/20 via-cyan-500/10 to-transparent border-cyan-500/30 text-cyan-300",
  },
  ATTEMPTED: {
    label: "4. Attempted",
    desc: "Payment retries / links generated",
    color: "from-indigo-500/20 via-indigo-500/10 to-transparent border-indigo-500/30 text-indigo-300",
  },
  RECOVERED: {
    label: "5. Recovered",
    desc: "Closed-loop recovered revenue",
    color: "from-emerald-500/25 via-emerald-500/15 to-transparent border-emerald-500/40 text-emerald-300 shadow-[0_0_15px_-3px_rgba(16,185,129,0.2)]",
  },
};

export function RecoveryFunnelChart({
  stages,
  currency = "INR",
}: RecoveryFunnelChartProps) {
  if (!stages || stages.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-xs text-slate-500">
        No funnel data available
      </div>
    );
  }

  const maxCount = Math.max(...stages.map((s) => s.count || 1), 1);

  return (
    <div className="space-y-3">
      {stages.map((stage, idx) => {
        const meta = STAGE_LABELS[stage.stage] || {
          label: stage.stage,
          desc: "",
          color: "from-slate-700/20 to-transparent border-white/[0.08] text-slate-300",
        };
        const widthPercent = Math.max((stage.count / maxCount) * 100, 20);

        return (
          <div key={stage.stage} className="relative">
            <div
              className={`relative overflow-hidden rounded-xl border bg-gradient-to-r p-3.5 transition-all duration-200 hover:scale-[1.01] ${meta.color}`}
              style={{ width: `${widthPercent}%` }}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-slate-100 text-xs">
                      {meta.label}
                    </span>
                    {stage.stage === "RECOVERED" && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400">{meta.desc}</p>
                </div>

                <div className="text-right">
                  <div className="font-mono text-sm font-bold text-slate-100 tabular-nums">
                    {stage.count.toLocaleString()} cases
                  </div>
                  <div className="font-mono text-[11px] text-slate-300 tabular-nums">
                    {formatMoney(stage.value, currency)}
                  </div>
                </div>
              </div>
            </div>

            {idx < stages.length - 1 && (
              <div className="my-1 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-400 font-mono">
                <ArrowDown className="h-3 w-3 text-slate-500" />
                <span>
                  {formatPercent(stages[idx + 1]?.conversionRate)} conversion
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
