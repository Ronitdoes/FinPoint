"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  TrendingUp,
  Activity,
  ArrowUpRight,
  RefreshCw,
  Maximize2,
  ShieldAlert,
  CheckCircle2,
  Layers,
  Sparkles,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { RecoveryTimeseriesChart } from "../../../components/charts/RecoveryTimeseriesChart";
import { RiskMixChart } from "../../../components/charts/RiskMixChart";
import { Badge } from "../../../components/ui/Badge";
import { Skeleton, SkeletonTable, SkeletonCards, SkeletonChart, SkeletonStats } from "../../../components/ui/Skeleton";
import { formatMoney } from "../../../lib/money";
import { formatDate, formatPercent, getCaseStatusColor } from "../../../lib/format";
import { api } from "../../../lib/api";
import type {
  AnalyticsSummary,
  RecoveryTimeseriesPoint,
  RiskMixItem,
  AiPerformanceMetrics,
  CaseSummary,
} from "../../../lib/types";

gsap.registerPlugin(useGSAP, ScrollTrigger);
gsap.defaults({ duration: 0.55, ease: "power3.out" });

/* ——— Small presentational helpers (no data logic) ——— */

function ScoreBars({ value }: { value: number }) {
  const lit = Math.round(Math.min(100, Math.max(0, value)) / 10);
  return (
    <span className="flex items-end gap-[3px]" aria-hidden="true">
      {Array.from({ length: 10 }).map((_, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full ${i < lit ? "bg-amber-300" : "bg-white/15"}`}
          style={{ height: 6 + (i % 4) * 3 }}
        />
      ))}
    </span>
  );
}

function Spark({
  values,
  stroke,
  title,
}: {
  values: number[];
  stroke: string;
  title?: string;
}) {
  if (!values || values.length < 2) return <span className="w-[72px] shrink-0" />;
  const w = 72;
  const h = 26;
  const p = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = p + (i / (values.length - 1)) * (w - 2 * p);
      const y = h - p - ((v - min) / span) * (h - 2 * p);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const [lx, ly] = pts.split(" ").pop()!.split(",");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="shrink-0 overflow-visible"
      role="img"
      aria-label={title}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lx} cy={ly} r={5} fill={stroke} opacity={0.25} />
      <circle cx={lx} cy={ly} r={2.6} fill={stroke} />
    </svg>
  );
}

function Gauge({ value }: { value: number }) {
  const v = Math.min(100, Math.max(0, value));
  const arc = Math.PI * 70; // half-circumference, r = 70
  const a = Math.PI * (1 - v / 100);
  const dx = 80 + 70 * Math.cos(a);
  const dy = 90 - 70 * Math.sin(a);
  return (
    <svg viewBox="0 0 160 100" className="w-full" role="img" aria-label={`Recovery score ${v}`}>
      <defs>
        <linearGradient id="fpGauge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#a3e635" />
        </linearGradient>
      </defs>
      <path
        d="M10,90 A70,70 0 0 1 150,90"
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth={14}
        strokeLinecap="round"
      />
      <path
        d="M10,90 A70,70 0 0 1 150,90"
        fill="none"
        stroke="url(#fpGauge)"
        strokeWidth={14}
        strokeLinecap="round"
        strokeDasharray={`${(v / 100) * arc} ${arc}`}
      />
      <circle cx={10} cy={90} r={7} fill="#1c1c1f" stroke="rgba(255,255,255,0.2)" strokeWidth={2} />
      <circle cx={dx} cy={dy} r={9} fill="#f4f4f5" />
      <circle cx={dx} cy={dy} r={9} fill="none" stroke="#34d399" strokeWidth={3} opacity={0.6} />
    </svg>
  );
}

function MiniMetric({
  tick,
  label,
  value,
  sub,
  redacted = false,
}: {
  tick: string;
  label: string;
  value: string;
  sub?: string;
  redacted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
      <span className={`h-9 w-[3px] shrink-0 rounded-full ${tick}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium text-white/55">{label}</p>
        {redacted ? (
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-amber-200/90">
            <ShieldAlert className="h-3 w-3" /> Redacted (Finance+)
          </p>
        ) : (
          <p className="mt-0.5 truncate text-[17px] font-semibold tracking-tight text-white tabular-nums">
            {value}
          </p>
        )}
        {sub && !redacted && (
          <p className="mt-0.5 truncate text-[10px] text-white/40">{sub}</p>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("30d");
  const [loading, setLoading] = useState<boolean>(true);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [timeseries, setTimeseries] = useState<RecoveryTimeseriesPoint[]>([]);
  const [riskMix, setRiskMix] = useState<RiskMixItem[]>([]);
  const [aiMetrics, setAiMetrics] = useState<AiPerformanceMetrics | null>(null);
  const [recentCases, setRecentCases] = useState<CaseSummary[]>([]);

  // Currency comes from /analytics/summary financial.currency; fall back to INR.
  const currency = summary?.currency ?? "INR";
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const now = new Date();
      const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
      const to = now.toISOString();

      const [sumRes, timeRes, mixRes, aiRes, casesRes] = await Promise.all([
        api.analytics.getSummary({ from, to }).catch(() => null),
        api.analytics.getRecoveryTimeseries({ from, to, bucket: "day" }).catch(() => ({ points: [] })),
        api.analytics.getRiskMix({ from, to }).catch(() => ({ mix: [] })),
        api.analytics.getAiPerformance({ from, to }).catch(() => null),
        api.cases.list({ limit: 6 }).catch(() => ({ items: [] })),
      ]);

      if (sumRes) setSummary(sumRes);
      if (timeRes?.points) setTimeseries(timeRes.points);
      if (mixRes?.mix) setRiskMix(mixRes.mix);
      if (aiRes) setAiMetrics(aiRes);
      if (casesRes?.items) setRecentCases(casesRes.items);
    } catch {
      // transient fetch handling
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add(
        {
          full: "(prefers-reduced-motion: no-preference)",
          reduced: "(prefers-reduced-motion: reduce)",
        },
        (ctx) => {
          if (ctx.conditions?.reduced) return;
          const q = gsap.utils.selector(containerRef);

          // Master timeline: frame -> header -> hero columns -> strip -> bottom cards.
          // Transforms + autoAlpha only; labels keep sequencing readable.
          const tl = gsap.timeline({
            defaults: { duration: 0.55, ease: "power3.out" },
          });
          tl.addLabel("frame", 0);
          tl.fromTo(
            q(".fp-frame"),
            { y: 14, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.5, clearProps: "transform" },
            "frame"
          );
          tl.fromTo(
            q(".fp-rise"),
            { y: 18, autoAlpha: 0 },
            {
              y: 0,
              autoAlpha: 1,
              duration: 0.5,
              stagger: { each: 0.07, from: "start" },
              clearProps: "transform",
            },
            "frame+=0.1"
          );

          // Scroll-linked reveal for the pipeline table — once.
          const batchTargets = q(".dash-reveal");
          if (batchTargets.length > 0) {
            ScrollTrigger.batch(batchTargets as Element[], {
              start: "top 90%",
              once: true,
              onEnter: (els) =>
                gsap.fromTo(
                  els as Element[],
                  { y: 22, autoAlpha: 0 },
                  {
                    y: 0,
                    autoAlpha: 1,
                    duration: 0.6,
                    stagger: { each: 0.08, from: "start" },
                    ease: "power3.out",
                    overwrite: true,
                    clearProps: "transform",
                  }
                ),
            });
          }
        }
      );

      return () => mm.revert();
    },
    { scope: containerRef }
  );

  /* ——— Derived series for sparklines (all from real timeseries data) ——— */
  const casesSeries = timeseries.map((p) => p.casesCount);
  const recoveredSeries = timeseries.map((p) => p.recoveredCasesCount);
  const openSeries = timeseries.map((p) => Math.max(0, p.casesCount - p.recoveredCasesCount));
  const rateSeries = timeseries.map((_, i) => {
    const slice = timeseries.slice(0, i + 1);
    const total = slice.reduce((s, p) => s + p.casesCount, 0);
    const rec = slice.reduce((s, p) => s + p.recoveredCasesCount, 0);
    return total > 0 ? (rec / total) * 100 : 0;
  });

  const recoveryRate = summary?.recoveryRate ?? 0;
  const autonomyRate = aiMetrics?.autonomyRate ?? 0;
  const escalated = summary?.escalatedCases ?? 0;
  const latency = aiMetrics?.averageDecisionLatencyMs
    ? `${(aiMetrics.averageDecisionLatencyMs / 1000).toFixed(2)}s`
    : "—";

  // Skeleton gates: initial load only (absent data). Refetches keep content.
  const showSummarySkeleton = loading && !summary;
  const showTimeseriesSkeleton = loading && timeseries.length === 0;
  const showRiskSkeleton = loading && riskMix.length === 0;
  const showAiSkeleton = loading && !aiMetrics;
  const showCasesSkeleton = loading && recentCases.length === 0;

  const rangeTabs = [
    { id: "7d" as const, label: "7D" },
    { id: "30d" as const, label: "30D" },
    { id: "90d" as const, label: "90D" },
  ];

  return (
    <div ref={containerRef}>
      {/* Outer frame */}
      <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-4 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-5">
        <div className="space-y-4">
          {/* Header bar */}
          <div className="fp-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-2 pt-1">
            <div className="min-w-52">
              <h1 className="text-[15px] font-semibold tracking-tight text-white">
                Revenue Recovery Performance
              </h1>
              <p className="mt-0.5 text-[11px] font-normal text-white/45">
                Real-time financial recovery telemetry &amp; AI performance
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              <ScoreBars value={autonomyRate} />
              <span className="text-sm font-bold text-white tabular-nums">
                {Math.round(autonomyRate)}
              </span>
              <span className="text-[11px] text-white/45">Autonomy Score</span>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-4 rounded-full border border-white/[0.08] bg-white/[0.03] px-4 py-1.5">
                {rangeTabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setRange(t.id)}
                    className={`cursor-pointer pb-0.5 text-[11px] font-medium transition-colors ${
                      range === t.id
                        ? "border-b-2 border-amber-400 font-bold text-white"
                        : "border-b-2 border-transparent text-white/45 hover:text-white"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => fetchData()}
                disabled={loading}
                title="Refresh"
                aria-label="Refresh dashboard data"
                className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </button>
              <Link
                href="/cases"
                title="Open cases"
                aria-label="Open cases"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          {/* Hero grid: totals + ember chart */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            {/* Left: total + 2x2 minis */}
            <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 lg:col-span-4">
              <p className="text-[11px] font-medium text-white/50">Total Recovered</p>
              {showSummarySkeleton ? (
                <>
                  <Skeleton className="mt-2 h-[30px] w-3/4" />
                  <Skeleton className="mt-2 h-5 w-28 rounded-full" />
                  <SkeletonCards count={4} className="mt-4" />
                </>
              ) : (
                <>
                  <div className="mt-1 flex flex-wrap items-center gap-2.5">
                    <p className="text-[30px] font-bold leading-none tracking-tight text-white tabular-nums">
                      {formatMoney(summary?.revenueRecovered ?? "0", currency)}
                    </p>
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-300/90 px-2 py-0.5 text-[11px] font-bold text-emerald-950">
                      <TrendingUp className="h-3 w-3" />
                      {formatPercent(recoveryRate)}
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-2">
                    <MiniMetric
                      tick="bg-rose-400"
                      label="Revenue at Risk"
                      value={formatMoney(summary?.revenueAtRisk ?? "0", currency, { compact: true })}
                      sub={formatMoney(summary?.revenueAtRisk ?? "0", currency)}
                    />
                    <MiniMetric
                      tick="bg-emerald-400"
                      label="Net Recovered"
                      value={
                        summary?.netRecovered !== null && summary?.netRecovered !== undefined
                          ? formatMoney(summary.netRecovered, currency, { compact: true })
                          : "—"
                      }
                      sub={
                        summary?.netRecovered !== null && summary?.netRecovered !== undefined
                          ? formatMoney(summary.netRecovered, currency)
                          : undefined
                      }
                      redacted={summary?.netRecovered === null}
                    />
                    <MiniMetric
                      tick="bg-orange-400"
                      label="Recovery Cost"
                      value={
                        summary?.recoveryCost !== null && summary?.recoveryCost !== undefined
                          ? formatMoney(summary.recoveryCost, currency, { compact: true })
                          : "—"
                      }
                      sub={
                        summary?.recoveryCost !== null && summary?.recoveryCost !== undefined
                          ? formatMoney(summary.recoveryCost, currency)
                          : undefined
                      }
                      redacted={summary?.recoveryCost === null}
                    />
                    <MiniMetric
                      tick="bg-emerald-300"
                      label="Active Cases"
                      value={(summary?.activeCases ?? 0).toLocaleString()}
                      sub="In recovery pipeline"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Right: ember hero chart */}
            <div className="fp-rise relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#f0521f] via-[#e84415] to-[#cf360b] p-5 lg:col-span-8">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_70%_0%,rgba(255,255,255,0.16),transparent_60%)]"
              />
              <div className="relative flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-medium text-white/75">Revenue at Risk</p>
                  {showSummarySkeleton ? (
                    <>
                      <Skeleton className="mt-2 h-[30px] w-56 max-w-full" />
                      <Skeleton className="mt-2 h-5 w-24 rounded-full" />
                    </>
                  ) : (
                    <div className="mt-1 flex flex-wrap items-center gap-2.5">
                      <p className="text-[30px] font-bold leading-none tracking-tight text-white tabular-nums">
                        {formatMoney(summary?.revenueAtRisk ?? "0", currency)}
                      </p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-bold text-orange-700">
                        <TrendingUp className="h-3 w-3" />
                        {formatPercent(recoveryRate)}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[10px] font-medium">
                  <span className="flex items-center gap-1.5 text-white/85">
                    <span className="h-1.5 w-1.5 rounded-full bg-white" /> At Risk
                  </span>
                  <span className="flex items-center gap-1.5 text-white/85">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#FFE14D]" /> Recovered
                  </span>
                </div>
              </div>

              <div className="relative mt-2">
                {showTimeseriesSkeleton ? (
                  <SkeletonChart height={258} />
                ) : (
                  <RecoveryTimeseriesChart data={timeseries} currency={currency} height={258} tone="ember" />
                )}
              </div>
            </div>
          </div>

          {/* Live pipeline strip */}
          <div className="fp-rise flex flex-col gap-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-[#131316]/90 px-2 py-1 sm:flex-row sm:items-stretch sm:divide-x sm:divide-white/[0.07]">
            <p className="shrink-0 px-3 py-3 text-[11px] font-medium text-white/45 sm:self-center">
              Live Pipeline
            </p>

            <div className="flex flex-1 items-center gap-3 px-3 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black">
                <Activity className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wider text-white/45">
                  Active
                </p>
                {showSummarySkeleton ? (
                  <Skeleton className="mt-1 h-4 w-24" />
                ) : (
                  <p className="text-sm font-semibold text-white tabular-nums">
                    {(summary?.activeCases ?? 0).toLocaleString()}{" "}
                    <span className="text-[11px] font-medium text-emerald-300">· live</span>
                  </p>
                )}
              </div>
              <span className="ml-auto">
                {showTimeseriesSkeleton ? (
                  <Skeleton className="h-[26px] w-[72px] rounded-md" />
                ) : (
                  <Spark values={casesSeries} stroke="#34d399" title="Active cases trend" />
                )}
              </span>
            </div>

            <div className="flex flex-1 items-center gap-3 px-3 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wider text-white/45">
                  Escalated
                </p>
                {showSummarySkeleton ? (
                  <Skeleton className="mt-1 h-4 w-24" />
                ) : (
                  <p className="text-sm font-semibold text-white tabular-nums">
                    {escalated.toLocaleString()}{" "}
                    <span className={`text-[11px] font-medium ${escalated > 0 ? "text-rose-300" : "text-white/40"}`}>
                      · {escalated > 0 ? "needs review" : "clear"}
                    </span>
                  </p>
                )}
              </div>
              <span className="ml-auto">
                {showTimeseriesSkeleton ? (
                  <Skeleton className="h-[26px] w-[72px] rounded-md" />
                ) : (
                  <Spark values={openSeries} stroke={escalated > 0 ? "#fb7185" : "#71717a"} title="Open backlog trend" />
                )}
              </span>
            </div>

            <div className="flex flex-1 items-center gap-3 px-3 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black">
                <CheckCircle2 className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wider text-white/45">
                  Recovered
                </p>
                {showSummarySkeleton ? (
                  <Skeleton className="mt-1 h-4 w-24" />
                ) : (
                  <p className="text-sm font-semibold text-white tabular-nums">
                    {(summary?.recoveredCases ?? 0).toLocaleString()}{" "}
                    <span className="text-[11px] font-medium text-emerald-300">
                      · {formatPercent(recoveryRate)}
                    </span>
                  </p>
                )}
              </div>
              <span className="ml-auto">
                {showTimeseriesSkeleton ? (
                  <Skeleton className="h-[26px] w-[72px] rounded-md" />
                ) : (
                  <Spark values={recoveredSeries} stroke="#34d399" title="Recovered cases trend" />
                )}
              </span>
            </div>

            <div className="flex flex-1 items-center gap-3 px-3 py-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black">
                <TrendingUp className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-wider text-white/45">
                  Rec. Rate
                </p>
                {showSummarySkeleton ? (
                  <Skeleton className="mt-1 h-4 w-24" />
                ) : (
                  <p className="text-sm font-semibold text-white tabular-nums">
                    {formatPercent(recoveryRate)}{" "}
                    <span className="text-[11px] font-medium text-emerald-300">· cumulative</span>
                  </p>
                )}
              </div>
              <span className="ml-auto">
                {showTimeseriesSkeleton ? (
                  <Skeleton className="h-[26px] w-[72px] rounded-md" />
                ) : (
                  <Spark values={rateSeries} stroke="#a3e635" title="Cumulative recovery rate trend" />
                )}
              </span>
            </div>

            <Link
              href="/cases"
              aria-label="View all cases"
              className="m-2 flex items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] px-3 text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white sm:w-10 sm:px-0"
            >
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>

          {/* Bottom trio */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            {/* Risk mix */}
            <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 lg:col-span-5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
                    <Layers className="h-4 w-4 text-white/60" />
                    Risk Surface Mix
                  </h2>
                  <p className="mt-0.5 text-[11px] font-normal text-white/45">
                    Breakdown across payment failure, checkout &amp; invoice surfaces
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {showRiskSkeleton ? (
                    <Skeleton className="h-6 w-20 rounded-full" />
                  ) : (
                    <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-white/55">
                      {riskMix.length} segments
                    </span>
                  )}
                  <Link
                    href="/risk"
                    aria-label="Open risk engine"
                    className="flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
              <div className="mt-4">
                {showRiskSkeleton ? (
                  <SkeletonChart height={280} />
                ) : (
                  <RiskMixChart mix={riskMix} currency={currency} />
                )}
              </div>
            </div>

            {/* Recovery score gauge */}
            <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 lg:col-span-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold tracking-tight text-white">Recovery Score</h2>
                <Link
                  href="/recovery"
                  aria-label="Open recovery"
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              <p className="mt-2 text-[26px] font-bold tracking-tight text-white tabular-nums">
                {Math.round(recoveryRate)}
                <span className="text-sm font-medium text-white/40"> /100</span>
              </p>
              <div className="mx-auto mt-1 max-w-56">
                <Gauge value={recoveryRate} />
              </div>
              <p className="mt-1 text-center text-[11px] text-white/45">
                {(summary?.recoveredCases ?? 0).toLocaleString()} cases recovered · {range.toUpperCase()} range
              </p>
            </div>

            {/* AI engine */}
            <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 lg:col-span-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
                  <Sparkles className="h-4 w-4 text-white/60" />
                  AI Decision Engine
                </h2>
                <Link
                  href="/tasks"
                  aria-label="Review tasks"
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.03] text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              {showAiSkeleton ? (
                <>
                  <Skeleton className="mt-2.5 h-4 w-full" />
                  <Skeleton className="mt-2 h-4 w-11/12" />
                  <Skeleton className="mt-2 h-4 w-2/3" />
                  <SkeletonStats count={4} className="mt-3 border-t border-white/[0.06] pt-1" />
                </>
              ) : (
                <>
                  <p className="mt-2.5 text-[13px] leading-relaxed text-white/70">
                    AI generated{" "}
                    <span className="font-semibold text-white">
                      {(aiMetrics?.totalRecommendations ?? 0).toLocaleString()} recommendations
                    </span>{" "}
                    · {(aiMetrics?.policyRejections ?? 0).toLocaleString()} blocked by policy ·{" "}
                    {(aiMetrics?.humanApprovals ?? 0).toLocaleString()} human-approved · avg decision{" "}
                    <span className="font-semibold text-white">{latency}</span> · autonomy{" "}
                    <span className="font-semibold text-white">{formatPercent(autonomyRate)}</span>.
                  </p>
                  <div className="mt-3 divide-y divide-white/[0.06] border-t border-white/[0.06]">
                    <div className="flex items-center justify-between gap-2 py-2">
                      <span className="text-[11px] text-white/50">AI Recommendations</span>
                      <span className="text-sm font-semibold text-white tabular-nums">
                        {(aiMetrics?.totalRecommendations ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-2">
                      <span className="text-[11px] text-white/50">Policy Rejections</span>
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white tabular-nums">
                          {(aiMetrics?.policyRejections ?? 0).toLocaleString()}
                        </span>
                        <Badge variant="danger" size="sm">Enforced</Badge>
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-2">
                      <span className="text-[11px] text-white/50">Human Approvals</span>
                      <span className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white tabular-nums">
                          {(aiMetrics?.humanApprovals ?? 0).toLocaleString()}
                        </span>
                        <Badge variant="info" size="sm">Audited</Badge>
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 py-2">
                      <span className="text-[11px] text-white/50">Avg Decision Latency</span>
                      <span className="text-sm font-semibold text-white tabular-nums">{latency}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Pipeline table (content unchanged) */}
          <div className="dash-reveal rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-3.5">
              <div>
                <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
                  <Activity className="h-4 w-4 text-white/60" />
                  Active Recovery Pipeline
                </h2>
                <p className="mt-0.5 text-[11px] font-normal text-white/45">
                  Live cases undergoing autonomous intervention or human review
                </p>
              </div>
              <Link
                href="/cases"
                className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300 transition-colors hover:text-emerald-200"
              >
                <span>View All Cases</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>

            {showCasesSkeleton ? (
              <SkeletonTable rows={6} cols={6} className="mt-4" />
            ) : recentCases.length === 0 ? (
              <div className="py-8 text-center text-xs text-white/40">
                No recovery cases found in database
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/[0.06] font-semibold uppercase text-[10px] text-white/45">
                    <tr>
                      <th className="py-2.5 pr-4">Case #</th>
                      <th className="py-2.5 px-4">Risk Surface</th>
                      <th className="py-2.5 px-4 text-right">Amount at Risk</th>
                      <th className="py-2.5 px-4">Status</th>
                      <th className="py-2.5 px-4">Opened</th>
                      <th className="py-2.5 pl-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
                    {recentCases.map((c) => {
                      const statusStyle = getCaseStatusColor(c.status);
                      return (
                        <tr key={c.id} className="transition-colors hover:bg-white/[0.04]">
                          <td className="py-3 pr-4 font-bold text-white">
                            {c.case_number}
                          </td>
                          <td className="py-3 px-4 font-sans text-white/75">
                            {c.risk_type.replace(/_/g, " ")}
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-white tabular-nums">
                            {formatMoney(c.amount_at_risk, c.currency)}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold border ${statusStyle.bg} ${statusStyle.text} ${statusStyle.border}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                              {c.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-[11px] text-white/45">
                            {formatDate(c.opened_at)}
                          </td>
                          <td className="py-3 pl-4 text-right">
                            <Link
                              href={`/cases/${c.id}`}
                              className="inline-flex items-center gap-1 font-sans text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                            >
                              <span>Open Detail</span>
                              <ArrowUpRight className="h-3 w-3" />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
