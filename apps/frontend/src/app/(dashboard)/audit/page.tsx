"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  FileSearch,
  RefreshCw,
  User,
  Cpu,
  ChevronRight,
  Lock,
  Loader2,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Select } from "../../../components/ui/Select";
import { Modal } from "../../../components/ui/Modal";
import { formatDate } from "../../../lib/format";
import { canManageAdmin } from "../../../lib/rbac";
import { api } from "../../../lib/api";
import type { AuditLogItem, AuthMeResponse } from "../../../lib/types";

gsap.registerPlugin(useGSAP);

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);

  // Filters
  const [caseIdFilter, setCaseIdFilter] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [actorTypeFilter, setActorTypeFilter] = useState("");

  // Debounced filters for API calls
  const [debouncedCaseId, setDebouncedCaseId] = useState("");
  const [debouncedEvent, setDebouncedEvent] = useState("");

  // Modal inspector
  const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Debounce text inputs
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedCaseId(caseIdFilter);
    }, 300);
    return () => clearTimeout(timer);
  }, [caseIdFilter]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedEvent(eventFilter);
    }, 300);
    return () => clearTimeout(timer);
  }, [eventFilter]);

  // Fetch current user role once on mount
  useEffect(() => {
    api.auth.me().then((me) => setCurrentUser(me)).catch(() => {});
  }, []);

  const fetchLogs = useCallback(
    async (cursor?: string, append = false) => {
      try {
        setLoading(true);
        const res = await api.audit
          .list({
            case_id: debouncedCaseId.trim() || undefined,
            event: debouncedEvent.trim() || undefined,
            actor_type: actorTypeFilter || undefined,
            limit: 25,
            cursor,
          })
          .catch(() => ({ items: [] as AuditLogItem[], nextCursor: undefined }));

        if (append) {
          setLogs((prev) => [...prev, ...(res.items || [])]);
        } else {
          setLogs(res.items || []);
        }
        setNextCursor(res.nextCursor);
      } catch {
        // error handling
      } finally {
        setLoading(false);
      }
    },
    [debouncedCaseId, debouncedEvent, actorTypeFilter],
  );

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useGSAP(
    () => {
      if (containerRef.current) {
        const sections = Array.from(containerRef.current.children);
        gsap.fromTo(
          sections,
          { opacity: 0, y: 12 },
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
    { dependencies: [], scope: containerRef }
  );

  // Non-Admin 403 Access Guard View
  if (currentUser && !canManageAdmin(currentUser.role)) {
    return (
      <div className="py-24 text-center space-y-4 max-w-md mx-auto">
        <div className="p-4 rounded-2xl bg-rose-500/10 border border-rose-500/25 inline-flex shadow-[0_0_20px_rgba(244,63,94,0.2)]">
          <Lock className="h-8 w-8 text-rose-400" />
        </div>
        <h2 className="text-lg font-bold text-slate-100">
          Administrator Role Required
        </h2>
        <p className="text-xs text-slate-400 leading-relaxed font-normal">
          The compliance audit trail is strictly restricted to operators with the <strong>ADMIN</strong> role. Your current role is <strong>{currentUser.role}</strong>.
        </p>
        <Link href="/dashboard">
          <Button variant="outline" size="sm">
            Return to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <FileSearch className="h-5 w-5 text-emerald-400" />
            Compliance Audit & Security Log Trail
          </h1>
          <p className="text-xs text-slate-400 mt-0.5 font-normal">
            Immutable, append-only inspection log of all automated decisions and operator actions
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          loading={loading}
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => fetchLogs()}
        >
          Refresh Audit Trail
        </Button>
      </div>

      {/* Filter Bar */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-4 shadow-lg shadow-black/40 backdrop-blur-xl">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input
            label="Filter by Case UUID"
            placeholder="e.g. 550e8400-e29b-41d4-a716..."
            value={caseIdFilter}
            onChange={(e) => setCaseIdFilter(e.target.value)}
          />

          <Input
            label="Filter by Event Name"
            placeholder="e.g. AI_DECISION_CREATED"
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
          />

          <Select
            label="Actor Type"
            value={actorTypeFilter}
            onChange={(e) => setActorTypeFilter(e.target.value)}
            options={[
              { value: "", label: "All Actors" },
              { value: "USER", label: "Interactive Operator (USER)" },
              { value: "SYSTEM", label: "Autonomous Worker (SYSTEM)" },
              { value: "ANONYMOUS", label: "External Webhook (ANONYMOUS)" },
            ]}
          />
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 shadow-lg shadow-black/40 overflow-hidden backdrop-blur-xl min-h-[320px] flex flex-col justify-center">
        {loading && logs.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-400">
            <Loader2 className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-[11px] font-medium text-slate-400">Loading audit trail...</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-500">
            <FileSearch className="mx-auto h-7 w-7 mb-2 opacity-30 text-emerald-400" />
            No audit records found matching filter criteria
          </div>
        ) : (
          <div className="overflow-x-auto self-stretch">
            <table className={`w-full text-left text-xs transition-opacity duration-200 ${loading ? "opacity-60" : "opacity-100"}`}>
              <thead className="border-b border-white/[0.06] bg-[#090c13]/50 text-slate-400 font-semibold uppercase text-[10px]">
                <tr>
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Event</th>
                  <th className="py-3 px-4">Actor</th>
                  <th className="py-3 px-4">Case Linked</th>
                  <th className="py-3 px-4 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 px-4 text-slate-300 text-[11px]">
                      {formatDate(log.created_at)}
                    </td>
                    <td className="py-3 px-4 font-bold text-slate-100">
                      {log.event}
                    </td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1 text-[11px] font-sans text-slate-300">
                        {log.actor_type === "USER" ? (
                          <User className="h-3 w-3 text-cyan-400" />
                        ) : (
                          <Cpu className="h-3 w-3 text-indigo-400" />
                        )}
                        {log.actor_type}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {log.case_id ? (
                        <Link
                          href={`/cases/${log.case_id}`}
                          className="text-cyan-400 hover:text-cyan-300 truncate block max-w-[130px] text-[11px]"
                          title={log.case_id}
                        >
                          {log.case_id.slice(0, 8)}...
                        </Link>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedLog(log)}
                      >
                        <span className="font-sans font-semibold text-emerald-400 text-xs">Inspect</span>
                        <ChevronRight className="h-3 w-3 text-emerald-400" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {nextCursor && !loading && (
          <div className="p-4 border-t border-white/[0.06] text-center">
            <Button
              variant="outline"
              size="sm"
              loading={loading}
              onClick={() => fetchLogs(nextCursor, true)}
            >
              Load Next Page
            </Button>
          </div>
        )}
      </div>

      {/* Metadata Inspector Modal */}
      {selectedLog && (
        <Modal
          isOpen={!!selectedLog}
          onClose={() => setSelectedLog(null)}
          title={`Audit Event: ${selectedLog.event}`}
          description={`Log ID: ${selectedLog.id} • Timestamp: ${formatDate(selectedLog.created_at)}`}
          footer={
            <Button variant="primary" onClick={() => setSelectedLog(null)}>
              Done
            </Button>
          }
        >
          <div className="space-y-4 text-xs">
            <div className="rounded-xl border border-white/[0.06] bg-[#090c13] p-3 text-xs space-y-1 font-mono">
              <div>Actor Type: <span className="text-slate-200">{selectedLog.actor_type}</span></div>
              <div>Actor ID: <span className="text-slate-200">{selectedLog.actor_id || "SYSTEM"}</span></div>
              <div>Case ID: <span className="text-slate-200">{selectedLog.case_id || "N/A"}</span></div>
            </div>

            <h4 className="text-[10px] font-semibold text-slate-400 uppercase tracking-widest">
              Immutable Event Payload
            </h4>

            <pre className="max-h-64 overflow-auto rounded-xl border border-white/[0.06] bg-[#05070a] p-3 font-mono text-[10px] text-cyan-300">
              {JSON.stringify(selectedLog.metadata, null, 2)}
            </pre>
          </div>
        </Modal>
      )}
    </div>
  );
}
