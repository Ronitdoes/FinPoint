"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Settings as SettingsIcon,
  Key,
  UserPlus,
  Trash2,
  Lock,
  Sparkles,
  Zap,
  RefreshCw,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { Tabs } from "../../../components/ui/Tabs";
import { SkeletonStats, SkeletonTable } from "../../../components/ui/Skeleton";
import { CreateUserModal } from "../../../components/modals/CreateUserModal";
import { CreateApiKeyModal } from "../../../components/modals/CreateApiKeyModal";
import { DegradedModeBanner } from "../../../components/DegradedModeBanner";
import { formatDate } from "../../../lib/format";
import { canManageAdmin } from "../../../lib/rbac";
import { api } from "../../../lib/api";
import type { User, ApiKey, AuthMeResponse, UserRole } from "../../../lib/types";

gsap.registerPlugin(useGSAP);

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("profile");
  const [currentUser, setCurrentUser] = useState<AuthMeResponse | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);

  // Modals
  const [createUserModal, setCreateUserModal] = useState(false);
  const [createKeyModal, setCreateKeyModal] = useState(false);

  // Mock Simulator form
  const [demoKey, setDemoKey] = useState("pay_demo_test_001");
  const [demoOutcome, setDemoOutcome] = useState<"SUCCEEDED" | "FAILED">("SUCCEEDED");
  const [demoFailureCode, setDemoFailureCode] = useState("insufficient_funds");
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const tabContentRef = useRef<HTMLDivElement>(null);

  const fetchSettingsData = useCallback(async () => {
    try {
      setLoading(true);
      const me = await api.auth.me();
      setCurrentUser(me);

      if (canManageAdmin(me.role)) {
        const [usersRes, keysRes] = await Promise.all([
          api.admin.listUsers().catch(() => ({ users: [] })),
          api.admin.listApiKeys().catch(() => []),
        ]);
        setUsers(usersRes.users || []);
        setApiKeys(Array.isArray(keysRes) ? keysRes : []);
      }
    } catch {
      // error handling
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettingsData();
  }, [fetchSettingsData]);

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
          // Transforms + autoAlpha only.
          if (tabContentRef.current) {
            gsap.fromTo(
              tabContentRef.current,
              { y: 12, autoAlpha: 0 },
              {
                y: 0,
                autoAlpha: 1,
                duration: 0.4,
                ease: "power3.out",
                clearProps: "transform",
              }
            );
          }
        }
      );

      return () => mm.revert();
    },
    { dependencies: [activeTab], scope: containerRef }
  );

  const handleCreateUser = async (input: { email: string; role: UserRole; name: string; password: string }) => {
    await api.admin.createUser(input);
    await fetchSettingsData();
  };

  const handleRevokeKey = async (id: string) => {
    if (confirm("Are you sure you want to revoke this API key immediately?")) {
      await api.admin.revokeApiKey(id);
      await fetchSettingsData();
    }
  };

  const handleRunSimulator = async () => {
    try {
      setSimulating(true);
      setSimResult(null);
      await api.demo.setPaymentOutcomeOverride(demoKey, {
        status: demoOutcome,
        failureCode: demoOutcome === "FAILED" ? demoFailureCode : undefined,
        failureMessage: demoOutcome === "FAILED" ? "Simulated test failure" : undefined,
      });
      setSimResult(`Override configured: Next attempt for ${demoKey} will return ${demoOutcome}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to configure simulation";
      setSimResult(`Error: ${message}`);
    } finally {
      setSimulating(false);
    }
  };

  const isAdmin = canManageAdmin(currentUser?.role);

  const roleBadges: Record<string, "danger" | "info" | "success" | "warning" | "default"> = {
    ADMIN: "danger",
    FINANCE: "info",
    OPERATIONS: "success",
    SUPPORT: "warning",
    VIEWER: "default",
  };

  return (
    <div ref={containerRef}>
      {/* Outer frame */}
      <div className="rounded-[26px] border border-white/10 bg-[#0c0c0e]/85 p-3 shadow-[0_32px_80px_-32px_rgba(0,0,0,0.9)] backdrop-blur-2xl sm:p-4">
        <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl px-2 pt-1">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight text-white flex items-center gap-2">
            <SettingsIcon className="h-5 w-5 text-white/60" />
            Control Plane Settings & Team Administration
          </h1>
          <p className="mt-0.5 text-[11px] font-normal text-white/45">
            Tenant configuration, operator user provisioning, API key management, and demo simulation
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          loading={loading}
          icon={<RefreshCw className="h-3 w-3" />}
          onClick={() => fetchSettingsData()}
        >
          Refresh Settings
        </Button>
      </div>

      {/* Tabs */}
      <Tabs
        activeTab={activeTab}
        onChange={setActiveTab}
        tabs={[
          { id: "profile", label: "Tenant Profile" },
          { id: "users", label: "Team Members", count: users.length },
          { id: "api-keys", label: "API Credentials", count: apiKeys.length },
          { id: "simulator", label: "Demo & Mock Controls" },
        ]}
      />

      <div ref={tabContentRef}>
        {/* Profile Tab */}
        {activeTab === "profile" && (
          <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 space-y-4">
            <div className="border-b border-white/[0.06] pb-3.5">
              <h2 className="text-[13px] font-semibold tracking-tight text-white">
                Organization & Tenant Environment
              </h2>
              <p className="mt-0.5 text-[11px] font-normal text-white/45">
                Active configuration for this isolated financial tenant partition
              </p>
            </div>

            {/* Degraded autonomy mode ops toggle (s-34 doctrine) */}
            <DegradedModeBanner />

            {loading && !currentUser ? (
              <SkeletonStats count={4} />
            ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs font-mono">
              <div className="p-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.04] space-y-1">
                <span className="text-[10px] font-sans font-medium uppercase tracking-wider text-white/45 block">Tenant Identifier</span>
                <span className="text-sm font-bold text-white block">{currentUser?.tenantId || "default"}</span>
              </div>

              <div className="p-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.04] space-y-1">
                <span className="text-[10px] font-sans font-medium uppercase tracking-wider text-white/45 block">Currency & Localization</span>
                <span className="text-sm font-bold text-white block">INR (₹) — tenant default (per-record currency on cases)</span>
              </div>

              <div className="p-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.04] space-y-1">
                <span className="text-[10px] font-sans font-medium uppercase tracking-wider text-white/45 block">Active Operator Role</span>
                <span className="text-sm font-bold text-white block">{currentUser?.role}</span>
              </div>

              <div className="p-3.5 rounded-2xl border border-white/[0.07] bg-white/[0.04] space-y-1">
                <span className="text-[10px] font-sans font-medium uppercase tracking-wider text-white/45 block">Authentication Method</span>
                <span className="text-sm font-bold text-white block">{currentUser?.kind === "session" ? "HTTP-Only Secure Session" : "API Key"}</span>
              </div>
            </div>
            )}
          </div>
        )}

        {/* Users Tab (ADMIN guarded) */}
        {activeTab === "users" && (
          <div className="space-y-4">
            {loading && users.length === 0 ? (
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 overflow-hidden">
                <SkeletonTable rows={6} cols={4} />
              </div>
            ) : !isAdmin ? (
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
                <div className="py-12 text-center text-xs text-white/45 space-y-2">
                  <Lock className="mx-auto h-7 w-7 text-white/30" />
                  <p>Team management requires Administrator (ADMIN) role access</p>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] pb-3.5">
                  <div>
                    <h2 className="text-[13px] font-semibold tracking-tight text-white">Tenant Operators & Permissions</h2>
                    <p className="mt-0.5 text-[11px] font-normal text-white/45">Team members authorized to observe or control recovery cases</p>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<UserPlus className="h-3 w-3" />}
                    onClick={() => setCreateUserModal(true)}
                  >
                    Provision User
                  </Button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-white/[0.06] font-semibold uppercase text-[10px] text-white/45">
                      <tr>
                        <th className="py-2.5 pr-4">Operator</th>
                        <th className="py-2.5 px-4">Email</th>
                        <th className="py-2.5 px-4">Role</th>
                        <th className="py-2.5 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
                      {users.map((u) => (
                        <tr key={u.id} className="transition-colors hover:bg-white/[0.04]">
                          <td className="py-3 pr-4 font-sans font-medium text-white">
                            {u.name || "Operator"}
                          </td>
                          <td className="py-3 px-4 text-white/75">
                            {u.email}
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant={roleBadges[u.role] || "default"} size="sm">
                              {u.role}
                            </Badge>
                          </td>
                          <td className="py-3 px-4">
                            <span className="rounded-full bg-white/[0.04] border border-white/[0.08] px-2.5 py-0.5 text-[10px] text-emerald-300 font-semibold">
                              {u.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* API Keys Tab (ADMIN guarded) */}
        {activeTab === "api-keys" && (
          <div className="space-y-4">
            {loading && apiKeys.length === 0 ? (
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 overflow-hidden">
                <SkeletonTable rows={5} cols={5} />
              </div>
            ) : !isAdmin ? (
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5">
                <div className="py-12 text-center text-xs text-white/45 space-y-2">
                  <Lock className="mx-auto h-7 w-7 text-white/30" />
                  <p>API credential management requires Administrator (ADMIN) role access</p>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 overflow-hidden">
                <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] pb-3.5">
                  <div>
                    <h2 className="text-[13px] font-semibold tracking-tight text-white">Machine API Keys</h2>
                    <p className="mt-0.5 text-[11px] font-normal text-white/45">Scoped credentials for automated worker processes & integrations</p>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Key className="h-3 w-3" />}
                    onClick={() => setCreateKeyModal(true)}
                  >
                    Issue Machine Key
                  </Button>
                </div>

                {apiKeys.length === 0 ? (
                  <div className="py-12 text-center text-xs text-white/40">
                    No active machine API keys issued for this tenant
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-white/[0.06] font-semibold uppercase text-[10px] text-white/45">
                        <tr>
                          <th className="py-2.5 pr-4">Key Name</th>
                          <th className="py-2.5 px-4 font-mono">Prefix</th>
                          <th className="py-2.5 px-4">Scopes</th>
                          <th className="py-2.5 px-4">Created</th>
                          <th className="py-2.5 pl-4 text-right">Revoke</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.05] font-mono text-xs">
                        {apiKeys.map((k) => (
                          <tr key={k.id} className="transition-colors hover:bg-white/[0.04]">
                            <td className="py-3 pr-4 font-sans font-medium text-white">
                              {k.name}
                            </td>
                            <td className="py-3 px-4 text-white font-semibold">
                              {k.keyPrefix}...
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex flex-wrap gap-1">
                                {k.scopes.map((s, idx) => (
                                  <span
                                    key={idx}
                                    className="rounded-full bg-white/[0.04] border border-white/[0.08] px-2 py-0.5 text-[10px] text-white/70"
                                  >
                                    {s}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-white/45 text-[11px]">
                              {formatDate(k.createdAt)}
                            </td>
                            <td className="py-3 pl-4 text-right">
                              <Button
                                variant="ghost"
                                size="sm"
                                icon={<Trash2 className="h-3.5 w-3.5 text-rose-400" />}
                                onClick={() => handleRevokeKey(k.id)}
                              >
                                <span className="text-rose-400 font-sans text-xs">Revoke</span>
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Demo & Simulator Tab */}
        {activeTab === "simulator" && (
          <div className="rounded-3xl border border-white/[0.07] bg-[#131316]/90 p-5 space-y-4">
            <div className="border-b border-white/[0.06] pb-3.5">
              <h2 className="text-[13px] font-semibold tracking-tight text-white flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-white/60" />
                Demo Scripting & Outcome Simulator
              </h2>
              <p className="mt-0.5 text-[11px] font-normal text-white/45">
                Force deterministic payment gateway responses for live demos without moving real funds
              </p>
            </div>

            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3.5 space-y-4 max-w-lg">
              <div>
                <label className="block text-[11px] font-medium text-white/55 mb-1.5">
                  Payment Mock Key / Customer Idempotency Token
                </label>
                <input
                  className="w-full rounded-xl border border-white/[0.08] bg-black/40 px-3.5 py-2 font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-white/10 focus:border-white/25 transition-all"
                  value={demoKey}
                  onChange={(e) => setDemoKey(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-white/55 mb-1.5">
                  Next Scripted Outcome
                </label>
                <div className="flex gap-2.5">
                  <button
                    type="button"
                    onClick={() => setDemoOutcome("SUCCEEDED")}
                    className={`flex-1 py-2 px-3 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                      demoOutcome === "SUCCEEDED"
                        ? "bg-white text-black border-white font-semibold shadow-sm"
                        : "border-white/[0.09] bg-[#1d1d20] text-white/55 hover:text-white"
                    }`}
                  >
                    Force Succeeded (Recovery)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDemoOutcome("FAILED")}
                    className={`flex-1 py-2 px-3 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                      demoOutcome === "FAILED"
                        ? "bg-rose-500/15 border-rose-500/40 text-rose-300 shadow-sm"
                        : "border-white/[0.09] bg-[#1d1d20] text-white/55 hover:text-white"
                    }`}
                  >
                    Force Failed (Retry/Escalate)
                  </button>
                </div>
              </div>

              {demoOutcome === "FAILED" && (
                <div>
                  <label className="block text-[11px] font-medium text-white/55 mb-1.5">
                    Failure Reason Code
                  </label>
                  <input
                    className="w-full rounded-xl border border-white/[0.08] bg-black/40 px-3.5 py-2 font-mono text-xs text-white focus:outline-none focus:ring-2 focus:ring-white/10 focus:border-white/25 transition-all"
                    value={demoFailureCode}
                    onChange={(e) => setDemoFailureCode(e.target.value)}
                  />
                </div>
              )}

              <Button
                variant="primary"
                loading={simulating}
                icon={<Zap className="h-3.5 w-3.5" />}
                onClick={handleRunSimulator}
              >
                Configure Simulated Gateway Override
              </Button>

              {simResult && (
                <div className="rounded-xl bg-cyan-500/10 border border-cyan-500/25 p-3 text-xs text-cyan-300 font-mono">
                  {simResult}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Admin Modals */}
      <CreateUserModal
        isOpen={createUserModal}
        onClose={() => setCreateUserModal(false)}
        onSuccess={handleCreateUser}
      />

      <CreateApiKeyModal
        isOpen={createKeyModal}
        onClose={() => setCreateKeyModal(false)}
        onSuccess={fetchSettingsData}
      />
        </div>
      </div>
    </div>
  );
}
