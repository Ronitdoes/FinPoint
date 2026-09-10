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
      <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-6 text-center text-xs text-white/40">
        Case is currently in progress — no finalized recovery outcome yet
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-5">
      <div className="mb-4 border-b border-white/[0.06] pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-[#3ef0a8]" />
            <h3 className="text-[13px] font-semibold tracking-tight text-white">
              Recovered Revenue Outcome
            </h3>
          </div>

          <div className="text-right font-mono">
            <span className="block font-sans text-[10px] uppercase tracking-wider text-white/45">
              Recovered
            </span>
            <span className="text-lg font-bold text-[#3ef0a8] tabular-nums">
              {formatMoney(outcome.recovered_amount, currency)}
            </span>
          </div>
        </div>
        <p className="mt-1 font-mono text-[11px] font-normal text-white/45">
          Attribution: <span className="text-white/70">{outcome.attribution_method}</span>
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs font-mono">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
          <span className="mb-1 block font-sans text-[10px] uppercase tracking-widest text-white/45">
            Payment Ref
          </span>
          <span className="block truncate text-xs text-white font-medium" title={outcome.payment_id || "N/A"}>
            {outcome.payment_id || "Direct Settlement"}
          </span>
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
          <span className="mb-1 block font-sans text-[10px] uppercase tracking-widest text-white/45">
            Recovered At
          </span>
          <span className="block text-xs text-white font-medium">
            {formatDate(outcome.recovered_at)}
          </span>
        </div>

        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
          <span className="mb-1 block font-sans text-[10px] uppercase tracking-widest text-white/45">
            Attribution Method
          </span>
          <span className="flex items-center gap-1 text-xs font-bold text-[#3ef0a8]">
            <TrendingUp className="h-3 w-3" />
            {outcome.attribution_method}
          </span>
        </div>
      </div>
    </div>
  );
}
