import React from "react";
import { ShieldCheck, ShieldAlert, ShieldX, Clock } from "lucide-react";
import { Badge } from "../ui/Badge";
import { formatLatency } from "../../lib/format";

export interface PolicyVerdictCardProps {
  policyEvaluation: {
    id: string;
    result: "ALLOWED" | "REJECTED" | "REQUIRE_APPROVAL";
    allowed: boolean;
    required_approval: boolean;
    rejections: unknown[];
    effective_actions: unknown[];
    latency_ms: number;
    evaluated_at: string;
  } | null;
}

export function PolicyVerdictCard({ policyEvaluation }: PolicyVerdictCardProps) {
  if (!policyEvaluation) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-6 text-center text-slate-500 text-xs backdrop-blur-xl">
        <ShieldCheck className="mx-auto h-7 w-7 mb-2 opacity-30" />
        <p>No policy evaluation record attached</p>
      </div>
    );
  }

  const resultVariants = {
    ALLOWED: {
      badge: "success" as const,
      icon: <ShieldCheck className="h-4 w-4 text-emerald-400" />,
      border: "border-emerald-500/25 bg-gradient-to-b from-emerald-950/20 to-[#0d111a]/90",
      titleText: "Policy Clearance: ALLOWED",
    },
    REJECTED: {
      badge: "danger" as const,
      icon: <ShieldX className="h-4 w-4 text-rose-400" />,
      border: "border-rose-500/25 bg-gradient-to-b from-rose-950/20 to-[#0d111a]/90",
      titleText: "Policy Blocked: REJECTED",
    },
    REQUIRE_APPROVAL: {
      badge: "warning" as const,
      icon: <ShieldAlert className="h-4 w-4 text-amber-400" />,
      border: "border-amber-500/25 bg-gradient-to-b from-amber-950/20 to-[#0d111a]/90",
      titleText: "Escalated: REQUIRES HUMAN APPROVAL",
    },
  };

  const meta =
    resultVariants[policyEvaluation.result] || resultVariants.ALLOWED;

  return (
    <div
      className={`rounded-2xl border p-5 shadow-lg shadow-black/40 backdrop-blur-xl ${meta.border}`}
    >
      <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
            {meta.icon}
          </div>
          <h3 className="text-xs font-semibold text-slate-100">{meta.titleText}</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-[10px] text-slate-400 font-mono">
            <Clock className="h-3 w-3" />
            {formatLatency(policyEvaluation.latency_ms)}
          </span>
          <Badge variant={meta.badge} size="md">
            {policyEvaluation.result}
          </Badge>
        </div>
      </div>

      <div className="space-y-3 text-xs">
        {policyEvaluation.rejections && policyEvaluation.rejections.length > 0 && (
          <div className="rounded-xl border border-rose-500/25 bg-rose-950/20 p-3">
            <h4 className="font-semibold text-rose-300 uppercase tracking-wider text-[10px] mb-1.5 flex items-center gap-1.5">
              <ShieldX className="h-3.5 w-3.5" />
              Policy Violations / Rejection Reasons
            </h4>
            <ul className="space-y-1 text-rose-200 font-mono text-[11px]">
              {policyEvaluation.rejections.map((rej: any, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-rose-400">•</span>
                  <span>{typeof rej === "string" ? rej : rej.reason || JSON.stringify(rej)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {policyEvaluation.effective_actions && policyEvaluation.effective_actions.length > 0 && (
          <div>
            <h4 className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] mb-1.5">
              Effective Actions Permitted to Execute
            </h4>
            <div className="space-y-1.5 font-mono text-xs">
              {policyEvaluation.effective_actions.map((act: any, idx) => (
                <div
                  key={idx}
                  className="rounded-xl border border-white/[0.06] bg-[#090c13]/70 px-3 py-2 text-slate-200"
                >
                  {act.type || JSON.stringify(act)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
