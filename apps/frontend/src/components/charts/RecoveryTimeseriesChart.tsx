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
}

export function RecoveryTimeseriesChart({
  data,
  currency = "INR",
  height = 300,
}: RecoveryTimeseriesChartProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div
        style={{ height }}
        className="w-full rounded-2xl bg-[#090c13]/50 animate-pulse flex items-center justify-center text-xs text-slate-600 border border-white/[0.04]"
      >
        Loading recovery trajectory...
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center rounded-2xl border border-dashed border-white/[0.08] bg-[#090c13]/30 text-xs text-slate-500"
      >
        No timeseries data available for selected period
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

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-xl border border-white/[0.1] bg-[#0c1018]/95 p-3 shadow-2xl backdrop-blur-xl text-xs">
          <p className="font-semibold text-slate-300 mb-2 border-b border-white/[0.06] pb-1 text-[11px]">
            {label}
          </p>
          <div className="space-y-1.5 font-mono text-[11px]">
            <div className="flex items-center justify-between gap-4 text-cyan-400">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                At Risk:
              </span>
              <span className="font-bold tabular-nums">
                {formatMoney(payload[0]?.value * 100, currency)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 text-emerald-400">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Recovered:
              </span>
              <span className="font-bold tabular-nums">
                {formatMoney(payload[1]?.value * 100, currency)}
              </span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={chartData}
          margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
        >
          <defs>
            <linearGradient id="gradientAtRisk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gradientRecovered" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#182030" vertical={false} opacity={0.6} />
          <XAxis
            dataKey="date"
            stroke="#64748b"
            fontSize={10}
            tickLine={false}
            axisLine={{ stroke: "#1e293b" }}
          />
          <YAxis
            stroke="#64748b"
            fontSize={10}
            tickLine={false}
            axisLine={{ stroke: "#1e293b" }}
            tickFormatter={(val) => formatMoney(val * 100, currency, { compact: true })}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="atRisk"
            name="At Risk"
            stroke="#06b6d4"
            strokeWidth={1.8}
            fillOpacity={1}
            fill="url(#gradientAtRisk)"
          />
          <Area
            type="monotone"
            dataKey="recovered"
            name="Recovered"
            stroke="#10b981"
            strokeWidth={2}
            fillOpacity={1}
            fill="url(#gradientRecovered)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
