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
import { CreateUserModal } from "../../../components/modals/CreateUserModal";
import { CreateApiKeyModal } from "../../../components/modals/CreateApiKeyModal";
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
      if (tabContentRef.current) {
        gsap.fromTo(
          tabContentRef.current,
          { opacity: 0, y: 10 },
          {
            opacity: 1,
            y: 0,
            duration: 0.3,
            ease: "power2.out",
            clearProps: "opacity,transform",
          }
        );
      }
    },
    { dependencies: [activeTab], scope: containerRef }
  );

  const handleCreateUser = async (input: { email: string; role: UserRole; name?: string }) => {
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
    <div ref={containerRef} className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <SettingsIcon className="h-5 w-5 text-emerald-400" />
            Control Plane Settings & Team Administration
          </h1>
          <p className="text-xs text-slate-400 mt-0.5 font-normal">
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
          <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-6 shadow-lg shadow-black/40 backdrop-blur-xl space-y-6">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-200 mb-0.5">
                Organization & Tenant Environment
              </h2>
              <p className="text-[11px] text-slate-400 font-normal">
                Active configuration for this isolated financial tenant partition
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
              <div className="p-4 rounded-xl border border-white/[0.06] bg-[#090c13]/70 space-y-1">
                <span className="text-[10px] font-sans text-slate-400 block uppercase tracking-wider">Tenant Identifier</span>
                <span className="text-sm font-bold text-slate-200 block">{currentUser?.tenantId || "default"}</span>
              </div>

              <div className="p-4 rounded-xl border border-white/[0.06] bg-[#090c13]/70 space-y-1">
                <span className="text-[10px] font-sans text-slate-400 block uppercase tracking-wider">Currency & Localization</span>
                <span className="text-sm font-bold text-emerald-400 block">INR (₹) — Indian Number System</span>
              </div>

              <div className="p-4 rounded-xl border border-white/[0.06] bg-[#090c13]/70 space-y-1">
                <span className="text-[10px] font-sans text-slate-400 block uppercase tracking-wider">Active Operator Role</span>
                <span className="text-sm font-bold text-slate-200 block">{currentUser?.role}</span>
              </div>

              <div className="p-4 rounded-xl border border-white/[0.06] bg-[#090c13]/70 space-y-1">
                <span className="text-[10px] font-sans text-slate-400 block uppercase tracking-wider">Authentication Method</span>
                <span className="text-sm font-bold text-cyan-400 block">{currentUser?.kind === "session" ? "HTTP-Only Secure Session" : "API Key"}</span>
              </div>
            </div>
          </div>
        )}

        {/* Users Tab (ADMIN guarded) */}
        {activeTab === "users" && (
          <div className="space-y-4">
            {!isAdmin ? (
              <div className="py-12 text-center text-xs text-slate-500 space-y-2">
                <Lock className="mx-auto h-7 w-7 text-amber-500 opacity-60" />
                <p>Team management requires Administrator (ADMIN) role access</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 shadow-lg shadow-black/40 overflow-hidden backdrop-blur-xl">
                <div className="p-4 flex items-center justify-between border-b border-white/[0.06]">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-100 uppercase tracking-wider">Tenant Operators & Permissions</h2>
                    <p className="text-[11px] text-slate-400 font-normal">Team members authorized to observe or control recovery cases</p>
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
                    <thead className="border-b border-white/[0.06] bg-[#090c13]/50 text-slate-400 font-semibold uppercase text-[10px]">
                      <tr>
                        <th className="py-3 px-4">Operator</th>
                        <th className="py-3 px-4">Email</th>
                        <th className="py-3 px-4">Role</th>
                        <th className="py-3 px-4">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                      {users.map((u) => (
                        <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="py-3 px-4 font-sans font-medium text-slate-200">
                            {u.name || "Operator"}
                          </td>
                          <td className="py-3 px-4 text-slate-300">
                            {u.email}
                          </td>
                          <td className="py-3 px-4">
                            <Badge variant={roleBadges[u.role] || "default"} size="sm">
                              {u.role}
                            </Badge>
                          </td>
                          <td className="py-3 px-4">
                            <span className="rounded-md bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 text-[10px] text-emerald-400 font-semibold">
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
            {!isAdmin ? (
              <div className="py-12 text-center text-xs text-slate-500 space-y-2">
                <Lock className="mx-auto h-7 w-7 text-amber-500 opacity-60" />
                <p>API credential management requires Administrator (ADMIN) role access</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 shadow-lg shadow-black/40 overflow-hidden backdrop-blur-xl">
                <div className="p-4 flex items-center justify-between border-b border-white/[0.06]">
                  <div>
                    <h2 className="text-xs font-semibold text-slate-100 uppercase tracking-wider">Machine API Keys</h2>
                    <p className="text-[11px] text-slate-400 font-normal">Scoped credentials for automated worker processes & integrations</p>
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
                  <div className="py-12 text-center text-xs text-slate-500">
                    No active machine API keys issued for this tenant
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="border-b border-white/[0.06] bg-[#090c13]/50 text-slate-400 font-semibold uppercase text-[10px]">
                        <tr>
                          <th className="py-3 px-4">Key Name</th>
                          <th className="py-3 px-4 font-mono">Prefix</th>
                          <th className="py-3 px-4">Scopes</th>
                          <th className="py-3 px-4">Created</th>
                          <th className="py-3 px-4 text-right">Revoke</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04] font-mono text-xs">
                        {apiKeys.map((k) => (
                          <tr key={k.id} className="hover:bg-white/[0.02] transition-colors">
                            <td className="py-3 px-4 font-sans font-medium text-slate-200">
                              {k.name}
                            </td>
                            <td className="py-3 px-4 text-cyan-400 font-bold">
                              {k.keyPrefix}...
                            </td>
                            <td className="py-3 px-4">
                              <div className="flex flex-wrap gap-1">
                                {k.scopes.map((s, idx) => (
                                  <span
                                    key={idx}
                                    className="rounded-md bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-300"
                                  >
                                    {s}
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-slate-400 text-[11px]">
                              {formatDate(k.createdAt)}
                            </td>
                            <td className="py-3 px-4 text-right">
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
          <div className="rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-6 shadow-lg shadow-black/40 backdrop-blur-xl space-y-6">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-100 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                Demo Scripting & Outcome Simulator
              </h2>
              <p className="text-[11px] text-slate-400 mt-0.5 font-normal">
                Force deterministic payment gateway responses for live demos without moving real funds
              </p>
            </div>

            <div className="rounded-xl border border-white/[0.06] bg-[#090c13] p-4 space-y-4 max-w-lg">
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
                  Payment Mock Key / Customer Idempotency Token
                </label>
                <input
                  className="w-full rounded-xl border border-white/[0.08] bg-[#0c1018] px-3.5 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500/50 transition-all"
                  value={demoKey}
                  onChange={(e) => setDemoKey(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
                  Next Scripted Outcome
                </label>
                <div className="flex gap-2.5">
                  <button
                    type="button"
                    onClick={() => setDemoOutcome("SUCCEEDED")}
                    className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${
                      demoOutcome === "SUCCEEDED"
                        ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300 shadow-sm"
                        : "border-white/[0.06] bg-[#0c1018] text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Force Succeeded (Recovery)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDemoOutcome("FAILED")}
                    className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold border transition-all cursor-pointer ${
                      demoOutcome === "FAILED"
                        ? "bg-rose-500/15 border-rose-500/40 text-rose-300 shadow-sm"
                        : "border-white/[0.06] bg-[#0c1018] text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Force Failed (Retry/Escalate)
                  </button>
                </div>
              </div>

              {demoOutcome === "FAILED" && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-300 mb-1.5">
                    Failure Reason Code
                  </label>
                  <input
                    className="w-full rounded-xl border border-white/[0.08] bg-[#0c1018] px-3.5 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500/50 transition-all"
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
  );
}
