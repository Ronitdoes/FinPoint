"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  FolderKanban,
  Search,
  ArrowUpRight,
  RefreshCw,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Select } from "../../../components/ui/Select";
import { formatMoney } from "../../../lib/money";
import { formatDate, getCaseStatusColor } from "../../../lib/format";
import { api } from "../../../lib/api";
import type { CaseSummary } from "../../../lib/types";
import { SkeletonTable } from "../../../components/ui/Skeleton";

gsap.registerPlugin(useGSAP);

interface CaseFilterDef {
  status?: string;
  risk_type?: string;
  min_amount?: number;
}

interface SavedFilterItem {
  id: string;
  label: string;
  filter: CaseFilterDef;
}

// ₹50,000 in minor units — keep in sync with backend
// DEFAULT_AMOUNT_HIGH_MINOR_UNITS (apps/backend/src/modules/risk/engine/rules.ts).
const HIGH_VALUE_THRESHOLD_MINOR = 5_000_000;

const SAVED_FILTERS: SavedFilterItem[] = [
  { id: "all", label: "All Cases", filter: {} },
  { id: "active", label: "Active Pipelines", filter: { status: "IN_PROGRESS" } },
  { id: "escalated", label: "Escalated to Human", filter: { status: "ESCALATED" } },
  // High-value preset mirrors backend DEFAULT_AMOUNT_HIGH_MINOR_UNITS (₹50,000).
  { id: "high_value", label: "High Value (≥ ₹50,000)", filter: { min_amount: HIGH_VALUE_THRESHOLD_MINOR } },
  { id: "invoices", label: "Overdue Invoices", filter: { risk_type: "OVERDUE_INVOICE" } },
  { id: "recovered", label: "Recovered Cases", filter: { status: "RECOVERED" } },
];

export default function CasesPage() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [activeSavedFilter, setActiveSavedFilter] = useState("all");

  // Filter state
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [riskTypeFilter, setRiskTypeFilter] = useState<string>("");
  const [minAmount, setMinAmount] = useState<string>("");
  const [searchCustomer, setSearchCustomer] = useState<string>("");
  // Debounced search
  const [debouncedCustomer, setDebouncedCustomer] = useState("");
  const [debouncedMinAmount, setDebouncedMinAmount] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedCustomer(searchCustomer), 300);
    return () => clearTimeout(timer);
  }, [searchCustomer]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedMinAmount(minAmount), 300);
    return () => clearTimeout(timer);
  }, [minAmount]);

  const containerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const fetchCases = useCallback(
    async (cursor?: string, append = false) => {
      try {
        setLoading(true);
        const res = await api.cases.list({
          status: statusFilter || undefined,
          risk_type: riskTypeFilter || undefined,
          min_amount: debouncedMinAmount ? parseInt(debouncedMinAmount, 10) * 100 : undefined,
          customer_id: debouncedCustomer.trim() || undefined,
          limit: 25,
          cursor,
        });

        if (append) {
          setCases((prev) => [...prev, ...res.items]);
        } else {
          setCases(res.items);
        }
        setNextCursor(res.nextCursor);
      } catch {
        // error handling
      } finally {
        setLoading(false);
      }
    },
    [statusFilter, riskTypeFilter, debouncedMinAmount, debouncedCustomer],
  );

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

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

          // Frame -> header -> panels. Transforms + autoAlpha only.
          const tl = gsap.timeline({
            defaults: { duration: 0.55, ease: "power3.out" },
          });
          tl.addLabel("frame", 0);
          tl.fromTo(
            q(".fp-frame"),
            { y: 14, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.5, clearProps: "transform" },
            "frame"
          );
          tl.fromTo(
            q(".fp-rise"),
            { y: 18, autoAlpha: 0 },
            {
              y: 0,
              autoAlpha: 1,
              duration: 0.5,
              stagger: { each: 0.07, from: "start" },
              clearProps: "transform",
            },
            "frame+=0.1"
          );
        }
      );

      return () => mm.revert();
    },
    { scope: containerRef }
  );

  const handleApplySavedFilter = (saved: SavedFilterItem) => {
    setActiveSavedFilter(saved.id);
    setStatusFilter(saved.filter.status || "");
    setRiskTypeFilter(saved.filter.risk_type || "");
    setMinAmount(saved.filter.min_amount ? String(saved.filter.min_amount / 100) : "");
  };

  return (
    <div ref={containerRef}>
      {/* Outer frame */}
      <div className="fp-frame rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="space-y-3">
      {/* Header bar */}
      <div className="fp-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl px-2 pt-1">
        <div className="min-w-52">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-white">
            <FolderKanban className="h-4 w-4 text-white/60" />
            Active Recovery Cases & In-Flight Interventions
          </h1>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
            Real-time pipeline of open financial leakage cases, AI decision paths, and recovery statuses
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          loading={loading}
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => fetchCases()}
        >
          Refresh Cases
        </Button>
        </div>
      </div>

      {/* Filter / Search Bar */}
      <div className="fp-rise space-y-3.5 rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
        {/* Saved preset quick chips */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.06] pb-3.5">
          <span className="mr-1 text-[10px] font-medium uppercase tracking-wider text-white/45">
            Quick Views:
          </span>
          {SAVED_FILTERS.map((filter) => (
            <button
              key={filter.id}
              onClick={() => handleApplySavedFilter(filter)}
              className={`cursor-pointer rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                activeSavedFilter === filter.id
                  ? "bg-white font-semibold text-black"
                  : "border border-white/[0.09] text-white/55 hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Input
            placeholder="Filter by Customer UUID"
            icon={<Search className="h-3.5 w-3.5" />}
            value={searchCustomer}
            onChange={(e) => {
              setSearchCustomer(e.target.value);
              setActiveSavedFilter("custom");
            }}
          />

          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setActiveSavedFilter("custom");
            }}
            options={[
              { value: "", label: "All Case Statuses" },
              { value: "DETECTED", label: "DETECTED" },
              { value: "QUALIFIED", label: "QUALIFIED" },
              { value: "DECISION_PENDING", label: "DECISION_PENDING" },
              { value: "POLICY_REVIEW", label: "POLICY_REVIEW" },
              { value: "IN_PROGRESS", label: "IN_PROGRESS" },
              { value: "WAITING", label: "WAITING" },
              { value: "RECOVERED", label: "RECOVERED" },
              { value: "STOPPED", label: "STOPPED" },
              { value: "ESCALATED", label: "ESCALATED" },
              { value: "FAILED", label: "FAILED" },
              { value: "PAUSED", label: "PAUSED" },
            ]}
          />

          <Select
            value={riskTypeFilter}
            onChange={(e) => {
              setRiskTypeFilter(e.target.value);
              setActiveSavedFilter("custom");
            }}
            options={[
              { value: "", label: "All Risk Surfaces" },
              { value: "FAILED_PAYMENT", label: "Failed Payment" },
              { value: "CHECKOUT_ABANDONED", label: "Checkout Abandoned" },
              { value: "OVERDUE_INVOICE", label: "Overdue Invoice" },
              { value: "DISPUTE_RISK", label: "Dispute Risk" },
              { value: "SUBSCRIPTION_CHURN", label: "Subscription Churn" },
            ]}
          />

          <Input
            type="number"
            placeholder="Min Amount in ₹ (e.g. 5000)"
            value={minAmount}
            onChange={(e) => {
              setMinAmount(e.target.value);
              setActiveSavedFilter("custom");
            }}
          />
        </div>
      </div>

      {/* Cases Table */}
      <div ref={tableRef} className="fp-rise flex min-h-[320px] flex-col justify-center overflow-hidden rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
        {loading && cases.length === 0 ? (
          <SkeletonTable rows={8} cols={7} />
        ) : cases.length === 0 ? (
          <div className="py-16 text-center text-xs text-white/40">
            <FolderKanban className="mx-auto mb-2 h-7 w-7 text-white/60 opacity-30" />
            No recovery cases match the current filter criteria
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.06] text-[10px] font-semibold uppercase text-white/45">
                <tr>
                  <th className="py-2.5 pr-4">Case #</th>
                  <th className="py-2.5 px-4">Customer</th>
                  <th className="py-2.5 px-4">Risk Surface</th>
                  <th className="py-2.5 px-4 text-right">Amount at Risk</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Opened At</th>
                  <th className="py-2.5 pl-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
                {cases.map((c) => {
                  const statusStyle = getCaseStatusColor(c.status);
                  return (
                    <tr key={c.id} className="transition-colors hover:bg-white/[0.04]">
                      <td className="py-3 pr-4 font-bold text-white">
                        {c.case_number}
                      </td>
                      <td className="max-w-[140px] truncate py-3 px-4 font-sans text-[11px] text-white/45" title={c.customer_id}>
                        {c.customer_id}
                      </td>
                      <td className="py-3 px-4 font-sans text-xs font-medium text-white/75">
                        {c.risk_type.replace(/_/g, " ")}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-white tabular-nums">
                        {formatMoney(c.amount_at_risk, c.currency)}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold border ${statusStyle.bg} ${statusStyle.text} ${statusStyle.border}`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${statusStyle.dot}`} />
                          {c.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-[11px] text-white/45">
                        {formatDate(c.opened_at)}
                      </td>
                      <td className="py-3 pl-4 text-right">
                        <Link
                          href={`/cases/${c.id}`}
                          className="inline-flex items-center gap-1 font-sans text-xs font-semibold text-cyan-300 hover:text-cyan-200"
                        >
                          <span>Inspect</span>
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Cursor Pagination Button */}
        {nextCursor && (
          <div className="border-t border-white/[0.06] p-4 text-center">
            <Button
              variant="outline"
              size="sm"
              loading={loading}
              onClick={() => fetchCases(nextCursor, true)}
            >
              Load Next Page
            </Button>
          </div>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}
