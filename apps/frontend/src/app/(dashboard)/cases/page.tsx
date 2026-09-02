"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  FolderKanban,
  Search,
  ArrowUpRight,
  RefreshCw,
  Loader2,
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

const SAVED_FILTERS: SavedFilterItem[] = [
  { id: "all", label: "All Cases", filter: {} },
  { id: "active", label: "Active Pipelines", filter: { status: "IN_PROGRESS" } },
  { id: "escalated", label: "Escalated to Human", filter: { status: "ESCALATED" } },
  { id: "high_value", label: "High Value (≥ ₹50,000)", filter: { min_amount: 5000000 } },
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

  const handleApplySavedFilter = (saved: SavedFilterItem) => {
    setActiveSavedFilter(saved.id);
    setStatusFilter(saved.filter.status || "");
    setRiskTypeFilter(saved.filter.risk_type || "");
    setMinAmount(saved.filter.min_amount ? String(saved.filter.min_amount / 100) : "");
  };

  return (
    <div ref={containerRef} className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <FolderKanban className="h-5 w-5 text-emerald-400" />
            Active Recovery Cases & In-Flight Interventions
          </h1>
          <p className="text-xs text-slate-400 mt-0.5 font-normal">
            Real-time pipeline of open financial leakage cases, AI decision paths, and recovery statuses
          </p>
        </div>

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

      {/* Filter / Search Bar */}
      <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-4 shadow-lg shadow-black/40 backdrop-blur-xl space-y-3.5">
        {/* Saved preset quick chips */}
        <div className="flex flex-wrap items-center gap-1.5 pb-2 border-b border-white/[0.05]">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mr-1">
            Quick Views:
          </span>
          {SAVED_FILTERS.map((filter) => (
            <button
              key={filter.id}
              onClick={() => handleApplySavedFilter(filter)}
              className={`rounded-xl px-2.5 py-1 text-xs font-semibold transition-all cursor-pointer ${
                activeSavedFilter === filter.id
                  ? "bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 shadow-sm"
                  : "bg-white/[0.03] border border-white/[0.06] text-slate-400 hover:text-slate-200 hover:bg-white/[0.06]"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Input
            placeholder="Search by Customer ID (e.g. cus_...)"
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
      <div ref={tableRef} className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 shadow-lg shadow-black/40 overflow-hidden backdrop-blur-xl min-h-[320px] flex flex-col justify-center">
        {loading && cases.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center gap-2.5 text-xs text-slate-400">
            <Loader2 className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-[11px] font-medium text-slate-400">Loading cases pipeline...</span>
          </div>
        ) : cases.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-500">
            <FolderKanban className="mx-auto h-7 w-7 mb-2 opacity-30 text-emerald-400" />
            No recovery cases match the current filter criteria
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-white/[0.06] bg-[#090c13]/50 text-slate-400 font-semibold uppercase text-[10px]">
                <tr>
                  <th className="py-3 px-4">Case #</th>
                  <th className="py-3 px-4">Customer</th>
                  <th className="py-3 px-4">Risk Surface</th>
                  <th className="py-3 px-4 text-right">Amount at Risk</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Opened At</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                {cases.map((c) => {
                  const statusStyle = getCaseStatusColor(c.status);
                  return (
                    <tr key={c.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="py-3 px-4 font-bold text-slate-100">
                        {c.case_number}
                      </td>
                      <td className="py-3 px-4 text-slate-400 font-sans truncate max-w-[140px] text-[11px]" title={c.customer_id}>
                        {c.customer_id}
                      </td>
                      <td className="py-3 px-4 font-sans font-medium text-slate-200 text-xs">
                        {c.risk_type.replace(/_/g, " ")}
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-slate-100 tabular-nums">
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
                      <td className="py-3 px-4 text-slate-400 text-[11px]">
                        {formatDate(c.opened_at)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <Link
                          href={`/cases/${c.id}`}
                          className="inline-flex items-center gap-1 text-xs font-sans font-semibold text-emerald-400 hover:text-emerald-300 transition-colors"
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
          <div className="p-4 border-t border-white/[0.06] text-center">
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
  );
}
