import React from "react";
import { Sparkles, BrainCircuit, ShieldAlert, CheckCircle2 } from "lucide-react";

export interface RecommendedActionItem {
  type?: string;
  delay_hours?: number;
  template?: string;
  [key: string]: unknown;
}

export interface DecisionCardProps {
  decision: {
    id: string;
    model: string;
    prompt_version: string;
    status: string;
    diagnosis: {
      cause: string;
      confidence: number;
      rationale?: string;
    };
    recommended_actions: (RecommendedActionItem | unknown)[];
    stop_conditions: string[];
    created_at: string;
  } | null;
}

export function DecisionCard({ decision }: DecisionCardProps) {
  if (!decision) {
    return (
      <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-6 text-center text-xs text-white/40">
        <BrainCircuit className="mx-auto mb-2 h-7 w-7 opacity-30 text-white/40" />
        <p>No AI decision recorded for this case yet</p>
      </div>
    );
  }

  const isFallback = decision.status === "FALLBACK_RULE_BASED";
  const confidencePercent = Math.round(decision.diagnosis.confidence * 100);

  return (
    <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-5">
      <div className="mb-4 border-b border-white/[0.06] pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-cyan-400" />
            <h3 className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-white">
              AI Decision Recommendation
              {isFallback && (
                <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold text-amber-300">
                  <ShieldAlert className="mr-1 h-3 w-3" />
                  FALLBACK (RULE-BASED)
                </span>
              )}
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                confidencePercent >= 75
                  ? "border-[#3ef0a8]/30 bg-[#3ef0a8]/10 text-[#3ef0a8]"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-300"
              }`}
            >
              {confidencePercent}% Confidence
            </span>
          </div>
        </div>
        <p className="mt-1 font-mono text-[11px] font-normal text-white/45">
          Model: <span className="text-white/70">{decision.model}</span> • Prompt:{" "}
          <span className="text-white/70">{decision.prompt_version}</span>
        </p>
      </div>

      <div className="space-y-3.5 text-xs">
        {/* Diagnosis & Confidence */}
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-white/45">
              Diagnosed Root Cause
            </span>
            <span className="font-mono text-xs font-bold text-cyan-300">
              {decision.diagnosis.cause}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                confidencePercent >= 75 ? "bg-[#3ef0a8]" : "bg-amber-400"
              }`}
              style={{ width: `${confidencePercent}%` }}
            />
          </div>
        </div>

        {/* Rationale */}
        {decision.diagnosis.rationale && (
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5 text-xs leading-relaxed text-white/75">
            <span className="mr-1.5 font-semibold text-white">Rationale:</span>
            {decision.diagnosis.rationale}
          </div>
        )}

        {/* Recommended Actions */}
        <div>
          <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/45">
            Recommended Action Sequence
          </h4>
          <div className="space-y-2">
            {decision.recommended_actions && decision.recommended_actions.length > 0 ? (
              decision.recommended_actions.map((rawAct, idx) => {
                const act = (typeof rawAct === "object" && rawAct !== null ? rawAct : {}) as RecommendedActionItem;
                return (
                  <div
                    key={idx}
                    className="flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3 font-mono text-xs"
                  >
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#3ef0a8]" />
                    <div className="flex-1">
                      <span className="font-bold text-white">
                        {act.type || JSON.stringify(act)}
                      </span>
                      {act.delay_hours && (
                        <span className="ml-2 font-mono text-[11px] text-white/45">
                          (delay: {act.delay_hours}h)
                        </span>
                      )}
                      {act.template && (
                        <span className="ml-2 font-mono text-[11px] text-cyan-300">
                          [template: {act.template}]
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="italic text-xs text-white/40">No specific actions recommended</p>
            )}
          </div>
        </div>

        {/* Stop Conditions */}
        {decision.stop_conditions && decision.stop_conditions.length > 0 && (
          <div>
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-white/45">
              Stop Conditions
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {decision.stop_conditions.map((cond, idx) => (
                <span
                  key={idx}
                  className="rounded-full border border-white/[0.08] bg-black/40 px-2.5 py-1 font-mono text-[10px] text-white/60"
                >
                  {cond}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
