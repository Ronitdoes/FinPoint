"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  ClipboardList,
  CheckCircle2,
  AlertOctagon,
  ArrowUpRight,
  RefreshCw,
  Lock,
  Loader2,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Select } from "../../../components/ui/Select";
import { ApproveTaskModal } from "../../../components/modals/ApproveTaskModal";
import { RejectTaskModal } from "../../../components/modals/RejectTaskModal";
import { formatRelativeTime } from "../../../lib/format";
import { canApproveTasks } from "../../../lib/rbac";
import { api } from "../../../lib/api";
import type { HumanTask, AuthMeResponse } from "../../../lib/types";

gsap.registerPlugin(useGSAP);

export default function TasksPage() {
  const [tasks, setTasks] = useState<HumanTask[]>([]);
  const [currentUser, setCurrentUser] = useState<AuthMeResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("PENDING");
  const [loading, setLoading] = useState(true);

  // Modals
  const [approveTask, setApproveTask] = useState<HumanTask | null>(null);
  const [rejectTask, setRejectTask] = useState<HumanTask | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const fetchTasks = useCallback(async () => {
    try {
      setLoading(true);
      const [res, me] = await Promise.all([
        api.tasks.list({ status: statusFilter || undefined, limit: 50 }),
        api.auth.me().catch(() => null),
      ]);
      setTasks(res.items || []);
      if (me) setCurrentUser(me);
    } catch {
      // error handling
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

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

  const handleApproveConfirm = async (notes?: string) => {
    if (!approveTask) return;
    await api.tasks.approve(approveTask.id, notes);
    await fetchTasks();
  };

  const handleRejectConfirm = async (notes: string) => {
    if (!rejectTask) return;
    await api.tasks.reject(rejectTask.id, notes);
    await fetchTasks();
  };

  const canAction = canApproveTasks(currentUser?.role);

  const priorityBadges: Record<string, "danger" | "warning" | "info" | "default"> = {
    URGENT: "danger",
    HIGH: "warning",
    MEDIUM: "info",
    LOW: "default",
  };

  const statusBadges: Record<string, "warning" | "success" | "danger" | "default"> = {
    PENDING: "warning",
    APPROVED: "success",
    REJECTED: "danger",
    CANCELLED: "default",
  };

  return (
    <div ref={containerRef} className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-cyan-400" />
            Human Escalation & Approvals Desk
          </h1>
          <p className="text-xs text-slate-400 mt-0.5 font-normal">
            Review cases requiring operator intervention, high-value sign-off, or dispute resolution
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          loading={loading}
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => fetchTasks()}
        >
          Refresh Inbox
        </Button>
      </div>

      {/* Filter Bar */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-4 shadow-lg shadow-black/40 backdrop-blur-xl">
        <div className="max-w-xs">
          <Select
            label="Task Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: "", label: "All Tasks" },
              { value: "PENDING", label: "Pending Review" },
              { value: "APPROVED", label: "Approved" },
              { value: "REJECTED", label: "Rejected" },
              { value: "CANCELLED", label: "Cancelled" },
            ]}
          />
        </div>
      </div>

      {/* Tasks Table */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 shadow-lg shadow-black/40 overflow-hidden backdrop-blur-xl min-h-[320px] flex flex-col justify-center">
        {loading && tasks.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-400">
            <Loader2 className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-[11px] font-medium text-slate-400">Loading escalation inbox...</span>
          </div>
        ) : tasks.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-500">
            <CheckCircle2 className="mx-auto h-7 w-7 mb-2 opacity-30 text-emerald-400" />
            Inbox clean! No tasks match the selected status filter.
          </div>
        ) : (
          <div className="overflow-x-auto self-stretch">
            <table className={`w-full text-left text-xs transition-opacity duration-200 ${loading ? "opacity-60" : "opacity-100"}`}>
              <thead className="border-b border-white/[0.06] bg-[#090c13]/50 text-slate-400 font-semibold uppercase text-[10px]">
                <tr>
                  <th className="py-3 px-4">Priority</th>
                  <th className="py-3 px-4">Trigger Reason</th>
                  <th className="py-3 px-4">Case Link</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Created</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                {tasks.map((task) => (
                  <tr key={task.id} className="hover:bg-white/[0.02] transition-colors">
                    <td className="py-3.5 px-4">
                      <Badge
                        variant={priorityBadges[task.priority] || "default"}
                        size="sm"
                      >
                        {task.priority}
                      </Badge>
                    </td>
                    <td className="py-3.5 px-4 font-sans text-slate-200">
                      <div className="font-semibold text-xs">{task.reason}</div>
                      {task.notes && (
                        <p className="text-[11px] text-slate-400 mt-0.5 font-normal">{task.notes}</p>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <Link
                        href={`/cases/${task.case_id}`}
                        className="inline-flex items-center gap-1 font-sans text-xs font-semibold text-cyan-400 hover:text-cyan-300"
                      >
                        <span>Inspect Case</span>
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                    <td className="py-3.5 px-4">
                      <Badge
                        variant={statusBadges[task.status] || "default"}
                        size="sm"
                      >
                        {task.status}
                      </Badge>
                    </td>
                    <td className="py-3.5 px-4 text-slate-400 text-[11px]">
                      {formatRelativeTime(task.created_at)}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      {task.status === "PENDING" ? (
                        canAction ? (
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="success"
                              size="sm"
                              icon={<CheckCircle2 className="h-3 w-3" />}
                              onClick={() => setApproveTask(task)}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="danger"
                              size="sm"
                              icon={<AlertOctagon className="h-3 w-3" />}
                              onClick={() => setRejectTask(task)}
                            >
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <span className="text-slate-500 font-sans text-[11px] flex items-center justify-end gap-1">
                            <Lock className="h-3 w-3" />
                            Operations+ Required
                          </span>
                        )
                      ) : (
                        <span className="text-slate-500 font-sans text-[11px]">
                          Resolved
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Approve Modal */}
      <ApproveTaskModal
        isOpen={!!approveTask}
        onClose={() => setApproveTask(null)}
        task={approveTask}
        onConfirm={handleApproveConfirm}
      />

      {/* Reject Modal */}
      <RejectTaskModal
        isOpen={!!rejectTask}
        onClose={() => setRejectTask(null)}
        task={rejectTask}
        onConfirm={handleRejectConfirm}
      />
    </div>
  );
}
