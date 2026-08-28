"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  Clock,
  RefreshCw,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ShieldCheck,
  Send,
  DollarSign,
  User,
  Cpu,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { formatDate, formatRelativeTime } from "../../lib/format";
import { api } from "../../lib/api";
import type { TimelineItem } from "../../lib/types";

gsap.registerPlugin(useGSAP);

export interface CaseTimelineProps {
  caseId: string;
  initialItems?: TimelineItem[];
}

const EVENT_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
  PAYMENT_FAILED: {
    icon: <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />,
    color: "bg-rose-500/15 border-rose-500/30 text-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]",
  },
  RISK_CALCULATED: {
    icon: <Zap className="h-3.5 w-3.5 text-amber-400" />,
    color: "bg-amber-500/15 border-amber-500/30 text-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.2)]",
  },
  AI_DECISION_CREATED: {
    icon: <Sparkles className="h-3.5 w-3.5 text-indigo-400" />,
    color: "bg-indigo-500/15 border-indigo-500/30 text-indigo-300 shadow-[0_0_10px_rgba(99,102,241,0.2)]",
  },
  POLICY_ALLOWED: {
    icon: <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />,
    color: "bg-emerald-500/15 border-emerald-500/30 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]",
  },
  POLICY_REJECTED: {
    icon: <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />,
    color: "bg-rose-500/15 border-rose-500/30 text-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]",
  },
  WORKFLOW_STARTED: {
    icon: <Zap className="h-3.5 w-3.5 text-cyan-400" />,
    color: "bg-cyan-500/15 border-cyan-500/30 text-cyan-300 shadow-[0_0_10px_rgba(6,182,212,0.2)]",
  },
  WHATSAPP_SENT: {
    icon: <Send className="h-3.5 w-3.5 text-emerald-400" />,
    color: "bg-emerald-500/15 border-emerald-500/30 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.2)]",
  },
  EMAIL_SENT: {
    icon: <Send className="h-3.5 w-3.5 text-blue-400" />,
    color: "bg-blue-500/15 border-blue-500/30 text-blue-300 shadow-[0_0_10px_rgba(59,130,246,0.2)]",
  },
  PAYMENT_RETRY_STARTED: {
    icon: <RefreshCw className="h-3.5 w-3.5 text-cyan-400" />,
    color: "bg-cyan-500/15 border-cyan-500/30 text-cyan-300 shadow-[0_0_10px_rgba(6,182,212,0.2)]",
  },
  PAYMENT_SUCCEEDED: {
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />,
    color: "bg-emerald-500/15 border-emerald-500/30 text-emerald-300 shadow-[0_0_10px_rgba(16,185,129,0.3)]",
  },
  RECOVERY_RECORDED: {
    icon: <DollarSign className="h-3.5 w-3.5 text-emerald-400" />,
    color: "bg-emerald-500/20 border-emerald-500/40 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.3)]",
  },
  HUMAN_TASK_APPROVED: {
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-cyan-400" />,
    color: "bg-cyan-500/15 border-cyan-500/30 text-cyan-300 shadow-[0_0_10px_rgba(6,182,212,0.2)]",
  },
  HUMAN_TASK_REJECTED: {
    icon: <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />,
    color: "bg-rose-500/15 border-rose-500/30 text-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]",
  },
};

export function CaseTimeline({ caseId, initialItems = [] }: CaseTimelineProps) {
  const [items, setItems] = useState<TimelineItem[]>(initialItems);
  const [loading, setLoading] = useState<boolean>(false);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState<number>(30);
  const timelineRef = useRef<HTMLDivElement>(null);

  const searchParams = useSearchParams();
  const isDemo = searchParams.get("demo") === "1";

  const fetchTimeline = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.cases.getTimeline(caseId, { order: "asc", limit: 100 });
      if (res.items) {
        setItems(res.items);
      }
    } catch {
      // ignore transient polling errors
    } finally {
      setLoading(false);
      setSecondsUntilRefresh(30);
    }
  }, [caseId]);

  // Initial load if no initialItems
  useEffect(() => {
    if (initialItems.length === 0) {
      fetchTimeline();
    }
  }, [fetchTimeline, initialItems.length]);

  // 30s Polling effect
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      setSecondsUntilRefresh((prev) => {
        if (prev <= 1) {
          fetchTimeline();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [autoRefresh, fetchTimeline]);

  // GSAP stagger on timeline items
  useGSAP(
    () => {
      if (items.length > 0 && timelineRef.current) {
        const elements = timelineRef.current.querySelectorAll(".timeline-event-item");
        if (elements.length > 0) {
          gsap.fromTo(
            elements,
            { opacity: 0, x: -10 },
            {
              opacity: 1,
              x: 0,
              duration: 0.3,
              stagger: 0.03,
              ease: "power2.out",
              clearProps: "opacity,transform",
            }
          );
        }
      }
    },
    { dependencies: [items.length], scope: timelineRef }
  );

  const toggleExpand = (id: string) => {
    setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div
      ref={timelineRef}
      className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 backdrop-blur-xl"
    >
      {/* Header & Polling Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 mb-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <Clock className="h-4 w-4" />
          </div>
          <div>
            <h3
              className={`font-semibold text-slate-100 tracking-tight flex items-center gap-2 ${
                isDemo ? "text-base" : "text-xs"
              }`}
            >
              Real-Time Case Event Timeline
              {isDemo && (
                <Badge variant="info" size="sm">
                  DEMO MODE
                </Badge>
              )}
            </h3>
            <p className="text-[11px] text-slate-400 font-normal">
              Deterministic sequence of all audit, AI, policy & execution events
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono transition-colors border cursor-pointer ${
              autoRefresh
                ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-400"
                : "bg-white/[0.04] border-white/[0.08] text-slate-400"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                autoRefresh ? "bg-emerald-400 animate-pulse" : "bg-slate-500"
              }`}
            />
            {autoRefresh ? `Polling in ${secondsUntilRefresh}s` : "Polling Paused"}
          </button>

          <Button
            variant="outline"
            size="sm"
            loading={loading}
            icon={<RefreshCw className="h-3 w-3" />}
            onClick={() => fetchTimeline()}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* Timeline Stream */}
      {items.length === 0 ? (
        <div className="py-12 text-center text-xs text-slate-500">
          <Clock className="mx-auto h-8 w-8 mb-2 opacity-30" />
          No events recorded for this case timeline yet
        </div>
      ) : (
        <div className="relative pl-6 space-y-4 before:absolute before:left-3 before:top-2 before:bottom-2 before:w-px before:bg-gradient-to-b before:from-white/[0.12] before:via-white/[0.06] before:to-transparent">
          {items.map((item) => {
            const meta = EVENT_ICONS[item.event_type] || {
              icon: <Zap className="h-3.5 w-3.5 text-slate-400" />,
              color: "bg-slate-800 border-white/[0.08] text-slate-300",
            };
            const isExpanded = !!expandedItems[item.id];
            const hasMetadata = item.metadata && Object.keys(item.metadata).length > 0;

            return (
              <div
                key={item.id}
                className="timeline-event-item group relative transition-all duration-150"
              >
                {/* Timeline node icon */}
                <div
                  className={`absolute -left-6 top-0.5 flex h-6 w-6 items-center justify-center rounded-full border shadow-md ${meta.color}`}
                >
                  {meta.icon}
                </div>

                {/* Event Card */}
                <div
                  className={`rounded-xl border border-white/[0.06] bg-[#090c13]/70 p-3.5 transition-all hover:border-white/[0.12] hover:bg-[#0e131e] ${
                    isDemo ? "text-sm p-4" : "text-xs"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-slate-100 text-xs">
                        {item.event_type}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
                        {item.actor_type === "USER" ? (
                          <User className="h-2.5 w-2.5 text-cyan-400" />
                        ) : (
                          <Cpu className="h-2.5 w-2.5 text-indigo-400" />
                        )}
                        {item.actor_type}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-slate-400 text-[10px] font-mono">
                      <span>{formatDate(item.timestamp)}</span>
                      <span className="text-slate-600">•</span>
                      <span>{formatRelativeTime(item.timestamp)}</span>
                    </div>
                  </div>

                  <p className="text-slate-300 font-sans leading-relaxed text-xs">
                    {item.summary || "Event executed successfully"}
                  </p>

                  {/* Metadata inspector */}
                  {hasMetadata && (
                    <div className="mt-2 pt-2 border-t border-white/[0.05]">
                      <button
                        onClick={() => toggleExpand(item.id)}
                        className="flex items-center gap-1 text-[10px] font-mono text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                      >
                        {isExpanded ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                        <span>
                          {isExpanded ? "Hide Payload" : "Inspect Event Metadata"}
                        </span>
                      </button>

                      {isExpanded && (
                        <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-white/[0.08] bg-[#05070a] p-2.5 font-mono text-[10px] text-cyan-300 leading-tight">
                          {JSON.stringify(item.metadata, null, 2)}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
