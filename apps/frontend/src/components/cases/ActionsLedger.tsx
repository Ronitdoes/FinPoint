import React from "react";
import { Activity } from "lucide-react";
import { formatDate } from "../../lib/format";

export interface ActionsLedgerProps {
  actions: Array<{
    id: string;
    type: string;
    status: string;
    parameters: Record<string, unknown>;
    idempotency_key: string;
    attempt_number: number;
    scheduled_at: string | null;
    created_at: string;
  }>;
}

export function ActionsLedger({ actions }: ActionsLedgerProps) {
  if (!actions || actions.length === 0) {
    return (
      <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-6 text-center text-xs text-white/40">
        <Activity className="mx-auto mb-2 h-7 w-7 opacity-30 text-white/40" />
        <p>No execution actions taken yet</p>
      </div>
    );
  }

  const statusStyles: Record<string, { bg: string; text: string; border: string }> = {
    SUCCEEDED: { bg: "bg-[#3ef0a8]/10", text: "text-[#3ef0a8]", border: "border-[#3ef0a8]/30" },
    COMPLETED: { bg: "bg-[#3ef0a8]/10", text: "text-[#3ef0a8]", border: "border-[#3ef0a8]/30" },
    APPROVED: { bg: "bg-[#3ef0a8]/10", text: "text-[#3ef0a8]", border: "border-[#3ef0a8]/30" },
    FAILED: { bg: "bg-rose-500/10", text: "text-rose-400", border: "border-rose-500/30" },
    RUNNING: { bg: "bg-cyan-500/10", text: "text-cyan-300", border: "border-cyan-500/30" },
    SCHEDULED: { bg: "bg-amber-500/10", text: "text-amber-300", border: "border-amber-500/30" },
    PENDING: { bg: "bg-white/[0.05]", text: "text-white/70", border: "border-white/[0.08]" },
  };

  return (
    <div className="rounded-3xl border border-white/[0.07] bg-[#131316] p-5">
      <div className="mb-4 border-b border-white/[0.06] pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-cyan-400" />
            <h3 className="text-[13px] font-semibold tracking-tight text-white">
              Recovery Actions Ledger
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-white/45">
              {actions.length} action{actions.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <p className="mt-1 text-[11px] font-normal text-white/45">
          Audited record of autonomous and operator recovery executions
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-white/[0.06] font-semibold uppercase text-[10px] text-white/45">
            <tr>
              <th className="py-2.5 pr-3">#</th>
              <th className="py-2.5 px-3">Action Type</th>
              <th className="py-2.5 px-3">Status</th>
              <th className="py-2.5 px-3 font-mono">Idempotency Key</th>
              <th className="py-2.5 pl-3 text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
            {actions.map((act) => {
              const style = statusStyles[act.status] || statusStyles.PENDING;
              return (
                <tr key={act.id} className="transition-colors hover:bg-white/[0.04]">
                  <td className="py-3 pr-3 font-bold text-white/50">
                    {act.attempt_number}
                  </td>
                  <td className="py-3 px-3 font-sans font-medium text-white">
                    {act.type}
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${style.bg} ${style.text} ${style.border}`}
                    >
                      {act.status}
                    </span>
                  </td>
                  <td
                    className="max-w-[160px] truncate py-3 px-3 text-[11px] text-white/45"
                    title={act.idempotency_key}
                  >
                    {act.idempotency_key}
                  </td>
                  <td className="py-3 pl-3 text-right text-[11px] text-white/45">
                    {formatDate(act.created_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
