"use client";

import React, { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Search,
  Bell,
  ChevronDown,
  LogOut,
} from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Badge } from "../../components/ui/Badge";
import { FinPointLogo } from "../../components/brand/FinPointLogo";
import { api } from "../../lib/api";
import type { AuthMeResponse } from "../../lib/types";

gsap.registerPlugin(useGSAP);
gsap.defaults({ duration: 0.6, ease: "power3.out" });

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/cases", label: "Cases" },
  { href: "/risk", label: "Risk Engine" },
  { href: "/recovery", label: "Recovery" },
  { href: "/policies", label: "Policies" },
  { href: "/tasks", label: "Tasks", hasBadge: true },
  { href: "/audit", label: "Audit Trail", adminOnly: true },
  { href: "/settings", label: "Settings" },
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
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Close the profile menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
          const q = gsap.utils.selector(rootRef);
          // Master entrance: header -> nav stagger -> brand.
          // Transforms + autoAlpha only (compositor-friendly).
          const tl = gsap.timeline({
            defaults: { duration: 0.55, ease: "power3.out" },
          });
          tl.addLabel("enter", 0);
          tl.fromTo(
            q(".shell-header"),
            { y: -16, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.5, clearProps: "transform" },
            "enter+=0.08"
          );
          tl.fromTo(
            q(".shell-nav-item"),
            { y: -8, autoAlpha: 0 },
            {
              y: 0,
              autoAlpha: 1,
              duration: 0.4,
              stagger: { each: 0.04, from: "start" },
              clearProps: "transform",
            },
            "enter+=0.15"
          );
          tl.fromTo(
            q(".shell-brand"),
            { y: -6, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.45, clearProps: "transform" },
            "enter+=0.1"
          );
        }
      );

      return () => mm.revert();
    },
    { scope: rootRef }
  );

  // Profile menu pop — transform + autoAlpha only.
  useGSAP(
    () => {
      if (!menuOpen || !menuRef.current) return;
      gsap.fromTo(
        menuRef.current,
        { y: -6, autoAlpha: 0, scale: 0.98 },
        {
          y: 0,
          autoAlpha: 1,
          scale: 1,
          duration: 0.22,
          ease: "power2.out",
          transformOrigin: "top right",
          clearProps: "transform",
        }
      );
    },
    { dependencies: [menuOpen], scope: rootRef }
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

  const displayName =
    currentUser?.name ||
    currentUser?.email ||
    (currentUser?.userId ? currentUser.userId.slice(0, 10) : "Operator");
  const initial = (displayName.trim()[0] || "O").toUpperCase();

  return (
    <div
      ref={rootRef}
      className="min-h-screen bg-black p-2 text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200 sm:p-3"
    >
      {/* Rounded app frame */}
      <div className="flex min-h-[calc(100vh-1rem)] flex-col overflow-clip rounded-[26px] border-2 border-[#34343a] bg-black sm:min-h-[calc(100vh-1.5rem)]">
      {/* Navbar — floating chips on black */}
      <header ref={headerRef} className="shell-header sticky top-0 z-40 px-3 pt-3 sm:px-5">
        <div className="relative flex w-full items-center gap-3">
          {/* Brand chip */}
          <Link href="/dashboard" className="shell-brand group flex h-11 shrink-0 items-center gap-2 rounded-full border border-white/[0.14] bg-[#141416] pl-2.5 pr-4 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)]">
            <FinPointLogo className="h-7 w-7 transition-transform duration-300 group-hover:scale-110" />
            <span className="whitespace-nowrap text-[15px] font-bold tracking-tight text-white">
              FinPoint
            </span>
          </Link>

          {/* Nav pill — centered */}
          <nav className="absolute left-1/2 hidden h-11 -translate-x-1/2 items-center gap-0.5 rounded-full border border-white/[0.09] bg-[#141416] px-1.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)] xl:flex">
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
                  className={`shell-nav-item relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-[13px] transition-[background-color,color] duration-200 ${
                    isActive
                      ? "bg-white font-semibold text-black shadow-[0_2px_14px_rgba(255,255,255,0.25)]"
                      : "font-medium text-white/65 hover:text-white"
                  }`}
                >
                  <span>{item.label}</span>
                  {item.hasBadge && pendingTasksCount > 0 && (
                    <span
                      className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold ${
                        isActive ? "bg-black text-white" : "bg-rose-500 text-white"
                      }`}
                    >
                      {pendingTasksCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Right icon cluster */}
          <div className="ml-auto flex shrink-0 items-center gap-2.5">
            <Link
              href="/cases"
              title="Search cases"
              aria-label="Search cases"
              className="flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.12] bg-[#141416] text-white/75 transition-colors hover:border-white/25 hover:text-white"
            >
              <Search className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </Link>
            <Link
              href="/tasks"
              title={pendingTasksCount > 0 ? `${pendingTasksCount} pending tasks` : "Pending tasks"}
              aria-label="Pending tasks"
              className="relative flex h-10 w-10 items-center justify-center rounded-full border border-white/[0.12] bg-[#141416] text-white/75 transition-colors hover:border-white/25 hover:text-white"
            >
              <Bell className="h-[18px] w-[18px]" strokeWidth={1.5} />
              {pendingTasksCount > 0 && (
                <span className="absolute right-2 top-2 h-[7px] w-[7px] rounded-full bg-[#ff4d2e]" />
              )}
            </Link>

            {currentUser && (
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  title={displayName}
                  aria-label="Account menu"
                  aria-expanded={menuOpen}
                  className="flex h-10 cursor-pointer items-center gap-1 rounded-full border border-white/[0.12] bg-[#141416] py-1 pl-1 pr-2 transition-colors hover:border-white/25"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 via-rose-300 to-rose-500 text-xs font-bold text-black">
                    {initial}
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-white/60 transition-transform duration-200 ${menuOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {menuOpen && (
                  <div
                    ref={menuRef}
                    className="absolute right-0 top-11 z-50 w-64 rounded-2xl border border-white/10 bg-[#141416] p-4 shadow-2xl shadow-black"
                  >
                    <p className="truncate text-sm font-semibold text-white">{displayName}</p>
                    {currentUser.email && currentUser.name && (
                      <p className="mt-0.5 truncate text-[11px] text-white/45">{currentUser.email}</p>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <Badge
                        variant={roleVariants[currentUser.role || "VIEWER"] || "default"}
                        size="sm"
                      >
                        {currentUser.role || "VIEWER"}
                      </Badge>
                      <span className="truncate font-mono text-[10px] text-white/35">
                        {currentUser.tenantId ? `${currentUser.tenantId.slice(0, 8)}...` : "default"}
                      </span>
                    </div>
                    <div className="mt-3 border-t border-white/[0.08] pt-3">
                      <button
                        onClick={handleLogout}
                        disabled={loggingOut}
                        className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-40"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        {loggingOut ? "Signing out…" : "Sign Out"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Mobile nav — black scroll row */}
        <div className="mt-2.5 flex w-full gap-1 overflow-x-auto rounded-full border border-white/[0.09] bg-[#141416] p-1.5 xl:hidden">
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
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-[13px] ${
                  isActive
                    ? "bg-white font-semibold text-black"
                    : "font-medium text-white/65 hover:text-white"
                }`}
              >
                <span>{item.label}</span>
                {item.hasBadge && pendingTasksCount > 0 && (
                  <span
                    className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold ${
                      isActive ? "bg-black text-white" : "bg-rose-500 text-white"
                    }`}
                  >
                    {pendingTasksCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </header>

      {/* Page body */}
      <main
        ref={mainRef}
        className="relative z-10 mx-auto w-full max-w-[86rem] flex-1 bg-black px-4 py-6 sm:px-6 lg:px-8"
      >
        {children}
      </main>
      </div>
    </div>
  );
}
