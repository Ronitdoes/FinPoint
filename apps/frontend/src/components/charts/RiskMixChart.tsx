import React from "react";
import { formatMoney } from "../../lib/money";
import { Badge } from "../ui/Badge";
import type { RiskMixItem, RiskType } from "../../lib/types";

export interface RiskMixChartProps {
  mix: RiskMixItem[];
  currency?: string;
}

const TYPE_NAMES: Record<RiskType, string> = {
  FAILED_PAYMENT: "Failed Payments",
  CHECKOUT_ABANDONED: "Checkout Abandonment",
  OVERDUE_INVOICE: "Overdue Invoices",
  DISPUTE_RISK: "Dispute Risks",
  SUBSCRIPTION_CHURN: "Subscription Churn",
};

export function RiskMixChart({ mix, currency = "INR" }: RiskMixChartProps) {
  if (!mix || mix.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-2xl border border-dashed border-white/[0.08] text-xs text-slate-500">
        No risk mix data available
      </div>
    );
  }

  // Aggregate by risk type
  const typeMap: Record<string, { count: number; value: number }> = {};
  mix.forEach((item) => {
    const prev = typeMap[item.riskType] || { count: 0, value: 0 };
    typeMap[item.riskType] = {
      count: prev.count + item.count,
      value: prev.value + Number(item.value),
    };
  });

  const totalValue = Object.values(typeMap).reduce((acc, curr) => acc + curr.value, 0) || 1;

  const bandBadges: Record<string, "danger" | "warning" | "info" | "success"> = {
    CRITICAL: "danger",
    HIGH: "warning",
    MEDIUM: "info",
    LOW: "success",
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {Object.entries(typeMap).map(([type, stats]) => {
          const share = (stats.value / totalValue) * 100;
          return (
            <div key={type} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-200">
                  {TYPE_NAMES[type as RiskType] || type}
                </span>
                <span className="font-mono text-slate-300 tabular-nums">
                  {formatMoney(stats.value, currency)} ({stats.count} cases)
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800/80">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(share, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="pt-3 border-t border-white/[0.06]">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
          Breakdown by Risk Band
        </h4>
        <div className="flex flex-wrap gap-1.5">
          {mix.map((item, idx) => (
            <Badge
              key={idx}
              variant={bandBadges[item.band] || "default"}
              size="sm"
            >
              {item.band}: {item.count} ({formatMoney(item.value, currency, { compact: true })})
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
