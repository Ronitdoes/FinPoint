"use client";

import React, { useEffect, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { formatMoney } from "../../lib/money";
import type { RecoveryTimeseriesPoint } from "../../lib/types";

export interface RecoveryTimeseriesChartProps {
  data: RecoveryTimeseriesPoint[];
  currency?: string;
  height?: number;
  /** "ember" renders light-on-orange strokes for the hero chart card. */
  tone?: "dark" | "ember";
}

interface TooltipPayloadItem {
  value: number;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string;
  currency?: string;
  tone?: "dark" | "ember";
}

function CustomTooltip({ active, payload, label, currency = "INR", tone = "dark" }: CustomTooltipProps) {
  if (active && payload && payload.length) {
    const ember = tone === "ember";
    return (
      <div
        className={`min-w-44 rounded-2xl border p-3 text-xs shadow-[0_16px_48px_-12px_rgba(0,0,0,0.8)] ${
          ember
            ? "border-white/[0.12] bg-[#0e0e10]"
            : "border-white/[0.1] bg-[#0c1018]/95 backdrop-blur-xl"
        }`}
      >
        <p className="mb-2 border-b border-white/[0.08] pb-1.5 font-sans text-[12px] font-bold tracking-tight text-white">
          {label}
        </p>
        <div className="space-y-1.5 font-mono text-[11px]">
          <div className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-1.5 text-white/55">
              <span className={`h-1.5 w-1.5 rounded-full ${ember ? "bg-white" : "bg-cyan-400"}`} />
              At Risk:
            </span>
            <span className={`font-bold tabular-nums ${ember ? "text-white" : "text-cyan-300"}`}>
              {formatMoney((payload[0]?.value ?? 0) * 100, currency)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-1.5 text-white/55">
              <span className={`h-1.5 w-1.5 rounded-full ${ember ? "bg-[#FFE14D]" : "bg-emerald-400"}`} />
              Recovered:
            </span>
            <span className={`font-bold tabular-nums ${ember ? "text-[#FFE14D]" : "text-emerald-300"}`}>
              {formatMoney((payload[1]?.value ?? 0) * 100, currency)}
            </span>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

export function RecoveryTimeseriesChart({
  data,
  currency = "INR",
  height = 300,
  tone = "dark",
}: RecoveryTimeseriesChartProps) {
  const [mounted, setMounted] = useState(false);
  const ember = tone === "ember";

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div
        style={{ height }}
        className={`w-full rounded-2xl animate-pulse flex items-center justify-center text-xs border ${
          ember
            ? "bg-white/10 text-white/70 border-white/20"
            : "bg-[#090c13]/50 text-slate-600 border-white/[0.04]"
        }`}
      >
        Loading recovery trajectory...
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div
        style={{ height }}
        className={`w-full rounded-2xl flex flex-col items-center justify-center text-xs border ${
          ember
            ? "bg-white/10 text-white/75 border-white/20"
            : "bg-[#090c13]/30 text-slate-500 border-white/[0.04]"
        }`}
      >
        <p>No timeseries data available for this range</p>
      </div>
    );
  }

  const chartData = data.map((point) => {
    const atRisk = Number(point.revenueAtRisk) / 100;
    const recovered = Number(point.revenueRecovered) / 100;
    return {
      date: point.bucket,
      atRisk,
      recovered,
      cases: point.casesCount,
      recoveredCases: point.recoveredCasesCount,
    };
  });

  const atRiskId = ember ? "gradientAtRiskEmber" : "gradientAtRisk";
  const recoveredId = ember ? "gradientRecoveredEmber" : "gradientRecovered";
  const axisTick = ember ? "rgba(255,255,255,0.78)" : "#64748b";
  const axisLine = ember ? "rgba(255,255,255,0.25)" : "#1e293b";

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 10, left: -8, bottom: 0 }}
        >
          <defs>
            <linearGradient id={atRiskId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={ember ? "#ffffff" : "#06b6d4"} stopOpacity={ember ? 0.35 : 0.25} />
              <stop offset="95%" stopColor={ember ? "#ffffff" : "#06b6d4"} stopOpacity={0} />
            </linearGradient>
            <linearGradient id={recoveredId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={ember ? "#FFE14D" : "#10b981"} stopOpacity={ember ? 0.55 : 0.35} />
              <stop offset="95%" stopColor={ember ? "#FFE14D" : "#10b981"} stopOpacity={ember ? 0.05 : 0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={ember ? "rgba(255,255,255,0.22)" : "#182030"}
            vertical={false}
            opacity={ember ? 1 : 0.6}
          />
          <XAxis
            dataKey="date"
            stroke={axisTick}
            tick={{ fill: axisTick, fontSize: 10 }}
            fontSize={10}
            tickLine={false}
            axisLine={{ stroke: axisLine }}
            minTickGap={28}
          />
          <YAxis
            stroke={axisTick}
            tick={{ fill: axisTick, fontSize: 10 }}
            fontSize={10}
            tickLine={false}
            axisLine={{ stroke: axisLine }}
            tickFormatter={(val) => formatMoney(val * 100, currency, { compact: true })}
            width={52}
          />
          <Tooltip
            content={<CustomTooltip currency={currency} tone={tone} />}
            cursor={{ stroke: ember ? "rgba(255,255,255,0.55)" : "#334155", strokeWidth: 1 }}
          />
          <Area
            type="monotone"
            dataKey="atRisk"
            name="At Risk"
            stroke={ember ? "#ffffff" : "#06b6d4"}
            strokeWidth={ember ? 1.6 : 1.8}
            fillOpacity={1}
            fill={`url(#${atRiskId})`}
          />
          <Area
            type="monotone"
            dataKey="recovered"
            name="Recovered"
            stroke={ember ? "#FFE14D" : "#10b981"}
            strokeWidth={ember ? 2.4 : 2}
            fillOpacity={1}
            fill={`url(#${recoveredId})`}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
