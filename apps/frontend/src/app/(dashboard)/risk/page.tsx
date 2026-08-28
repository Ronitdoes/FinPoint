"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  AlertTriangle,
  RefreshCw,
  ChevronRight,
  Loader2,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Select } from "../../../components/ui/Select";
import { Modal } from "../../../components/ui/Modal";
import { formatDate, getRiskBandColor } from "../../../lib/format";
import { api } from "../../../lib/api";
import type { RiskEvaluationItem } from "../../../lib/types";

gsap.registerPlugin(useGSAP);

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
      if (containerRef.current) {
        const sections = Array.from(containerRef.current.children);
        gsap.fromTo(
          sections,
          { opacity: 0, y: 12 },
          {
            opacity: 1,
            y: 0,
            duration: 0.35,
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
    <div ref={containerRef} className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-400" />
            Risk Intelligence & Explainability Engine
          </h1>
          <p className="text-xs text-slate-400 mt-0.5 font-normal">
            Real-time multi-factor revenue risk evaluations and calibrated risk bands
          </p>
        </div>

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

      {/* Filter Bar */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-4 shadow-lg shadow-black/40 backdrop-blur-xl">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Select
            label="Risk Band"
            value={bandFilter}
            onChange={(e) => setBandFilter(e.target.value)}
            options={[
              { value: "", label: "All Bands (Critical to Low)" },
              { value: "CRITICAL", label: "CRITICAL (Score ≥ 80)" },
              { value: "HIGH", label: "HIGH (Score 60–79)" },
              { value: "MEDIUM", label: "MEDIUM (Score 30–59)" },
              { value: "LOW", label: "LOW (Score < 30)" },
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
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 shadow-lg shadow-black/40 overflow-hidden backdrop-blur-xl min-h-[320px] flex flex-col justify-center">
        {loading && risks.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-400">
            <Loader2 className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-[11px] font-medium text-slate-400">Loading risk evaluations...</span>
          </div>
        ) : risks.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-500">
            <AlertTriangle className="mx-auto h-7 w-7 mb-2 opacity-30 text-amber-400" />
            No risk evaluations found matching filter criteria
          </div>
        ) : (
          <div className="overflow-x-auto self-stretch">
            <table className={`w-full text-left text-xs transition-opacity duration-200 ${loading ? "opacity-60" : "opacity-100"}`}>
              <thead className="border-b border-white/[0.06] bg-[#090c13]/50 text-slate-400 font-semibold uppercase text-[10px]">
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
              <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                {risks.map((r) => {
                  const bandStyles = getRiskBandColor(r.band);
                  return (
                    <tr key={r.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 px-4 font-sans text-slate-300 font-medium truncate max-w-[140px] text-[11px]" title={r.customer_id}>
                        {r.customer_id}
                      </td>
                      <td className="py-3 px-4 font-sans font-medium text-slate-200 text-xs">
                        {r.risk_type.replace(/_/g, " ")}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${bandStyles.bg} ${bandStyles.text} ${bandStyles.border}`}
                        >
                          {r.band}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-slate-100 tabular-nums">
                        {r.score}/100
                      </td>
                      <td className="py-3 px-4">
                        <span className="rounded-md bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 text-[10px] text-slate-300">
                          {r.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-400 text-[11px]">
                        {formatDate(r.computed_at)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedRisk(r)}
                        >
                          <span className="font-sans font-semibold text-cyan-400 text-xs">Explain</span>
                          <ChevronRight className="h-3 w-3 text-cyan-400" />
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
          <div className="p-4 border-t border-white/[0.06] text-center">
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
          footer={
            <Button variant="primary" onClick={() => setSelectedRisk(null)}>
              Done
            </Button>
          }
        >
          <div className="space-y-4 text-xs">
            <div className="rounded-xl border border-white/[0.06] bg-[#090c13] p-3 text-xs space-y-1 font-mono">
              <div>Customer: <span className="text-slate-200">{selectedRisk.customer_id}</span></div>
              <div>Surface: <span className="text-slate-200">{selectedRisk.risk_type}</span></div>
              <div>Evaluated: <span className="text-slate-200">{formatDate(selectedRisk.computed_at)}</span></div>
            </div>

            <h4 className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">
              Contributing Factors & Rule Contributions
            </h4>

            <div className="space-y-2 text-xs font-mono">
              {selectedRisk.factors && Object.keys(selectedRisk.factors).length > 0 ? (
                Object.entries(selectedRisk.factors).map(([key, val]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between p-2.5 rounded-xl border border-white/[0.06] bg-[#090c13]/70"
                  >
                    <span className="font-sans font-medium text-slate-300 capitalize text-xs">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span className="text-cyan-400 font-bold tabular-nums">
                      {typeof val === "object" ? JSON.stringify(val) : String(val)}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-slate-500 italic text-xs">No specific factor breakdown stored</p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
