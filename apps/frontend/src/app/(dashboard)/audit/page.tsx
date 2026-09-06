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
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Select } from "../../../components/ui/Select";
import { Modal } from "../../../components/ui/Modal";
import { SkeletonTable } from "../../../components/ui/Skeleton";
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
      const mm = gsap.matchMedia();

      mm.add(
        {
          full: "(prefers-reduced-motion: no-preference)",
          reduced: "(prefers-reduced-motion: reduce)",
        },
        (ctx) => {
          if (ctx.conditions?.reduced) return;
          const q = gsap.utils.selector(containerRef);

          // Transforms + autoAlpha only; frame first, then staggered panels.
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
        }
      );

      return () => mm.revert();
    },
    { scope: containerRef }
  );

  // Non-Admin 403 Access Guard View
  if (currentUser && !canManageAdmin(currentUser.role)) {
    return (
      <div className="rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-8">
          <div className="py-8 text-center space-y-4 max-w-md mx-auto">
            <div className="p-4 rounded-full bg-white/[0.04] border border-white/[0.12] inline-flex">
              <Lock className="h-8 w-8 text-white/70" />
            </div>
            <h2 className="text-[13px] font-semibold tracking-tight text-white">
              Administrator Role Required
            </h2>
            <p className="text-[11px] font-normal text-white/45 leading-relaxed">
              The compliance audit trail is strictly restricted to operators with the <strong>ADMIN</strong> role. Your current role is <strong>{currentUser.role}</strong>.
            </p>
            <Link href="/dashboard">
              <Button variant="outline" size="sm">
                Return to Dashboard
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      {/* Outer frame */}
      <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="space-y-3">
      {/* Header */}
      <div className="fp-rise flex flex-wrap items-center justify-between gap-4 rounded-2xl px-2 pt-1">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight text-white flex items-center gap-2">
            <FileSearch className="h-5 w-5 text-white/60" />
            Compliance Audit & Security Log Trail
          </h1>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
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
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
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
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 min-h-[320px] flex flex-col justify-center">
        {loading && logs.length === 0 ? (
          <SkeletonTable rows={8} cols={5} className="self-stretch" />
        ) : logs.length === 0 ? (
          <div className="py-16 text-center text-xs text-white/40">
            <FileSearch className="mx-auto h-7 w-7 mb-2 opacity-30 text-white/60" />
            No audit records found matching filter criteria
          </div>
        ) : (
          <div className="overflow-x-auto self-stretch">
            <table className={`w-full text-left text-xs transition-opacity duration-200 ${loading ? "opacity-60" : "opacity-100"}`}>
              <thead className="border-b border-white/[0.06] font-semibold uppercase text-[10px] text-white/45">
                <tr>
                  <th className="py-2.5 pr-4">Timestamp</th>
                  <th className="py-2.5 px-4">Event</th>
                  <th className="py-2.5 px-4">Actor</th>
                  <th className="py-2.5 px-4">Case Linked</th>
                  <th className="py-2.5 pl-4 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
                {logs.map((log) => (
                  <tr key={log.id} className="transition-colors hover:bg-white/[0.04]">
                    <td className="py-3 pr-4 text-white/45 text-[11px]">
                      {formatDate(log.created_at)}
                    </td>
                    <td className="py-3 px-4 font-bold text-white">
                      {log.event}
                    </td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1 text-[11px] font-sans text-white/75">
                        {log.actor_type === "USER" ? (
                          <User className="h-3 w-3 text-white/60" />
                        ) : (
                          <Cpu className="h-3 w-3 text-white/60" />
                        )}
                        {log.actor_type}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {log.case_id ? (
                        <Link
                          href={`/cases/${log.case_id}`}
                          className="text-cyan-300 hover:text-cyan-200 truncate block max-w-[130px] text-[11px]"
                          title={log.case_id}
                        >
                          {log.case_id.slice(0, 8)}...
                        </Link>
                      ) : (
                        <span className="text-white/25">—</span>
                      )}
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedLog(log)}
                      >
                        <span className="font-sans font-semibold text-white/80 text-xs">Inspect</span>
                        <ChevronRight className="h-3 w-3 text-white/50" />
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
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5 text-xs space-y-1 font-mono text-white/55">
              <div>Actor Type: <span className="text-white">{selectedLog.actor_type}</span></div>
              <div>Actor ID: <span className="text-white">{selectedLog.actor_id || "SYSTEM"}</span></div>
              <div>Case ID: <span className="text-white">{selectedLog.case_id || "N/A"}</span></div>
            </div>

            <h4 className="text-[10px] font-medium uppercase tracking-wider text-white/45">
              Immutable Event Payload
            </h4>

            <pre className="max-h-64 overflow-auto rounded-2xl border border-white/[0.07] bg-black/50 p-3.5 font-mono text-[10px] text-cyan-300">
              {JSON.stringify(selectedLog.metadata, null, 2)}
            </pre>
          </div>
        </Modal>
      )}
        </div>
      </div>
    </div>
  );
}
