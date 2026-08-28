/**
 * Formatting and badge styling utilities for dates, statuses, and rates.
 */

export function formatDate(dateInput: string | Date | null | undefined): string {
  if (!dateInput) return "—";
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

export function formatRelativeTime(dateInput: string | Date | null | undefined): string {
  if (!dateInput) return "—";
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  if (isNaN(date.getTime())) return "—";

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 45) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return formatDate(date);
}

export function formatPercent(rate: number | null | undefined, decimals = 1): string {
  if (rate === null || rate === undefined || isNaN(rate)) return "—";
  return `${rate.toFixed(decimals)}%`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return "—";
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

export function getCaseStatusColor(status: string): {
  bg: string;
  text: string;
  border: string;
  dot: string;
} {
  switch (status) {
    case "RECOVERED":
      return {
        bg: "bg-emerald-500/10 dark:bg-emerald-500/15",
        text: "text-emerald-600 dark:text-emerald-400",
        border: "border-emerald-500/30",
        dot: "bg-emerald-500",
      };
    case "IN_PROGRESS":
      return {
        bg: "bg-cyan-500/10 dark:bg-cyan-500/15",
        text: "text-cyan-600 dark:text-cyan-400",
        border: "border-cyan-500/30",
        dot: "bg-cyan-500 animate-pulse",
      };
    case "WAITING":
      return {
        bg: "bg-amber-500/10 dark:bg-amber-500/15",
        text: "text-amber-600 dark:text-amber-400",
        border: "border-amber-500/30",
        dot: "bg-amber-500",
      };
    case "ESCALATED":
      return {
        bg: "bg-rose-500/10 dark:bg-rose-500/15",
        text: "text-rose-600 dark:text-rose-400",
        border: "border-rose-500/30",
        dot: "bg-rose-500 animate-ping",
      };
    case "STOPPED":
    case "PAUSED":
      return {
        bg: "bg-slate-500/10 dark:bg-slate-500/15",
        text: "text-slate-600 dark:text-slate-400",
        border: "border-slate-500/30",
        dot: "bg-slate-500",
      };
    case "FAILED":
      return {
        bg: "bg-red-500/10 dark:bg-red-500/15",
        text: "text-red-600 dark:text-red-400",
        border: "border-red-500/30",
        dot: "bg-red-500",
      };
    case "DETECTED":
    case "QUALIFIED":
    case "DECISION_PENDING":
    case "POLICY_REVIEW":
    default:
      return {
        bg: "bg-blue-500/10 dark:bg-blue-500/15",
        text: "text-blue-600 dark:text-blue-400",
        border: "border-blue-500/30",
        dot: "bg-blue-500",
      };
  }
}

export function getRiskBandColor(band: string): {
  bg: string;
  text: string;
  border: string;
} {
  switch (band) {
    case "CRITICAL":
      return {
        bg: "bg-rose-500/15",
        text: "text-rose-400",
        border: "border-rose-500/40",
      };
    case "HIGH":
      return {
        bg: "bg-orange-500/15",
        text: "text-orange-400",
        border: "border-orange-500/40",
      };
    case "MEDIUM":
      return {
        bg: "bg-amber-500/15",
        text: "text-amber-400",
        border: "border-amber-500/40",
      };
    case "LOW":
    default:
      return {
        bg: "bg-emerald-500/15",
        text: "text-emerald-400",
        border: "border-emerald-500/40",
      };
  }
}
