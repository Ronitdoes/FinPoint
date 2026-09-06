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
import { Skeleton, SkeletonCards } from "../../../../components/ui/Skeleton";

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
      const mm = gsap.matchMedia();

      mm.add(
        {
          full: "(prefers-reduced-motion: no-preference)",
          reduced: "(prefers-reduced-motion: reduce)",
        },
        (ctx) => {
          if (ctx.conditions?.reduced) return;
          const q = gsap.utils.selector(containerRef);

          // Frame -> header -> panels. Transforms + autoAlpha only.
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
        }
      );

      return () => mm.revert();
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
      <div ref={containerRef}>
        {/* Outer frame */}
        <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
          <div className="space-y-3">
            {/* Top Breadcrumb & Control Action Bar skeleton */}
            <div className="fp-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-2 pt-1">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                <div>
                  <Skeleton className="h-4 w-48 max-w-full" />
                  <Skeleton className="mt-2 h-3 w-64 max-w-full" />
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Skeleton className="h-8 w-28 rounded-full" />
                <Skeleton className="h-8 w-28 rounded-full" />
              </div>
            </div>

            {/* Financial Obligation Summary Card skeleton */}
            <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
              <SkeletonCards count={4} />
            </div>

            {/* Detail Grid: AI Decision, Policy Clearance & Risk skeleton */}
            <div className="fp-rise grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="mt-3 h-5 w-2/3" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-5/6" />
              </div>
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="mt-3 h-5 w-1/2" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-4/6" />
              </div>
            </div>

            {/* Risk Factors Breakdown & Actions Ledger Grid skeleton */}
            <div className="fp-rise grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-3/5" />
              </div>
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-2/5" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !caseDetail) {
    return (
      <div className="space-y-4 py-16 text-center">
        <AlertTriangle className="mx-auto h-10 w-10 text-rose-400" />
        <h2 className="text-base font-bold text-white">Failed to Load Case</h2>
        <p className="mx-auto max-w-md text-xs text-white/45">{error || "Case record not found"}</p>
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
    <div ref={containerRef}>
      {/* Outer frame */}
      <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="space-y-3">
      {/* Top Breadcrumb & Control Action Bar */}
      <div className="fp-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-2 pt-1">
        <div className="flex items-center gap-3">
          <Link
            href="/cases"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="font-mono text-[15px] font-semibold tracking-tight text-white">
                Case {caseDetail.case_number}
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold border ${statusStyle.bg} ${statusStyle.text} ${statusStyle.border}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                {caseDetail.status}
              </span>
            </div>
            <p className="mt-0.5 text-[11px] font-normal text-white/45">
              Customer: <span className="font-mono text-white/75">{caseDetail.customer_id}</span> • Opened: {formatDate(caseDetail.opened_at)}
            </p>
          </div>
        </div>

        {/* Action Controls with RBAC check */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
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
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
        <div className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-4">
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
            <span className="mb-1 block font-sans text-[10px] uppercase tracking-wider text-white/45">
              Amount at Risk
            </span>
            <span className="text-xl font-bold text-white tabular-nums">
              {formatMoney(caseDetail.amount_at_risk, caseDetail.currency)}
            </span>
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
            <span className="mb-1 block font-sans text-[10px] uppercase tracking-wider text-white/45">
              Risk Surface
            </span>
            <span className="block font-sans text-xs font-semibold text-white">
              {caseDetail.risk_type.replace(/_/g, " ")}
            </span>
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
            <span className="mb-1 block font-sans text-[10px] uppercase tracking-wider text-white/45">
              Source Entity
            </span>
            <span className="block truncate text-[11px] text-white/75" title={caseDetail.source_entity_id}>
              {caseDetail.source_entity_type}: {caseDetail.source_entity_id}
            </span>
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
            <span className="mb-1 block font-sans text-[10px] uppercase tracking-wider text-white/45">
              Workflow Status
            </span>
            <span className="block text-xs font-semibold text-white">
              {caseDetail.workflow ? caseDetail.workflow.status : (caseDetail.workflow_id ? "ATTACHED" : "UNATTACHED")}
            </span>
          </div>
        </div>
      </div>

      {/* Detail Grid: AI Decision, Policy Clearance & Risk */}
      <div className="fp-rise grid grid-cols-1 gap-3 lg:grid-cols-2">
        <DecisionCard decision={caseDetail.decision} />
        <PolicyVerdictCard policyEvaluation={caseDetail.policy_evaluation} />
      </div>

      {/* Outcome Card (if recovered/resolved) */}
      {caseDetail.outcome && (
        <div className="fp-rise">
        <OutcomeCard outcome={caseDetail.outcome} currency={caseDetail.currency} />
        </div>
      )}

      {/* Risk Factors Breakdown & Actions Ledger Grid */}
      <div className="fp-rise grid grid-cols-1 gap-3 lg:grid-cols-2">
        <RiskFactorsCard risk={caseDetail.risk} />
        <ActionsLedger actions={caseDetail.actions} />
      </div>

      {/* Interactive Live Case Event Timeline */}
      <div className="fp-rise">
      <CaseTimeline caseId={caseDetail.id} />
      </div>

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
      </div>
    </div>
  );
}
