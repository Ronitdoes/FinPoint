"use client";

import React, { useEffect, useState, useRef, use, useCallback } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Pause,
  Play,
  ArrowUpRight,
  Octagon,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../../components/ui/Button";
import { DecisionCard } from "../../../../components/cases/DecisionCard";
import { PolicyVerdictCard } from "../../../../components/cases/PolicyVerdictCard";
import { ActionsLedger } from "../../../../components/cases/ActionsLedger";
import { OutcomeCard } from "../../../../components/cases/OutcomeCard";
import { RiskFactorsCard } from "../../../../components/cases/RiskFactorsCard";
import { CaseTimeline } from "../../../../components/timeline/CaseTimeline";
import { CaseControlModal } from "../../../../components/modals/CaseControlModals";
import { formatMoney } from "../../../../lib/money";
import { formatDate, getCaseStatusColor } from "../../../../lib/format";
import { canPauseResume, canEscalate, canStop } from "../../../../lib/rbac";
import { api } from "../../../../lib/api";
import type { CanonicalCaseDetail, AuthMeResponse } from "../../../../lib/types";

gsap.registerPlugin(useGSAP);

export default function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [caseDetail, setCaseDetail] = useState<CanonicalCaseDetail | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal control state
  const [modalAction, setModalAction] = useState<"PAUSE" | "RESUME" | "ESCALATE" | "STOP" | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const fetchCaseDetail = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [detail, me] = await Promise.all([
        api.cases.getById(id),
        api.auth.me().catch(() => null),
      ]);
      setCaseDetail(detail);
      if (me) setCurrentUser(me);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load case detail";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchCaseDetail();
  }, [fetchCaseDetail]);

  useGSAP(
    () => {
      if (caseDetail && containerRef.current) {
        const sections = Array.from(containerRef.current.children);
        gsap.fromTo(
          sections,
          { opacity: 0, y: 14 },
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
    { dependencies: [!!caseDetail], scope: containerRef }
  );

  const handleModalConfirm = async (payload?: { notes?: string; reason?: string }) => {
    if (!modalAction) return;

    if (modalAction === "PAUSE") {
      await api.cases.pause(id);
    } else if (modalAction === "RESUME") {
      await api.cases.resume(id);
    } else if (modalAction === "ESCALATE") {
      await api.cases.escalate(id, payload?.notes);
    } else if (modalAction === "STOP") {
      if (!payload?.reason) throw new Error("Reason required to stop case");
      await api.cases.stop(id, payload.reason);
    }

    // Refresh case details
    await fetchCaseDetail();
  };

  if (loading && !caseDetail) {
    return (
      <div className="py-24 text-center text-xs text-slate-500">
        <RefreshCw className="mx-auto h-7 w-7 mb-3 animate-spin text-emerald-400" />
        Loading canonical case state and relations...
      </div>
    );
  }

  if (error || !caseDetail) {
    return (
      <div className="py-16 text-center space-y-4">
        <AlertTriangle className="mx-auto h-10 w-10 text-rose-500" />
        <h2 className="text-base font-bold text-slate-100">Failed to Load Case</h2>
        <p className="text-xs text-slate-400 max-w-md mx-auto">{error || "Case record not found"}</p>
        <Link href="/cases">
          <Button variant="outline" size="sm">
            Back to Case List
          </Button>
        </Link>
      </div>
    );
  }

  const role = currentUser?.role;
  const statusStyle = getCaseStatusColor(caseDetail.status);

  return (
    <div ref={containerRef} className="space-y-6">
      {/* Top Breadcrumb & Control Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <Link
            href="/cases"
            className="p-2 rounded-xl border border-white/[0.08] bg-[#0c1018] text-slate-400 hover:text-slate-200 hover:border-white/[0.16] transition-colors cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-lg font-bold text-slate-100 font-mono tracking-tight">
                Case {caseDetail.case_number}
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold border ${statusStyle.bg} ${statusStyle.text} ${statusStyle.border}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                {caseDetail.status}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 font-normal">
              Customer: <span className="font-mono text-slate-300">{caseDetail.customer_id}</span> • Opened: {formatDate(caseDetail.opened_at)}
            </p>
          </div>
        </div>

        {/* Action Controls with RBAC check */}
        <div className="flex items-center gap-2">
          {canPauseResume(role) && (
            caseDetail.status === "PAUSED" ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Play className="h-3.5 w-3.5" />}
                onClick={() => setModalAction("RESUME")}
              >
                Resume Workflow
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={<Pause className="h-3.5 w-3.5" />}
                onClick={() => setModalAction("PAUSE")}
              >
                Pause Workflow
              </Button>
            )
          )}

          {canEscalate(role) && caseDetail.status !== "ESCALATED" && (
            <Button
              variant="outline"
              size="sm"
              icon={<ArrowUpRight className="h-3.5 w-3.5" />}
              onClick={() => setModalAction("ESCALATE")}
            >
              Escalate to Human
            </Button>
          )}

          {canStop(role) && caseDetail.status !== "STOPPED" && caseDetail.status !== "RECOVERED" && (
            <Button
              variant="danger"
              size="sm"
              icon={<Octagon className="h-3.5 w-3.5" />}
              onClick={() => setModalAction("STOP")}
            >
              Stop Case
            </Button>
          )}
        </div>
      </div>

      {/* Financial Obligation Summary Card */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
          <div className="p-3.5 rounded-xl border border-white/[0.06] bg-[#090c13]/70">
            <span className="text-[10px] text-slate-400 font-sans block mb-1 uppercase tracking-wider">
              Amount at Risk
            </span>
            <span className="text-xl font-bold text-slate-100 tabular-nums">
              {formatMoney(caseDetail.amount_at_risk, caseDetail.currency)}
            </span>
          </div>

          <div className="p-3.5 rounded-xl border border-white/[0.06] bg-[#090c13]/70">
            <span className="text-[10px] text-slate-400 font-sans block mb-1 uppercase tracking-wider">
              Risk Surface
            </span>
            <span className="text-xs font-semibold text-cyan-400 font-sans block">
              {caseDetail.risk_type.replace(/_/g, " ")}
            </span>
          </div>

          <div className="p-3.5 rounded-xl border border-white/[0.06] bg-[#090c13]/70">
            <span className="text-[10px] text-slate-400 font-sans block mb-1 uppercase tracking-wider">
              Source Entity
            </span>
            <span className="text-xs text-slate-300 truncate block text-[11px]" title={caseDetail.source_entity_id}>
              {caseDetail.source_entity_type}: {caseDetail.source_entity_id}
            </span>
          </div>

          <div className="p-3.5 rounded-xl border border-white/[0.06] bg-[#090c13]/70">
            <span className="text-[10px] text-slate-400 font-sans block mb-1 uppercase tracking-wider">
              Workflow Status
            </span>
            <span className="text-xs font-semibold text-emerald-400 block">
              {caseDetail.workflow ? caseDetail.workflow.status : (caseDetail.workflow_id ? "ATTACHED" : "UNATTACHED")}
            </span>
          </div>
        </div>
      </div>

      {/* Detail Grid: AI Decision, Policy Clearance & Risk */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <DecisionCard decision={caseDetail.decision} />
        <PolicyVerdictCard policyEvaluation={caseDetail.policy_evaluation} />
      </div>

      {/* Outcome Card (if recovered/resolved) */}
      {caseDetail.outcome && (
        <OutcomeCard outcome={caseDetail.outcome} currency={caseDetail.currency} />
      )}

      {/* Risk Factors Breakdown & Actions Ledger Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <RiskFactorsCard risk={caseDetail.risk} />
        <ActionsLedger actions={caseDetail.actions} />
      </div>

      {/* Interactive Live Case Event Timeline */}
      <CaseTimeline caseId={caseDetail.id} />

      {/* Action Confirmation Modal */}
      {modalAction && (
        <CaseControlModal
          isOpen={!!modalAction}
          onClose={() => setModalAction(null)}
          caseId={caseDetail.id}
          caseNumber={caseDetail.case_number}
          action={modalAction}
          onConfirm={handleModalConfirm}
        />
      )}
    </div>
  );
}
