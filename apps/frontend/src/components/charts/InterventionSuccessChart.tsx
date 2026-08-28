import React from "react";
import { formatMoney } from "../../lib/money";
import { formatPercent } from "../../lib/format";
import type { InterventionStat } from "../../lib/types";

export interface InterventionSuccessChartProps {
  stats: InterventionStat[];
  currency?: string;
}

const ACTION_LABELS: Record<string, string> = {
  RETRY_PAYMENT: "Payment Retry",
  SEND_WHATSAPP: "WhatsApp Outreach",
  SEND_EMAIL: "Email Reminder",
  CREATE_PAYMENT_LINK: "Alternate Payment Link",
  OFFER_INCENTIVE: "Recovery Incentive",
  CREATE_HUMAN_TASK: "Human Escalation",
};

export function InterventionSuccessChart({
  stats,
  currency = "INR",
}: InterventionSuccessChartProps) {
  if (!stats || stats.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-xs text-slate-500">
        No intervention statistics recorded yet
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-white/[0.06] text-slate-400 font-semibold uppercase text-[10px]">
          <tr>
            <th className="py-2.5 pr-4">Intervention Type</th>
            <th className="py-2.5 px-4 text-right">Attempts</th>
            <th className="py-2.5 px-4 text-right">Successes</th>
            <th className="py-2.5 px-4">Success Rate</th>
            <th className="py-2.5 pl-4 text-right">Recovered</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
          {stats.map((stat) => (
            <tr key={stat.actionType} className="hover:bg-white/[0.02] transition-colors">
              <td className="py-3 pr-4 font-sans font-medium text-slate-200">
                {ACTION_LABELS[stat.actionType] || stat.actionType}
              </td>
              <td className="py-3 px-4 text-right text-slate-300 tabular-nums">
                {stat.totalAttempts.toLocaleString()}
              </td>
              <td className="py-3 px-4 text-right text-emerald-400 font-semibold tabular-nums">
                {stat.successfulAttempts.toLocaleString()}
              </td>
              <td className="py-3 px-4 min-w-[140px]">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800/80">
                    <div
                      className="h-full bg-emerald-500 rounded-full shadow-[0_0_6px_rgba(16,185,129,0.5)]"
                      style={{ width: `${Math.min(stat.successRate, 100)}%` }}
                    />
                  </div>
                  <span className="text-[11px] text-slate-300 font-semibold w-10 text-right tabular-nums">
                    {formatPercent(stat.successRate)}
                  </span>
                </div>
              </td>
              <td className="py-3 pl-4 text-right font-semibold text-emerald-400 tabular-nums">
                {formatMoney(stat.totalRecovered, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
