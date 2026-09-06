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
  const tintStyles = {
    default: "from-white/[0.07] via-transparent to-transparent",
    success: "from-emerald-400/[0.14] via-emerald-400/[0.03] to-transparent",
    warning: "from-amber-400/[0.14] via-amber-400/[0.03] to-transparent",
    danger: "from-rose-400/[0.14] via-rose-400/[0.03] to-transparent",
    info: "from-cyan-400/[0.14] via-cyan-400/[0.03] to-transparent",
  };

  const iconStyles = {
    default: "text-slate-300 bg-white/[0.06] border-white/[0.1] backdrop-blur-md",
    success:
      "text-emerald-300 bg-emerald-400/10 border-emerald-300/20 shadow-[0_0_16px_-4px_rgba(16,185,129,0.5)] backdrop-blur-md",
    warning:
      "text-amber-300 bg-amber-400/10 border-amber-300/20 shadow-[0_0_16px_-4px_rgba(245,158,11,0.5)] backdrop-blur-md",
    danger:
      "text-rose-300 bg-rose-400/10 border-rose-300/20 shadow-[0_0_16px_-4px_rgba(244,63,94,0.5)] backdrop-blur-md",
    info: "text-cyan-300 bg-cyan-400/10 border-cyan-300/20 shadow-[0_0_16px_-4px_rgba(6,182,212,0.5)] backdrop-blur-md",
  };

  return (
    <div className="group relative overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#131316] p-5 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-white/[0.15]">
      {/* variant tint wash + top refraction streak */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 bg-gradient-to-b ${tintStyles[variant]}`}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent"
      />
      <div className="relative flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {title}
        </span>
        {icon && (
          <div
            className={`rounded-xl border p-2 transition-transform duration-300 group-hover:scale-110 ${iconStyles[variant]}`}
          >
            {icon}
          </div>
        )}
      </div>

      <div className="relative mt-3 flex items-baseline gap-2">
        {redacted ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-xs font-medium text-slate-300">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-300" />
            <span>Redacted (Finance+)</span>
          </div>
        ) : (
          <div className="text-[26px] leading-none font-bold tracking-tight text-white tabular-nums">
            {value}
          </div>
        )}
        {subValue && !redacted && (
          <span className="max-w-[50%] truncate text-[11px] text-slate-400 font-normal">{subValue}</span>
        )}
      </div>

      {change && !redacted && (
        <div className="relative mt-2.5 flex items-center gap-1.5 text-[11px]">
          {change.value > 0 ? (
            <span className="inline-flex items-center font-semibold text-emerald-300">
              <TrendingUp className="mr-0.5 h-3.5 w-3.5" />
              +{change.value}%
            </span>
          ) : change.value < 0 ? (
            <span className="inline-flex items-center font-semibold text-rose-300">
              <TrendingDown className="mr-0.5 h-3.5 w-3.5" />
              {change.value}%
            </span>
          ) : (
            <span className="inline-flex items-center font-medium text-slate-400">
              <Minus className="mr-0.5 h-3.5 w-3.5" />
              0%
            </span>
          )}
          <span className="text-slate-500 font-normal">vs {change.period || "previous period"}</span>
        </div>
      )}
    </div>
  );
}
