import React from "react";
import { CheckCircle2, TrendingUp } from "lucide-react";
import { formatMoney } from "../../lib/money";
import { formatDate } from "../../lib/format";

export interface OutcomeCardProps {
  outcome: {
    id: string;
    payment_id: string | null;
    recovered_amount: number;
    recovered_at: string;
    attribution_method: string;
  } | null;
  currency?: string;
}

export function OutcomeCard({ outcome, currency = "INR" }: OutcomeCardProps) {
  if (!outcome) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-6 text-center text-slate-500 text-xs backdrop-blur-xl">
        Case is currently in progress — no finalized recovery outcome yet
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-950/25 via-[#0d111a]/90 to-[#0d111a]/90 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
      <div className="flex items-center justify-between pb-3 mb-4 border-b border-emerald-500/15">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 shadow-[0_0_12px_-3px_rgba(16,185,129,0.3)]">
            <CheckCircle2 className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-slate-100">
              Recovered Revenue Outcome
            </h3>
            <p className="text-[10px] text-slate-400 font-mono">
              Attribution: {outcome.attribution_method}
            </p>
          </div>
        </div>

        <div className="text-right font-mono">
          <span className="text-[10px] text-slate-400 block font-sans uppercase tracking-wider">Recovered</span>
          <span className="text-lg font-bold text-emerald-400 tabular-nums">
            {formatMoney(outcome.recovered_amount, currency)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono">
        <div className="rounded-xl border border-white/[0.06] bg-[#090c13]/70 p-3">
          <span className="text-[10px] text-slate-500 font-sans block mb-0.5 uppercase tracking-wider">
            Payment Ref
          </span>
          <span className="text-slate-200 truncate block text-xs" title={outcome.payment_id || "N/A"}>
            {outcome.payment_id || "Direct Settlement"}
          </span>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#090c13]/70 p-3">
          <span className="text-[10px] text-slate-500 font-sans block mb-0.5 uppercase tracking-wider">
            Recovered At
          </span>
          <span className="text-slate-200 block text-xs">
            {formatDate(outcome.recovered_at)}
          </span>
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-[#090c13]/70 p-3">
          <span className="text-[10px] text-slate-500 font-sans block mb-0.5 uppercase tracking-wider">
            Attribution Method
          </span>
          <span className="text-emerald-400 font-bold flex items-center gap-1 text-xs">
            <TrendingUp className="h-3 w-3" />
            {outcome.attribution_method}
          </span>
        </div>
      </div>
    </div>
  );
}
