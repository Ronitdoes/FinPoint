import React from "react";
import { Badge } from "../ui/Badge";

export interface StatItem {
  label: string;
  value: string | number;
  subtext?: string;
  badge?: string;
  badgeVariant?: "success" | "warning" | "danger" | "info" | "default";
}

export interface StatGroupProps {
  title: string;
  description?: string;
  stats: StatItem[];
  columns?: 2 | 3 | 4 | 5;
  className?: string;
}

export function StatGroup({
  title,
  description,
  stats,
  columns = 4,
  className = "",
}: StatGroupProps) {
  const gridCols = {
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-4",
    5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  };

  return (
    <div
      className={`relative overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#131316] p-5 ${className}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent"
      />
      <div className="mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">{title}</h3>
        {description && (
          <p className="text-[11px] text-slate-400 mt-0.5 font-normal">{description}</p>
        )}
      </div>

      <div className={`grid gap-3 ${gridCols[columns]}`}>
        {stats.map((stat, idx) => (
          <div
            key={idx}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.03] p-3.5 transition-[border-color,background-color,transform] hover:border-white/15 hover:bg-white/[0.06]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-slate-400">
                {stat.label}
              </span>
              {stat.badge && (
                <Badge variant={stat.badgeVariant || "default"} size="sm">
                  {stat.badge}
                </Badge>
              )}
            </div>
            <div className="mt-1.5 text-lg font-bold font-mono text-slate-100 tabular-nums">
              {stat.value}
            </div>
            {stat.subtext && (
              <p className="mt-1 text-[10px] text-slate-500 font-normal">{stat.subtext}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
