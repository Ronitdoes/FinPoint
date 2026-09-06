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
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Select } from "../../../components/ui/Select";
import { ApproveTaskModal } from "../../../components/modals/ApproveTaskModal";
import { RejectTaskModal } from "../../../components/modals/RejectTaskModal";
import { SkeletonTable } from "../../../components/ui/Skeleton";
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
      const mm = gsap.matchMedia();

      mm.add(
        {
          full: "(prefers-reduced-motion: no-preference)",
          reduced: "(prefers-reduced-motion: reduce)",
        },
        (ctx) => {
          if (ctx.conditions?.reduced) return;
          const q = gsap.utils.selector(containerRef);

          // Section entrance — transforms + autoAlpha only.
          gsap.fromTo(
            q(".fp-rise"),
            { y: 12, autoAlpha: 0 },
            {
              y: 0,
              autoAlpha: 1,
              duration: 0.35,
              stagger: 0.05,
              ease: "power2.out",
              clearProps: "transform",
            }
          );
        }
      );

      return () => mm.revert();
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
    <div ref={containerRef}>
      {/* Outer FinPoint frame */}
      <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="space-y-3">
      {/* Header */}
      <div className="fp-rise flex flex-wrap items-center justify-between gap-4 rounded-2xl px-2 pt-1">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight text-white flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-white/60" />
            Human Escalation & Approvals Desk
          </h1>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
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
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
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
      <div className="fp-rise rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 min-h-[320px] flex flex-col justify-center">
        {loading && tasks.length === 0 ? (
          <SkeletonTable rows={6} cols={6} />
        ) : tasks.length === 0 ? (
          <div className="py-16 text-center text-xs text-white/40">
            <CheckCircle2 className="mx-auto h-7 w-7 mb-2 opacity-30 text-white/60" />
            Inbox clean! No tasks match the selected status filter.
          </div>
        ) : (
          <div className="overflow-x-auto self-stretch">
            <table className={`w-full text-left text-xs transition-opacity duration-200 ${loading ? "opacity-60" : "opacity-100"}`}>
              <thead className="border-b border-white/[0.06] font-semibold uppercase text-[10px] text-white/45">
                <tr>
                  <th className="py-2.5 pr-4">Priority</th>
                  <th className="py-2.5 px-4">Trigger Reason</th>
                  <th className="py-2.5 px-4">Case Link</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Created</th>
                  <th className="py-2.5 pl-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
                {tasks.map((task) => (
                  <tr key={task.id} className="transition-colors hover:bg-white/[0.04]">
                    <td className="py-3.5 px-4">
                      <Badge
                        variant={priorityBadges[task.priority] || "default"}
                        size="sm"
                      >
                        {task.priority}
                      </Badge>
                    </td>
                    <td className="py-3.5 px-4 font-sans text-white/75">
                      <div className="font-semibold text-xs">{task.reason}</div>
                      {task.notes && (
                        <p className="text-[11px] text-white/45 mt-0.5 font-normal">{task.notes}</p>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <Link
                        href={`/cases/${task.case_id}`}
                        className="inline-flex items-center gap-1 font-sans text-xs font-semibold text-cyan-300 hover:text-cyan-200"
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
                    <td className="py-3.5 px-4 text-white/45 text-[11px]">
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
                          <span className="text-white/40 font-sans text-[11px] flex items-center justify-end gap-1">
                            <Lock className="h-3 w-3" />
                            Operations+ Required
                          </span>
                        )
                      ) : (
                        <span className="text-white/40 font-sans text-[11px]">
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
      </div>
    </div>
  );
}
