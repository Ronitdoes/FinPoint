import React from "react";
import { Badge } from "../ui/Badge";
import { formatDate } from "../../lib/format";
import { Activity } from "lucide-react";

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
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-6 text-center text-slate-500 text-xs backdrop-blur-xl">
        No execution actions taken yet
      </div>
    );
  }

  const statusBadges: Record<string, "success" | "danger" | "warning" | "info" | "default"> = {
    SUCCEEDED: "success",
    COMPLETED: "success",
    FAILED: "danger",
    RUNNING: "info",
    SCHEDULED: "warning",
    PENDING: "default",
  };

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl">
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-white/[0.06]">
        <h3 className="text-xs font-semibold text-slate-100 flex items-center gap-2">
          <Activity className="h-4 w-4 text-cyan-400" />
          Recovery Actions Ledger
        </h3>
        <span className="text-[11px] text-slate-400 font-mono">
          {actions.length} action{actions.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-white/[0.06] text-slate-400 font-semibold uppercase text-[10px]">
            <tr>
              <th className="py-2 pr-3">#</th>
              <th className="py-2 px-3">Action Type</th>
              <th className="py-2 px-3">Status</th>
              <th className="py-2 px-3 font-mono">Idempotency Key</th>
              <th className="py-2 pl-3 text-right">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
            {actions.map((act) => (
              <tr key={act.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="py-2.5 pr-3 text-slate-400 font-bold">
                  {act.attempt_number}
                </td>
                <td className="py-2.5 px-3 font-sans font-medium text-slate-200">
                  {act.type}
                </td>
                <td className="py-2.5 px-3">
                  <Badge variant={statusBadges[act.status] || "default"} size="sm">
                    {act.status}
                  </Badge>
                </td>
                <td className="py-2.5 px-3 text-slate-400 truncate max-w-[160px] text-[11px]" title={act.idempotency_key}>
                  {act.idempotency_key}
                </td>
                <td className="py-2.5 pl-3 text-right text-slate-400 text-[11px]">
                  {formatDate(act.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
