"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  ShieldCheck,
  ShieldPlus,
  History,
  ToggleLeft,
  ToggleRight,
  RefreshCw,
  Lock,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
import { SkeletonCards, SkeletonStats } from "../../../components/ui/Skeleton";
import { CreatePolicyModal } from "../../../components/modals/CreatePolicyModal";
import { formatDate } from "../../../lib/format";
import { canManagePolicies } from "../../../lib/rbac";
import { api } from "../../../lib/api";
import type { PolicyRule, PolicyVersion, AuthMeResponse } from "../../../lib/types";

gsap.registerPlugin(useGSAP);

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [historyRule, setHistoryRule] = useState<PolicyRule | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      const [polRes, me] = await Promise.all([
        api.policies.list().catch(() => ({ policies: [] })),
        api.auth.me().catch(() => null),
      ]);

      if (polRes?.policies) setPolicies(polRes.policies);
      if (me) setCurrentUser(me);
    } catch {
      // error handling
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

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

          // Frame + header entrance — transforms + autoAlpha only.
          gsap.fromTo(
            q(".fp-frame"),
            { y: 14, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.5, ease: "power3.out", clearProps: "transform" }
          );
          gsap.fromTo(
            q(".fp-rise"),
            { y: 18, autoAlpha: 0 },
            {
              y: 0,
              autoAlpha: 1,
              duration: 0.5,
              stagger: { each: 0.07, from: "start" },
              ease: "power3.out",
              clearProps: "transform",
            }
          );

          // Policy cards stagger (existing grid children selector, upgraded to autoAlpha).
          if (gridRef.current && policies.length > 0) {
            const policyCards = Array.from(gridRef.current.children);
            gsap.fromTo(
              policyCards as Element[],
              { y: 12, autoAlpha: 0 },
              {
                y: 0,
                autoAlpha: 1,
                duration: 0.35,
                stagger: 0.04,
                ease: "power2.out",
                clearProps: "transform",
              }
            );
          }
        }
      );

      return () => mm.revert();
    },
    { dependencies: [policies.length], scope: containerRef }
  );

  const handleToggle = async (policy: PolicyRule) => {
    if (!canManagePolicies(currentUser?.role)) return;
    try {
      await api.policies.update(policy.id, { enabled: !policy.enabled });
      await fetchPolicies();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update policy";
      alert(message);
    }
  };

  const handleOpenHistory = async (policy: PolicyRule) => {
    setHistoryRule(policy);
    setLoadingVersions(true);
    try {
      const res = await api.policies.getVersions(policy.id);
      setVersions(res.versions || []);
    } catch {
      setVersions([]);
    } finally {
      setLoadingVersions(false);
    }
  };

  const isFinance = canManagePolicies(currentUser?.role);

  return (
    <div ref={containerRef}>
      {/* Outer FinPoint frame */}
      <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="space-y-3">
      {/* Header */}
      <div className="fp-rise flex flex-wrap items-center justify-between gap-4 rounded-2xl px-2 pt-1">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight text-white flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-white/60" />
            Policy Engine & Autonomous Guardrails
          </h1>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
            Deterministic hard boundaries, spending caps, cadence limits, and escalation rules
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isFinance ? (
            <Button
              variant="primary"
              size="sm"
              icon={<ShieldPlus className="h-3.5 w-3.5" />}
              onClick={() => setCreateModalOpen(true)}
            >
              Add Policy Rule
            </Button>
          ) : (
            <div className="flex items-center gap-1 rounded-full border border-white/[0.09] bg-[#1d1d20] px-3 py-1.5 text-xs font-medium text-white/55">
              <Lock className="h-3 w-3 text-amber-400" />
              <span>Editing requires Finance+ Role</span>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            loading={loading}
            icon={<RefreshCw className="h-3 w-3" />}
            onClick={() => fetchPolicies()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Policy Rules Grid */}
      {loading && policies.length === 0 ? (
        <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
          <SkeletonCards count={4} />
        </div>
      ) : policies.length === 0 ? (
        <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-16 text-center text-xs text-white/40">
          <ShieldCheck className="mx-auto h-8 w-8 mb-2 opacity-30 text-white/60" />
          <p className="text-[13px] font-semibold tracking-tight text-white">No policy rules configured</p>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">Platform safety guardrails will appear here once loaded.</p>
        </div>
      ) : (
        <div ref={gridRef} className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {policies.map((p) => (
            <div
              key={p.id}
              className={`rounded-3xl border p-5 transition-all ${
                p.enabled
                  ? "border-white/[0.07] bg-[#131316]/90"
                  : "border-white/[0.04] bg-[#131316]/40 opacity-70"
              }`}
            >
              <div className="flex items-start justify-between gap-3 pb-3.5 mb-3 border-b border-white/[0.06]">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-[13px] font-semibold tracking-tight text-white">{p.name}</h3>
                    <Badge variant={p.enabled ? "success" : "default"} size="sm">
                      {p.enabled ? "ACTIVE" : "DISABLED"}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-white/45 font-mono mt-0.5">
                    {p.code ? `${p.code} • ` : ""}Type: {p.rule_type} • Category: {p.category} • v{p.version}
                  </p>
                </div>

              {isFinance && (
                <button
                  onClick={() => handleToggle(p)}
                  className="text-white/70 hover:text-white transition-colors p-1 cursor-pointer"
                  title={p.enabled ? "Disable Rule" : "Enable Rule"}
                >
                  {p.enabled ? (
                    <ToggleRight className="h-6 w-6 text-emerald-300" />
                  ) : (
                    <ToggleLeft className="h-6 w-6 text-white/30" />
                  )}
                </button>
              )}
            </div>

            {p.description && (
              <p className="text-[13px] leading-relaxed text-white/70 mb-3 font-normal">
                {p.description}
              </p>
            )}

            <div className="rounded-2xl border border-white/[0.07] bg-black/40 p-3 font-mono text-[10px] text-cyan-300">
              <pre className="overflow-x-auto">{JSON.stringify(p.parameters, null, 2)}</pre>
            </div>

            <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs">
              <span className="text-white/40 font-mono text-[10px]">
                Updated {formatDate(p.updated_at)}
              </span>

              {isFinance && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<History className="h-3 w-3 text-cyan-300" />}
                  onClick={() => handleOpenHistory(p)}
                >
                  <span className="text-cyan-300 font-medium text-xs">Version History</span>
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      )}

      {/* Create Policy Modal */}
      <CreatePolicyModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSuccess={fetchPolicies}
      />

      {/* Version History Diff Modal */}
      {historyRule && (
        <Modal
          isOpen={!!historyRule}
          onClose={() => setHistoryRule(null)}
          title={`Version History — ${historyRule.name}`}
          description="Audit trail of parameter adjustments and policy modifications."
          footer={
            <Button variant="primary" onClick={() => setHistoryRule(null)}>
              Done
            </Button>
          }
        >
          {loadingVersions ? (
            <SkeletonStats count={4} />
          ) : versions.length === 0 ? (
            <div className="py-8 text-center text-xs text-white/40">
              No historical versions recorded yet (current is v1)
            </div>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto pr-1 font-mono text-xs">
              {versions.map((ver) => (
                <div
                  key={ver.id || ver.version}
                  className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3 space-y-2"
                >
                  <div className="flex items-center justify-between text-white/55">
                    <span className="font-bold text-white text-xs">Version {ver.version}</span>
                    <span className="text-[10px] text-white/45">{formatDate(ver.changed_at)}</span>
                  </div>
                  <pre className="text-[10px] text-cyan-300 overflow-x-auto bg-black/40 p-2 rounded-xl border border-white/[0.07]">
                    {JSON.stringify(ver.parameters, null, 2)}
                  </pre>
                  <div className="text-[10px] text-white/40">
                    Changed by: {ver.changed_by || "Operator"} {ver.reason && `• ${ver.reason}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
        </div>
      </div>
    </div>
  );
}
