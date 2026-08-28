import React from "react";
import { TrendingUp, TrendingDown, Minus, ShieldAlert } from "lucide-react";

export interface MetricCardProps {
  title: string;
  value: string | number;
  subValue?: string;
  change?: {
    value: number;
    period?: string;
  };
  icon?: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  redacted?: boolean;
  tooltip?: string;
}

export function MetricCard({
  title,
  value,
  subValue,
  change,
  icon,
  variant = "default",
  redacted = false,
}: MetricCardProps) {
  const accentStyles = {
    default: "border-white/[0.07] hover:border-white/[0.15]",
    success: "border-emerald-500/20 hover:border-emerald-500/40 bg-gradient-to-b from-emerald-950/10 to-[#0d111a]/90",
    warning: "border-amber-500/20 hover:border-amber-500/40 bg-gradient-to-b from-amber-950/10 to-[#0d111a]/90",
    danger: "border-rose-500/20 hover:border-rose-500/40 bg-gradient-to-b from-rose-950/10 to-[#0d111a]/90",
    info: "border-cyan-500/20 hover:border-cyan-500/40 bg-gradient-to-b from-cyan-950/10 to-[#0d111a]/90",
  };

  const iconStyles = {
    default: "text-slate-400 bg-white/[0.04] border-white/[0.08]",
    success: "text-emerald-400 bg-emerald-500/10 border-emerald-500/25 shadow-[0_0_12px_-3px_rgba(16,185,129,0.3)]",
    warning: "text-amber-400 bg-amber-500/10 border-amber-500/25 shadow-[0_0_12px_-3px_rgba(245,158,11,0.3)]",
    danger: "text-rose-400 bg-rose-500/10 border-rose-500/25 shadow-[0_0_12px_-3px_rgba(244,63,94,0.3)]",
    info: "text-cyan-400 bg-cyan-500/10 border-cyan-500/25 shadow-[0_0_12px_-3px_rgba(6,182,212,0.3)]",
  };

  return (
    <div
      className={`group relative rounded-2xl border bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/60 ${accentStyles[variant]}`}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {title}
        </span>
        {icon && (
          <div
            className={`rounded-xl border p-2 transition-transform duration-200 group-hover:scale-105 ${iconStyles[variant]}`}
          >
            {icon}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        {redacted ? (
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400 bg-white/[0.04] px-2.5 py-1 rounded-lg border border-white/[0.08]">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
            <span>Redacted (Finance+)</span>
          </div>
        ) : (
          <div className="text-2xl font-bold tracking-tight text-slate-100 font-mono tabular-nums">
            {value}
          </div>
        )}
        {subValue && !redacted && (
          <span className="text-xs text-slate-400 font-normal">{subValue}</span>
        )}
      </div>

      {change && !redacted && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[11px]">
          {change.value > 0 ? (
            <span className="inline-flex items-center font-semibold text-emerald-400">
              <TrendingUp className="mr-0.5 h-3.5 w-3.5" />
              +{change.value}%
            </span>
          ) : change.value < 0 ? (
            <span className="inline-flex items-center font-semibold text-rose-400">
              <TrendingDown className="mr-0.5 h-3.5 w-3.5" />
              {change.value}%
            </span>
          ) : (
            <span className="inline-flex items-center font-medium text-slate-400">
              <Minus className="mr-0.5 h-3.5 w-3.5" />
              0%
            </span>
          )}
          <span className="text-slate-500 font-normal">
            vs {change.period || "previous period"}
          </span>
        </div>
      )}
    </div>
  );
}
