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
      className={`rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl ${className}`}
    >
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
            className="rounded-xl border border-white/[0.06] bg-[#090c13]/70 p-3.5 transition-all hover:border-white/[0.12] hover:bg-[#0e131e]"
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
