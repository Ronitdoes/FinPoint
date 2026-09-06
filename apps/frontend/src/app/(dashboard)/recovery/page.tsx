"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  TrendingUp,
  Layers,
  RefreshCw,
  Zap,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { RecoveryFunnelChart } from "../../../components/charts/RecoveryFunnelChart";
import { InterventionSuccessChart } from "../../../components/charts/InterventionSuccessChart";
import { StatGroup } from "../../../components/cards/StatGroup";
import { Button } from "../../../components/ui/Button";
import { SkeletonCards, SkeletonChart } from "../../../components/ui/Skeleton";
import { formatPercent } from "../../../lib/format";
import { api } from "../../../lib/api";
import type {
  FunnelStage,
  InterventionStat,
  AiPerformanceMetrics,
} from "../../../lib/types";

gsap.registerPlugin(useGSAP, ScrollTrigger);

export default function RecoveryPage() {
  const [funnelStages, setFunnelStages] = useState<FunnelStage[]>([]);
  const [interventions, setInterventions] = useState<InterventionStat[]>([]);
  const [aiMetrics, setAiMetrics] = useState<AiPerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);

  const fetchAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      const [funnelRes, intRes, aiRes] = await Promise.all([
        api.analytics.getFunnel().catch(() => ({ stages: [] })),
        api.analytics.getInterventions().catch(() => ({ stats: [] })),
        api.analytics.getAiPerformance().catch(() => null),
      ]);

      if (funnelRes?.stages) setFunnelStages(funnelRes.stages);
      if (intRes?.stats) setInterventions(intRes.stats);
      if (aiRes) setAiMetrics(aiRes);
    } catch {
      // error handling
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

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

          // Master timeline: frame -> funnel/intervention panels -> scroll-linked stats.
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

          // Scroll-linked reveal for the lower stats panel — once.
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

  return (
    <div ref={containerRef}>
      {/* Outer frame */}
      <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="space-y-3">
      {/* Header */}
      <div className="fp-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-2 pt-1">
        <div className="min-w-52">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-white">
            <TrendingUp className="h-4 w-4 text-white/60" />
            Recovery Funnel & Intervention Analytics
          </h1>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
            Conversion stages, channel efficacy, and intervention success rates
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          loading={loading}
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => fetchAnalytics()}
        >
          Refresh Analytics
        </Button>
        </div>
      </div>

      {/* 5-Stage Recovery Funnel Section */}
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
        <div className="border-b border-white/[0.06] pb-3.5">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
            <Layers className="h-4 w-4 text-white/60" />
            5-Stage End-to-End Recovery Progression
          </h2>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
            Stage conversion from initial revenue leakage detection to finalized recovery settlement
          </p>
        </div>

        <div className="mt-4">
        {loading && funnelStages.length === 0 ? (
          <SkeletonChart height={280} />
        ) : (
          <RecoveryFunnelChart stages={funnelStages} />
        )}
        </div>
      </div>

      {/* Intervention Performance Table */}
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
        <div className="border-b border-white/[0.06] pb-3.5">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
            <Zap className="h-4 w-4 text-white/60" />
            Intervention Channel Performance & Success Rates
          </h2>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
            Detailed efficacy breakdown for payment retries, WhatsApp, email, links, and incentives
          </p>
        </div>

        <div className="mt-4">
        {loading && interventions.length === 0 ? (
          <SkeletonChart height={280} />
        ) : (
          <InterventionSuccessChart stats={interventions} />
        )}
        </div>
      </div>

      {/* AI Decisioning & Policy Rejection Panel */}
      <div className="dash-reveal">
      {loading && !aiMetrics ? (
        <SkeletonCards count={4} className="lg:grid-cols-4" />
      ) : (
        <StatGroup
        title="AI Autonomy & Policy Rejection Governance"
        description="Autonomous recommendation volume and hard policy rejection rates"
        columns={4}
        stats={[
          {
            label: "AI Recommendations",
            value: (aiMetrics?.totalRecommendations ?? 0).toLocaleString(),
            subtext: "Generated by LLM decisioning",
          },
          {
            label: "Policy Rejections",
            value: (aiMetrics?.policyRejections ?? 0).toLocaleString(),
            subtext: "Prohibited by safety bounds",
            badge: "Protected",
            badgeVariant: "danger",
          },
          {
            label: "Autonomy Rate",
            value: formatPercent(aiMetrics?.autonomyRate ?? 0),
            subtext: "Executions without manual touches",
            badge: "Autonomous",
            badgeVariant: "success",
          },
          {
            label: "Fallback Invocations",
            value: (aiMetrics?.fallbackCount ?? 0).toLocaleString(),
            subtext: "Rule-based fallback triggers",
            badge: "Deterministic",
            badgeVariant: "warning",
          },
        ]}
        />
      )}
      </div>
        </div>
      </div>
    </div>
  );
}
