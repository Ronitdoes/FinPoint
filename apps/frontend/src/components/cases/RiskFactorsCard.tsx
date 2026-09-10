import React from "react";
import { AlertTriangle } from "lucide-react";
import { getRiskBandColor } from "../../lib/format";
import { RiskFactorBreakdown } from "../risk/RiskFactorBreakdown";
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
      <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-6 text-center text-xs text-white/40">
        No risk evaluation attached to this case
      </div>
    );
  }

  const bandStyles = getRiskBandColor(risk.band);

  return (
    <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-5">
      <div className="mb-4 border-b border-white/[0.06] pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h3 className="text-[13px] font-semibold tracking-tight text-white">
              Risk Analysis &amp; Factors Breakdown
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-white/45">
              Score:{" "}
              <strong className="text-white">{risk.score}/100</strong>
            </span>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${bandStyles.bg} ${bandStyles.text} ${bandStyles.border}`}
            >
              {risk.band}
            </span>
          </div>
        </div>
        <p className="mt-1 text-[11px] font-normal text-white/45">
          Why this case was flagged at risk
        </p>
      </div>

      <RiskFactorBreakdown factors={risk.factors} />
    </div>
  );
}
