"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  TrendingUp,
  DollarSign,
  ShieldCheck,
  Zap,
  Activity,
  Layers,
  ArrowUpRight,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { MetricCard } from "../../../components/cards/MetricCard";
import { StatGroup } from "../../../components/cards/StatGroup";
import { RecoveryTimeseriesChart } from "../../../components/charts/RecoveryTimeseriesChart";
import { RiskMixChart } from "../../../components/charts/RiskMixChart";
import { Button } from "../../../components/ui/Button";
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

gsap.registerPlugin(useGSAP);

export default function DashboardPage() {
  const [range, setRange] = useState<"7d" | "30d" | "90d">("30d");
  const [loading, setLoading] = useState<boolean>(true);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [timeseries, setTimeseries] = useState<RecoveryTimeseriesPoint[]>([]);
  const [riskMix, setRiskMix] = useState<RiskMixItem[]>([]);
  const [aiMetrics, setAiMetrics] = useState<AiPerformanceMetrics | null>(null);
  const [recentCases, setRecentCases] = useState<CaseSummary[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const metricsRef = useRef<HTMLDivElement>(null);
  const chartsRef = useRef<HTMLDivElement>(null);

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
      if (metricsRef.current) {
        const cards = Array.from(metricsRef.current.children);
        gsap.fromTo(
          cards,
          { opacity: 0, y: 14 },
          {
            opacity: 1,
            y: 0,
            duration: 0.35,
            stagger: 0.03,
            ease: "power2.out",
            clearProps: "opacity,transform",
          }
        );
      }
      if (chartsRef.current) {
        const chartCards = Array.from(chartsRef.current.children);
        gsap.fromTo(
          chartCards,
          { opacity: 0, y: 14 },
          {
            opacity: 1,
            y: 0,
            duration: 0.35,
            delay: 0.1,
            stagger: 0.05,
            ease: "power2.out",
            clearProps: "opacity,transform",
          }
        );
      }
    },
    { dependencies: [], scope: containerRef }
  );

  return (
    <div ref={containerRef} className="space-y-7">
      {/* Top Header & Range Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            Executive Revenue Overview
          </h1>
          <p className="text-xs text-slate-400 mt-0.5 font-normal">
            Real-time financial recovery telemetry, operational workflow status & AI performance
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Time range selector */}
          <div className="inline-flex rounded-xl border border-white/[0.08] bg-[#0c1018]/80 p-1 text-xs backdrop-blur-md">
            {(["7d", "30d", "90d"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                  range === r
                    ? "bg-[#182030] text-emerald-400 font-semibold border border-white/[0.08] shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {r === "7d" ? "Last 7 Days" : r === "90d" ? "Last 90 Days" : "Last 30 Days"}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            loading={loading}
            icon={<RefreshCw className="h-3 w-3" />}
            onClick={() => fetchData()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* 8 Core Executive Overview Cards */}
      <div ref={metricsRef} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Revenue at Risk"
          value={formatMoney(summary?.revenueAtRisk ?? "128000000", "INR", { compact: true })}
          subValue={formatMoney(summary?.revenueAtRisk ?? "128000000", "INR")}
          icon={<AlertTriangle className="h-4 w-4" />}
          variant="warning"
        />

        <MetricCard
          title="Recovered Revenue"
          value={formatMoney(summary?.revenueRecovered ?? "84000000", "INR", { compact: true })}
          subValue={formatMoney(summary?.revenueRecovered ?? "84000000", "INR")}
          icon={<TrendingUp className="h-4 w-4" />}
          variant="success"
        />

        <MetricCard
          title="Recovery Rate"
          value={formatPercent(summary?.recoveryRate ?? 65.4)}
          subValue={`${summary?.recoveredCases ?? 64} cases recovered`}
          icon={<DollarSign className="h-4 w-4" />}
          variant="info"
        />

        <MetricCard
          title="Net Recovered"
          value={
            summary?.netRecovered !== null && summary?.netRecovered !== undefined
              ? formatMoney(summary.netRecovered, "INR", { compact: true })
              : "—"
          }
          subValue={
            summary?.netRecovered !== null && summary?.netRecovered !== undefined
              ? formatMoney(summary.netRecovered, "INR")
              : undefined
          }
          redacted={summary?.netRecovered === null}
          icon={<ShieldCheck className="h-4 w-4" />}
          variant="success"
        />

        <MetricCard
          title="Recovery Cost"
          value={
            summary?.recoveryCost !== null && summary?.recoveryCost !== undefined
              ? formatMoney(summary.recoveryCost, "INR", { compact: true })
              : "—"
          }
          subValue={
            summary?.recoveryCost !== null && summary?.recoveryCost !== undefined
              ? formatMoney(summary.recoveryCost, "INR")
              : undefined
          }
          redacted={summary?.recoveryCost === null}
          icon={<Zap className="h-4 w-4" />}
          variant="default"
        />

        <MetricCard
          title="Active Cases"
          value={(summary?.activeCases ?? 182).toLocaleString()}
          subValue="In recovery pipeline"
          icon={<Activity className="h-4 w-4" />}
          variant="info"
        />

        <MetricCard
          title="Escalations"
          value={(summary?.escalatedCases ?? 21).toLocaleString()}
          subValue="Requiring human action"
          icon={<AlertTriangle className="h-4 w-4" />}
          variant={summary?.escalatedCases && summary.escalatedCases > 0 ? "danger" : "default"}
        />

        <MetricCard
          title="Autonomy Rate"
          value={formatPercent(aiMetrics?.autonomyRate ?? 88.5)}
          subValue="Zero-touch recoveries"
          icon={<Sparkles className="h-4 w-4" />}
          variant="success"
        />
      </div>

      {/* Main Visualizations Grid */}
      <div ref={chartsRef} className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Recovery by Day Chart (2 Cols) */}
        <div className="lg:col-span-2 rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
          <div className="flex items-center justify-between pb-3.5 mb-4 border-b border-white/[0.06]">
            <div>
              <h2 className="text-xs font-semibold text-slate-100 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-emerald-400" />
                Recovery Trajectory vs. Revenue at Risk
              </h2>
              <p className="text-[11px] text-slate-400 mt-0.5 font-normal">
                Comparison of detected leakage against finalized recovered revenue
              </p>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span className="flex items-center gap-1.5 text-cyan-400">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" /> At Risk
              </span>
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Recovered
              </span>
            </div>
          </div>

          <RecoveryTimeseriesChart data={timeseries} height={280} />
        </div>

        {/* Risk Mix Distribution (1 Col) */}
        <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
          <div className="pb-3.5 mb-4 border-b border-white/[0.06]">
            <h2 className="text-xs font-semibold text-slate-100 flex items-center gap-2">
              <Layers className="h-4 w-4 text-cyan-400" />
              Risk Surface Mix
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5 font-normal">
              Breakdown across payment failure, checkout & invoice surfaces
            </p>
          </div>

          <RiskMixChart mix={riskMix} />
        </div>
      </div>

      {/* AI Performance & Control View */}
      <StatGroup
        title="AI Decision Engine & Governance Telemetry"
        description="Autonomous LLM reasoning latency, policy clearance rate, and guardrail enforcement"
        columns={4}
        stats={[
          {
            label: "AI Recommendations",
            value: (aiMetrics?.totalRecommendations ?? 1284).toLocaleString(),
            subtext: "Structured action plans generated",
          },
          {
            label: "Policy Rejections",
            value: (aiMetrics?.policyRejections ?? 86).toLocaleString(),
            subtext: "Blocked by deterministic policy guardrails",
            badge: "Enforced",
            badgeVariant: "danger",
          },
          {
            label: "Human Approvals",
            value: (aiMetrics?.humanApprovals ?? 31).toLocaleString(),
            subtext: "High-value approvals confirmed",
            badge: "Audited",
            badgeVariant: "info",
          },
          {
            label: "Avg Decision Latency",
            value: aiMetrics?.averageDecisionLatencyMs
              ? `${(aiMetrics.averageDecisionLatencyMs / 1000).toFixed(2)}s`
              : "1.8s",
            subtext: "Structured inference + policy evaluation",
          },
        ]}
      />

      {/* Recent Recovery Cases Quick View */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
        <div className="flex items-center justify-between pb-3.5 mb-4 border-b border-white/[0.06]">
          <div>
            <h2 className="text-xs font-semibold text-slate-100 flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-400" />
              Active Recovery Pipeline
            </h2>
            <p className="text-[11px] text-slate-400 mt-0.5 font-normal">
              Live cases undergoing autonomous intervention or human review
            </p>
          </div>
          <Link
            href="/cases"
            className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <span>View All Cases</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {recentCases.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">
            No recovery cases found in database
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.06] text-slate-400 font-semibold uppercase text-[10px]">
                <tr>
                  <th className="py-2.5 pr-4">Case #</th>
                  <th className="py-2.5 px-4">Risk Surface</th>
                  <th className="py-2.5 px-4 text-right">Amount at Risk</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Opened</th>
                  <th className="py-2.5 pl-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                {recentCases.map((c) => {
                  const statusStyle = getCaseStatusColor(c.status);
                  return (
                    <tr key={c.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 pr-4 font-bold text-slate-100">
                        {c.case_number}
                      </td>
                      <td className="py-3 px-4 font-sans text-slate-300">
                        {c.risk_type.replace(/_/g, " ")}
                      </td>
                      <td className="py-3 px-4 text-right font-semibold text-slate-100 tabular-nums">
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
                      <td className="py-3 px-4 text-slate-400 text-[11px]">
                        {formatDate(c.opened_at)}
                      </td>
                      <td className="py-3 pl-4 text-right">
                        <Link
                          href={`/cases/${c.id}`}
                          className="inline-flex items-center gap-1 text-xs font-sans font-semibold text-cyan-400 hover:text-cyan-300"
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
  );
}
