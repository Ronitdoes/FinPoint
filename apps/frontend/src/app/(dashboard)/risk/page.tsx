"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  AlertTriangle,
  RefreshCw,
  ChevronRight,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Button } from "../../../components/ui/Button";
import { Select } from "../../../components/ui/Select";
import { Modal } from "../../../components/ui/Modal";
import { SkeletonTable } from "../../../components/ui/Skeleton";
import { RiskFactorBreakdown } from "../../../components/risk/RiskFactorBreakdown";
import { formatDate, getRiskBandColor } from "../../../lib/format";
import { api } from "../../../lib/api";
import type { RiskEvaluationItem } from "../../../lib/types";

gsap.registerPlugin(useGSAP, ScrollTrigger);

export default function RiskPage() {
  const [risks, setRisks] = useState<RiskEvaluationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);

  // Filters
  const [bandFilter, setBandFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  // Factor Drill-down Modal
  const [selectedRisk, setSelectedRisk] = useState<RiskEvaluationItem | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const fetchRisks = useCallback(
    async (cursor?: string, append = false) => {
      try {
        setLoading(true);
        const res = await api.risks.list({
          band: bandFilter || undefined,
          risk_type: typeFilter || undefined,
          status: statusFilter || undefined,
          limit: 25,
          cursor,
        });

        if (append) {
          setRisks((prev) => [...prev, ...res.items]);
        } else {
          setRisks(res.items);
        }
        setNextCursor(res.nextCursor);
      } catch {
        // error handling
      } finally {
        setLoading(false);
      }
    },
    [bandFilter, typeFilter, statusFilter],
  );

  useEffect(() => {
    fetchRisks();
  }, [fetchRisks]);

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

          // Master timeline: frame -> header/filter panels -> scroll-linked table.
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

          // Scroll-linked reveal for the risks table — once.
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
            <AlertTriangle className="h-4 w-4 text-white/60" />
            Risk Intelligence & Explainability Engine
          </h1>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
            Real-time multi-factor revenue risk evaluations and calibrated risk bands
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          loading={loading}
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => fetchRisks()}
        >
          Refresh Risks
        </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select
            label="Risk Band"
            value={bandFilter}
            onChange={(e) => setBandFilter(e.target.value)}
            options={[
              { value: "", label: "All Bands (Critical to Low)" },
              { value: "CRITICAL", label: "CRITICAL (Score ≥ 85)" },
              { value: "HIGH", label: "HIGH (Score 60–84)" },
              { value: "MEDIUM", label: "MEDIUM (Score 40–59)" },
              { value: "LOW", label: "LOW (Score < 40)" },
            ]}
          />

          <Select
            label="Risk Surface / Type"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            options={[
              { value: "", label: "All Surfaces" },
              { value: "FAILED_PAYMENT", label: "Failed Payment" },
              { value: "CHECKOUT_ABANDONED", label: "Checkout Abandonment" },
              { value: "OVERDUE_INVOICE", label: "Overdue Invoice" },
              { value: "DISPUTE_RISK", label: "Dispute Risk" },
              { value: "SUBSCRIPTION_CHURN", label: "Subscription Churn" },
            ]}
          />

          <Select
            label="Evaluation Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: "", label: "All Evaluation Statuses" },
              { value: "ACTIVE", label: "ACTIVE" },
              { value: "RESOLVED", label: "RESOLVED" },
              { value: "EXPIRED", label: "EXPIRED" },
            ]}
          />
        </div>
      </div>

      {/* Risks Table */}
      <div className="dash-reveal rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 min-h-[320px]">
        {loading && risks.length === 0 ? (
          <SkeletonTable rows={6} cols={7} />
        ) : risks.length === 0 ? (
          <div className="py-16 text-center text-xs text-white/40">
            <AlertTriangle className="mx-auto h-7 w-7 mb-2 opacity-30 text-white/30" />
            No risk evaluations found matching filter criteria
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className={`w-full text-left text-xs transition-opacity duration-200 ${loading ? "opacity-60" : "opacity-100"}`}>
              <thead className="border-b border-white/[0.06] font-semibold uppercase text-[10px] text-white/45">
                <tr>
                  <th className="py-3 px-4">Customer ID</th>
                  <th className="py-3 px-4">Risk Surface</th>
                  <th className="py-3 px-4">Risk Band</th>
                  <th className="py-3 px-4 text-right">Score</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Computed At</th>
                  <th className="py-3 px-4 text-right">Factor Drill-Down</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
                {risks.map((r) => {
                  const bandStyles = getRiskBandColor(r.band);
                  return (
                    <tr key={r.id} className="transition-colors hover:bg-white/[0.04]">
                      <td className="py-3 px-4 font-sans font-medium truncate max-w-[140px] text-[11px] text-white/75" title={r.customer_id}>
                        {r.customer_id}
                      </td>
                      <td className="py-3 px-4 font-sans font-medium text-xs text-white/75">
                        {r.risk_type.replace(/_/g, " ")}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${bandStyles.bg} ${bandStyles.text} ${bandStyles.border}`}
                        >
                          {r.band}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-white tabular-nums">
                        {r.score}/100
                      </td>
                      <td className="py-3 px-4">
                        <span className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-0.5 text-[10px] text-white/70">
                          {r.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-[11px] text-white/45">
                        {formatDate(r.computed_at)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedRisk(r)}
                        >
                          <span className="font-sans font-semibold text-xs text-cyan-300">Explain</span>
                          <ChevronRight className="h-3 w-3 text-cyan-300" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && (
          <div className="mt-4 border-t border-white/[0.06] pt-4 text-center">
            <Button
              variant="outline"
              size="sm"
              loading={loading}
              onClick={() => fetchRisks(nextCursor, true)}
            >
              Load Next Page
            </Button>
          </div>
        )}
      </div>

      {/* Factor Drill-down Explainability Modal */}
      {selectedRisk && (
        <Modal
          isOpen={!!selectedRisk}
          onClose={() => setSelectedRisk(null)}
          title="Risk Factor Explainability Breakdown"
          description={`Evaluation ID: ${selectedRisk.id} • Band: ${selectedRisk.band} (${selectedRisk.score}/100)`}
          maxWidth="2xl"
          footer={
            <Button variant="primary" onClick={() => setSelectedRisk(null)}>
              Done
            </Button>
          }
        >
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3 text-xs font-mono text-white/55">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/40">Customer</div>
                <div className="mt-0.5 truncate font-sans font-medium text-white" title={selectedRisk.customer_id}>
                  {selectedRisk.customer_id}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/40">Surface</div>
                <div className="mt-0.5 font-sans font-medium text-white">
                  {selectedRisk.risk_type.replace(/_/g, " ")}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-white/40">Evaluated</div>
                <div className="mt-0.5 font-sans font-medium text-white">
                  {formatDate(selectedRisk.computed_at)}
                </div>
              </div>
            </div>

            <RiskFactorBreakdown factors={selectedRisk.factors} />
          </div>
        </Modal>
      )}
        </div>
      </div>
    </div>
  );
}
