"use client";

import React, { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  AlertTriangle,
  TrendingUp,
  ShieldCheck,
  ClipboardList,
  FileSearch,
  Settings,
  LogOut,
  Shield,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Badge } from "../../components/ui/Badge";
import { api } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/types";

gsap.registerPlugin(useGSAP);

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: <LayoutDashboard className="h-3.5 w-3.5" /> },
  { href: "/cases", label: "Cases", icon: <FolderKanban className="h-3.5 w-3.5" /> },
  { href: "/risk", label: "Risk Engine", icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  { href: "/recovery", label: "Recovery", icon: <TrendingUp className="h-3.5 w-3.5" /> },
  { href: "/policies", label: "Policies", icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  { href: "/tasks", label: "Tasks", icon: <ClipboardList className="h-3.5 w-3.5" />, hasBadge: true },
  { href: "/audit", label: "Audit Trail", icon: <FileSearch className="h-3.5 w-3.5" />, adminOnly: true },
  { href: "/settings", label: "Settings", icon: <Settings className="h-3.5 w-3.5" /> },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<AuthMeResponse | null>(null);
  const [pendingTasksCount, setPendingTasksCount] = useState<number>(0);
  const [loggingOut, setLoggingOut] = useState<boolean>(false);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Fetch principal summary
    api.auth
      .me()
      .then((me) => {
        setCurrentUser(me);
      })
      .catch(() => {
        // middleware handles 401 redirect
      });

    // Fetch pending task count for badge
    api.tasks
      .list({ status: "PENDING", limit: 50 })
      .then((res) => {
        setPendingTasksCount(res.items?.length || 0);
      })
      .catch(() => {});
  }, [pathname]);

  useGSAP(
    () => {
      if (headerRef.current) {
        gsap.fromTo(
          headerRef.current,
          { y: -15, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.35,
            ease: "power2.out",
            clearProps: "opacity,transform",
          }
        );
      }
    },
    { dependencies: [], scope: headerRef }
  );

  const handleLogout = async () => {
    try {
      setLoggingOut(true);
      await api.auth.logout();
      router.push("/login");
      router.refresh();
    } catch {
      router.push("/login");
    } finally {
      setLoggingOut(false);
    }
  };

  const roleVariants: Record<string, "danger" | "info" | "warning" | "success" | "default"> = {
    ADMIN: "danger",
    FINANCE: "info",
    OPERATIONS: "success",
    SUPPORT: "warning",
    VIEWER: "default",
  };

  return (
    <div className="min-h-screen bg-[#08090d] text-slate-100 flex flex-col antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* Background ambient lighting */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="ambient-glow bg-emerald-500/10 w-[500px] h-[500px] -top-40 -left-40" />
        <div className="ambient-glow bg-cyan-500/10 w-[600px] h-[600px] -top-60 right-0" />
        <div className="ambient-glow bg-indigo-500/5 w-[800px] h-[800px] bottom-0 left-1/3" />
      </div>

      {/* Mock Mode / Operational Banner */}
      <div className="relative z-50 bg-[#0c1018]/90 border-b border-white/[0.06] px-4 py-1.5 text-[11px] text-slate-400 flex items-center justify-between backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className="font-semibold text-slate-200 tracking-tight">Financial Control Plane Active</span>
          <span className="text-slate-700">|</span>
          <span className="text-slate-400 hidden sm:inline">Zero-Risk Simulation Mode</span>
        </div>
        <div className="flex items-center gap-3 font-mono text-[11px]">
          <span className="text-slate-400">
            Tenant: <span className="text-slate-200 font-semibold">{currentUser?.tenantId ? `${currentUser.tenantId.slice(0, 8)}...` : "default"}</span>
          </span>
          <span className="text-slate-700">|</span>
          <span className="text-emerald-400 font-semibold flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            INR Live
          </span>
        </div>
      </div>

      {/* Main App Navigation Bar */}
      <header
        ref={headerRef}
        className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#08090d]/80 backdrop-blur-xl"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between gap-4">
            {/* Logo */}
            <Link
              href="/dashboard"
              className="flex items-center gap-2.5 group transition-transform"
            >
              <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-emerald-500/20 via-cyan-500/20 to-indigo-500/20 p-0.5 border border-white/[0.1] shadow-lg shadow-black/60 group-hover:border-emerald-500/40 transition-colors">
                <div className="h-full w-full rounded-[10px] bg-[#0b0e16] flex items-center justify-center">
                  <Shield className="h-4 w-4 text-emerald-400 transition-transform duration-200 group-hover:scale-110" />
                </div>
              </div>
              <div>
                <span className="font-bold text-xs text-slate-100 tracking-tight block">
                  AI Revenue Recovery
                </span>
                <span className="text-[10px] text-slate-500 font-mono block -mt-0.5 tracking-wider">
                  AUTONOMOUS RECOVERY
                </span>
              </div>
            </Link>

            {/* Desktop Navigation Links */}
            <nav className="hidden md:flex items-center gap-1 bg-[#0d111a]/80 p-1 rounded-xl border border-white/[0.05]">
              {NAV_ITEMS.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));

                if (item.adminOnly && currentUser?.role !== "ADMIN") {
                  return null;
                }

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
                      isActive
                        ? "bg-[#182030] text-emerald-400 font-semibold shadow-sm border border-white/[0.08]"
                        : "text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]"
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                    {item.hasBadge && pendingTasksCount > 0 && (
                      <span className="h-4 min-w-4 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[9px] font-bold flex items-center justify-center px-1 animate-pulse">
                        {pendingTasksCount}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>

            {/* User Profile & Logout */}
            <div className="flex items-center gap-3">
              {currentUser && (
                <div className="flex items-center gap-2.5 border-l border-white/[0.08] pl-3">
                  <div className="text-right hidden sm:block">
                    <div className="text-xs font-medium text-slate-200">
                      {currentUser.name || currentUser.email || (currentUser.userId ? currentUser.userId.slice(0, 10) : "Operator")}
                    </div>
                    <div className="flex justify-end mt-0.5">
                      <Badge
                        variant={roleVariants[currentUser.role || "VIEWER"] || "default"}
                        size="sm"
                      >
                        {currentUser.role || "VIEWER"}
                      </Badge>
                    </div>
                  </div>

                  <button
                    onClick={handleLogout}
                    disabled={loggingOut}
                    title="Sign Out"
                    className="p-2 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-white/[0.04] border border-transparent hover:border-white/[0.08] transition-colors cursor-pointer"
                  >
                    <LogOut className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Mobile Navigation Scrollbar */}
        <div className="flex md:hidden overflow-x-auto border-t border-white/[0.06] px-4 py-2 gap-1 scrollbar-none">
          {NAV_ITEMS.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`));

            if (item.adminOnly && currentUser?.role !== "ADMIN") {
              return null;
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap ${
                  isActive
                    ? "bg-[#182030] text-emerald-400 font-semibold border border-white/[0.08]"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.hasBadge && pendingTasksCount > 0 && (
                  <span className="h-4 min-w-4 rounded-full bg-rose-500/20 text-rose-300 text-[9px] font-bold flex items-center justify-center px-1">
                    {pendingTasksCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </header>

      {/* Page Body */}
      <main ref={mainRef} className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
