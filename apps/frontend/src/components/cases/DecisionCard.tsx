import React from "react";
import { Sparkles, BrainCircuit, ShieldAlert, CheckCircle2 } from "lucide-react";
import { Badge } from "../ui/Badge";

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
    recommended_actions: unknown[];
    stop_conditions: string[];
    created_at: string;
  } | null;
}

export function DecisionCard({ decision }: DecisionCardProps) {
  if (!decision) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-6 text-center text-slate-500 text-xs backdrop-blur-xl">
        <BrainCircuit className="mx-auto h-7 w-7 mb-2 opacity-30" />
        <p>No AI decision recorded for this case yet</p>
      </div>
    );
  }

  const isFallback = decision.status === "FALLBACK_RULE_BASED";
  const confidencePercent = Math.round(decision.diagnosis.confidence * 100);

  return (
    <div className="rounded-2xl border border-indigo-500/25 bg-gradient-to-b from-indigo-950/20 via-[#0d111a]/90 to-[#0d111a]/90 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3 pb-3 mb-4 border-b border-indigo-500/15">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 shadow-[0_0_12px_-3px_rgba(99,102,241,0.3)]">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-slate-100 flex items-center gap-2">
              AI Decision Recommendation
              {isFallback && (
                <Badge variant="warning" size="sm">
                  <ShieldAlert className="h-3 w-3 mr-1" />
                  FALLBACK (RULE-BASED)
                </Badge>
              )}
            </h3>
            <p className="text-[10px] text-slate-400 font-mono">
              Model: {decision.model} • Prompt: {decision.prompt_version}
            </p>
          </div>
        </div>

        <Badge variant={confidencePercent >= 75 ? "success" : "warning"} size="md">
          {confidencePercent}% Confidence
        </Badge>
      </div>

      <div className="space-y-4 text-xs">
        {/* Diagnosis & Confidence */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
              Diagnosed Root Cause:
            </span>
            <span className="font-mono font-bold text-indigo-300 text-xs">
              {decision.diagnosis.cause}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800/80">
            <div
              className={`h-full rounded-full transition-all ${
                confidencePercent >= 75
                  ? "bg-gradient-to-r from-cyan-500 to-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"
                  : "bg-gradient-to-r from-amber-500 to-orange-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
              }`}
              style={{ width: `${confidencePercent}%` }}
            />
          </div>
        </div>

        {/* Rationale */}
        {decision.diagnosis.rationale && (
          <div className="rounded-xl border border-indigo-500/15 bg-indigo-950/20 p-3 text-slate-300 leading-relaxed text-xs">
            <span className="font-semibold text-indigo-300 mr-1.5">Rationale:</span>
            {decision.diagnosis.rationale}
          </div>
        )}

        {/* Recommended Actions */}
        <div>
          <h4 className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] mb-2">
            Recommended Action Sequence
          </h4>
          <div className="space-y-2">
            {decision.recommended_actions && decision.recommended_actions.length > 0 ? (
              decision.recommended_actions.map((act: any, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-[#090c13]/70 p-2.5 font-mono text-xs"
                >
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <span className="font-bold text-slate-200">{act.type || JSON.stringify(act)}</span>
                    {act.delay_hours && (
                      <span className="ml-2 text-slate-400 text-[11px]">
                        (delay: {act.delay_hours}h)
                      </span>
                    )}
                    {act.template && (
                      <span className="ml-2 text-cyan-400 text-[11px]">
                        [template: {act.template}]
                      </span>
                    )}
                  </div>
                </div>
              ))
            ) : (
              <p className="text-slate-500 italic">No specific actions recommended</p>
            )}
          </div>
        </div>

        {/* Stop Conditions */}
        {decision.stop_conditions && decision.stop_conditions.length > 0 && (
          <div>
            <h4 className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] mb-1.5">
              Stop Conditions
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {decision.stop_conditions.map((cond, idx) => (
                <span
                  key={idx}
                  className="rounded-lg border border-white/[0.06] bg-[#090c13] px-2 py-0.5 text-[10px] font-mono text-slate-400"
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
