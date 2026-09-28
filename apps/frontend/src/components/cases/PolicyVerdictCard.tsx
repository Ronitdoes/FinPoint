import React from "react";
import { ShieldCheck, ShieldAlert, ShieldX, Clock } from "lucide-react";
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
      <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-6 text-center text-xs text-white/40">
        <ShieldCheck className="mx-auto mb-2 h-7 w-7 opacity-30 text-white/40" />
        <p>No policy evaluation record attached</p>
      </div>
    );
  }

  const resultVariants = {
    ALLOWED: {
      badgeClass: "border-[#3ef0a8]/30 bg-[#3ef0a8]/10 text-[#3ef0a8]",
      icon: <ShieldCheck className="h-4 w-4 text-[#3ef0a8]" />,
      titleText: "Policy Clearance: ALLOWED",
      subtitleText: "Autonomous recovery actions cleared against defined safety guardrails",
    },
    REJECTED: {
      badgeClass: "border-rose-500/30 bg-rose-500/10 text-rose-400",
      icon: <ShieldX className="h-4 w-4 text-rose-400" />,
      titleText: "Policy Blocked: REJECTED",
      subtitleText: "Recovery actions intercepted and halted by safety policies",
    },
    REQUIRE_APPROVAL: {
      badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-300",
      icon: <ShieldAlert className="h-4 w-4 text-amber-400" />,
      titleText: "Escalated: REQUIRES APPROVAL",
      subtitleText: "Action requires manual operator sign-off before dispatch",
    },
  };

  const meta =
    resultVariants[policyEvaluation.result] || resultVariants.ALLOWED;

  return (
    <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-5">
      <div className="mb-4 border-b border-white/[0.06] pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {meta.icon}
            <h3 className="text-[13px] font-semibold tracking-tight text-white">
              {meta.titleText}
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="flex items-center gap-1 font-mono text-[11px] tabular-nums text-white/45">
              <Clock className="h-3 w-3 text-white/40" />
              {formatLatency(policyEvaluation.latency_ms)}
            </span>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${meta.badgeClass}`}
            >
              {policyEvaluation.result}
            </span>
          </div>
        </div>
        <p className="mt-1 text-[11px] font-normal text-white/45">
          {meta.subtitleText}
        </p>
      </div>

      <div className="space-y-3.5 text-xs">
        {policyEvaluation.rejections && policyEvaluation.rejections.length > 0 && (
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 p-3.5">
            <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-rose-300">
              <ShieldX className="h-3.5 w-3.5" />
              Policy Violations / Rejection Reasons
            </h4>
            <ul className="space-y-1.5 font-mono text-[11px] text-rose-200/90">
              {policyEvaluation.rejections.map((rej: unknown, idx) => {
                const text =
                  typeof rej === "string"
                    ? rej
                    : typeof rej === "object" &&
                        rej !== null &&
                        "reason" in rej &&
                        typeof (rej as { reason: unknown }).reason === "string"
                      ? (rej as { reason: string }).reason
                      : JSON.stringify(rej);
                return (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="text-rose-400">•</span>
                    <span>{text}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {policyEvaluation.effective_actions && policyEvaluation.effective_actions.length > 0 && (
          <div>
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/45">
              Effective Actions Permitted to Execute
            </h4>
            <div className="space-y-2 font-mono text-xs">
              {policyEvaluation.effective_actions.map((act: unknown, idx) => {
                const label =
                  typeof act === "object" &&
                  act !== null &&
                  "type" in act &&
                  typeof (act as { type: unknown }).type === "string"
                    ? (act as { type: string }).type
                    : JSON.stringify(act);
                return (
                  <div
                    key={idx}
                    className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3 font-semibold text-white"
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
