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
  Loader2,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Modal } from "../../../components/ui/Modal";
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
      if (gridRef.current && policies.length > 0) {
        const policyCards = Array.from(gridRef.current.children);
        gsap.fromTo(
          policyCards,
          { opacity: 0, y: 12 },
          {
            opacity: 1,
            y: 0,
            duration: 0.35,
            stagger: 0.04,
            ease: "power2.out",
            clearProps: "opacity,transform",
          }
        );
      }
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
    <div ref={containerRef} className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-emerald-400" />
            Policy Engine & Autonomous Guardrails
          </h1>
          <p className="text-xs text-slate-400 mt-0.5 font-normal">
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
            <div className="flex items-center gap-1 text-xs text-slate-400 font-medium bg-[#0c1018] border border-white/[0.08] px-3 py-1.5 rounded-xl">
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
      <div ref={gridRef} className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {policies.map((p) => (
          <div
            key={p.id}
            className={`rounded-2xl border p-5 shadow-lg shadow-black/40 backdrop-blur-xl transition-all ${
              p.enabled
                ? "border-white/[0.08] bg-[#0d111a]/85"
                : "border-white/[0.04] bg-[#090c13]/40 opacity-70"
            }`}
          >
            <div className="flex items-start justify-between gap-3 pb-3 mb-3 border-b border-white/[0.06]">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-slate-100">{p.name}</h3>
                  <Badge variant={p.enabled ? "success" : "default"} size="sm">
                    {p.enabled ? "ACTIVE" : "DISABLED"}
                  </Badge>
                </div>
                <p className="text-[10px] text-slate-400 font-mono mt-0.5">
                  Type: {p.rule_type} • Category: {p.category} • v{p.version}
                </p>
              </div>

              {isFinance && (
                <button
                  onClick={() => handleToggle(p)}
                  className="text-slate-400 hover:text-slate-200 transition-colors p-1 cursor-pointer"
                  title={p.enabled ? "Disable Rule" : "Enable Rule"}
                >
                  {p.enabled ? (
                    <ToggleRight className="h-6 w-6 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="h-6 w-6 text-slate-500" />
                  )}
                </button>
              )}
            </div>

            {p.description && (
              <p className="text-xs text-slate-300 mb-3 leading-relaxed font-normal">
                {p.description}
              </p>
            )}

            <div className="rounded-xl border border-white/[0.06] bg-[#05070a] p-3 font-mono text-[10px] text-cyan-300">
              <pre className="overflow-x-auto">{JSON.stringify(p.parameters, null, 2)}</pre>
            </div>

            <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs">
              <span className="text-slate-500 font-mono text-[10px]">
                Updated {formatDate(p.updated_at)}
              </span>

              {isFinance && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<History className="h-3 w-3 text-cyan-400" />}
                  onClick={() => handleOpenHistory(p)}
                >
                  <span className="text-cyan-400 font-medium text-xs">Version History</span>
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

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
            <div className="py-12 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-400">
              <Loader2 className="h-5 w-5 text-cyan-400 animate-spin" />
              <span className="text-[11px] font-medium text-slate-400">Loading policy version snapshots...</span>
            </div>
          ) : versions.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              No historical versions recorded yet (current is v1)
            </div>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto pr-1 font-mono text-xs">
              {versions.map((ver) => (
                <div
                  key={ver.id || ver.version}
                  className="rounded-xl border border-white/[0.06] bg-[#090c13] p-3 space-y-2"
                >
                  <div className="flex items-center justify-between text-slate-400">
                    <span className="font-bold text-slate-200 text-xs">Version {ver.version}</span>
                    <span className="text-[10px]">{formatDate(ver.changed_at)}</span>
                  </div>
                  <pre className="text-[10px] text-cyan-300 overflow-x-auto bg-[#05070a] p-2 rounded-lg border border-white/[0.06]">
                    {JSON.stringify(ver.parameters, null, 2)}
                  </pre>
                  <div className="text-[10px] text-slate-500">
                    Changed by: {ver.changed_by || "Operator"} {ver.reason && `• ${ver.reason}`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
