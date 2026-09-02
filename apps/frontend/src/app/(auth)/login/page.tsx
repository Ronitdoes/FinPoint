"use client";

import React, { useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Shield, Lock, Mail, ArrowRight } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { api } from "../../../lib/api";

gsap.registerPlugin(useGSAP);

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/dashboard";

  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("Admin12345!@#");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      if (headerRef.current && cardRef.current) {
        tl.fromTo(
          headerRef.current,
          { y: -20, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.5, clearProps: "opacity,transform" }
        ).fromTo(
          cardRef.current,
          { y: 20, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.5, clearProps: "opacity,transform" },
          "-=0.2"
        );
      }
    },
    { dependencies: [], scope: containerRef }
  );

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Email and password are required");
      return;
    }

    try {
      setLoading(true);
      setError("");
      await api.auth.login({ email, password });
      router.push(from);
      router.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Invalid email or password";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const fillPersona = (roleEmail: string) => {
    setEmail(roleEmail);
    setPassword("Admin12345!@#");
    setError("");
  };

  return (
    <div
      ref={containerRef}
      className="min-h-screen relative flex items-center justify-center bg-[#08090d] px-4 py-12 text-slate-100 overflow-hidden"
    >
      {/* Ambient background glows */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-emerald-500/10 rounded-full blur-[100px] pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-cyan-500/10 rounded-full blur-[100px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md space-y-7">
        {/* Brand Header */}
        <div ref={headerRef} className="text-center space-y-2">
          <div className="inline-flex items-center justify-center p-3 rounded-2xl bg-gradient-to-tr from-emerald-500/20 via-cyan-500/20 to-indigo-500/20 border border-white/[0.1] shadow-xl shadow-black/60 mb-1">
            <Shield className="h-7 w-7 text-emerald-400" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center justify-center gap-2">
            AI Revenue Recovery
            <span className="px-1.5 py-0.2 rounded text-[10px] font-mono font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              Control Plane
            </span>
          </h1>
          <p className="text-xs text-slate-400 max-w-xs mx-auto font-normal">
            Autonomous financial recovery & churn mitigation platform
          </p>
        </div>

        {/* Login Card */}
        <div
          ref={cardRef}
          className="rounded-2xl border border-white/[0.08] bg-[#0d111a]/85 p-7 shadow-2xl shadow-black/80 backdrop-blur-2xl"
        >
          <form onSubmit={handleLogin} className="space-y-4">
            {error && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-950/30 p-3 text-xs text-rose-300">
                {error}
              </div>
            )}

            <Input
              label="Operator Email"
              type="email"
              placeholder="name@company.com"
              icon={<Mail className="h-3.5 w-3.5" />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <Input
              label="Password"
              type="password"
              placeholder="••••••••"
              icon={<Lock className="h-3.5 w-3.5" />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={loading}
              className="w-full mt-2"
              icon={<ArrowRight className="h-4 w-4" />}
            >
              Sign In to Control Plane
            </Button>
          </form>

          {/* Quick Persona Switcher for Evaluation */}
          <div className="mt-6 pt-5 border-t border-white/[0.06]">
            <p className="text-[10px] font-semibold text-slate-400 mb-2.5 text-center uppercase tracking-widest">
              Quick Role Presets (Demo / Test)
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => fillPersona("admin@example.com")}
                className="rounded-xl border border-white/[0.06] bg-[#090c13]/80 p-2 text-left hover:border-emerald-500/40 hover:bg-[#0e131e] transition-all cursor-pointer"
              >
                <div className="font-semibold text-emerald-400 text-xs">Admin</div>
                <div className="text-[10px] text-slate-500">Full control & settings</div>
              </button>

              <button
                type="button"
                onClick={() => fillPersona("finance@example.com")}
                className="rounded-xl border border-white/[0.06] bg-[#090c13]/80 p-2 text-left hover:border-indigo-500/40 hover:bg-[#0e131e] transition-all cursor-pointer"
              >
                <div className="font-semibold text-indigo-400 text-xs">Finance</div>
                <div className="text-[10px] text-slate-500">Policies & stop cases</div>
              </button>

              <button
                type="button"
                onClick={() => fillPersona("ops@example.com")}
                className="rounded-xl border border-white/[0.06] bg-[#090c13]/80 p-2 text-left hover:border-cyan-500/40 hover:bg-[#0e131e] transition-all cursor-pointer"
              >
                <div className="font-semibold text-cyan-400 text-xs">Operations</div>
                <div className="text-[10px] text-slate-500">Approve tasks & pause</div>
              </button>

              <button
                type="button"
                onClick={() => fillPersona("support@example.com")}
                className="rounded-xl border border-white/[0.06] bg-[#090c13]/80 p-2 text-left hover:border-amber-500/40 hover:bg-[#0e131e] transition-all cursor-pointer"
              >
                <div className="font-semibold text-amber-400 text-xs">Support</div>
                <div className="text-[10px] text-slate-500">Escalate cases</div>
              </button>

              <button
                type="button"
                onClick={() => fillPersona("viewer@example.com")}
                className="col-span-2 rounded-xl border border-white/[0.06] bg-[#090c13]/80 p-2 text-left hover:border-white/[0.15] hover:bg-[#0e131e] transition-all cursor-pointer"
              >
                <div className="font-semibold text-slate-300 text-xs">Viewer</div>
                <div className="text-[10px] text-slate-500">Observation only</div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#08090d] flex items-center justify-center text-slate-500 text-xs">Loading...</div>}>
      <LoginForm />
    </Suspense>
  );
}
