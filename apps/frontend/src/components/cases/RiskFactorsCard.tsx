import React from "react";
import { AlertTriangle } from "lucide-react";
import { getRiskBandColor } from "../../lib/format";
import type { RiskBand, RiskType } from "../../lib/types";

export interface RiskFactorsCardProps {
  risk: {
    id: string;
    risk_type: RiskType;
    band: RiskBand;
    score: number;
    factors: Record<string, unknown>;
    computed_at: string;
    status: string;
  } | null;
}

export function RiskFactorsCard({ risk }: RiskFactorsCardProps) {
  if (!risk) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-6 text-center text-slate-500 text-xs backdrop-blur-xl">
        No risk evaluation attached to this case
      </div>
    );
  }

  const bandStyles = getRiskBandColor(risk.band);

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          <h3 className="text-xs font-semibold text-slate-100">
            Risk Analysis & Factors Breakdown
          </h3>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400 font-mono">
            Score: <strong className="text-slate-100">{risk.score}/100</strong>
          </span>
          <span
            className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${bandStyles.bg} ${bandStyles.text} ${bandStyles.border}`}
          >
            {risk.band}
          </span>
        </div>
      </div>

      <div className="space-y-3 text-xs">
        <p className="text-[11px] text-slate-400 font-normal">
          Why this case was flagged at risk:
        </p>

        <div className="space-y-2">
          {risk.factors && Object.keys(risk.factors).length > 0 ? (
            Object.entries(risk.factors).map(([key, val]) => (
              <div
                key={key}
                className="flex items-center justify-between gap-4 rounded-xl border border-white/[0.06] bg-[#090c13]/70 p-2.5"
              >
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                  <span className="font-medium text-slate-300 capitalize text-xs">
                    {key.replace(/_/g, " ")}
                  </span>
                </div>
                <span className="font-mono text-slate-200 font-semibold text-xs tabular-nums">
                  {typeof val === "object" ? JSON.stringify(val) : String(val)}
                </span>
              </div>
            ))
          ) : (
            <p className="text-slate-500 italic text-xs">No specific factor weights available</p>
          )}
        </div>
      </div>
    </div>
  );
}
