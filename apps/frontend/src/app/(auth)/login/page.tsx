"use client";

import React, { useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, Mail, ArrowRight } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { FinPointLogo } from "../../../components/brand/FinPointLogo";
import { api } from "../../../lib/api";

gsap.registerPlugin(useGSAP);
gsap.defaults({ duration: 0.6, ease: "power3.out" });

/** Decorative line-art: recovery skyline with a mint trajectory. */
const HIGHLIGHT_BARS = [
  { x: 18, y: 128, w: 54 },
  { x: 82, y: 76, w: 62 },
  { x: 154, y: 106, w: 50 },
  { x: 214, y: 44, w: 58 },
  { x: 282, y: 94, w: 56 },
  { x: 348, y: 124, w: 58 },
];
const CHART_BASELINE = 228;
/** Cycle order is a palindrome walk: every step — including the loop
    point — glides to a neighboring bar, so there are no jumps. */
const HIGHLIGHT_ORDER = [3, 4, 5, 4, 3, 2, 1, 0, 1, 2];

function LoginArt() {
  return (
    <svg
      viewBox="0 0 440 230"
      className="h-full max-h-52 w-full lg:max-h-full"
      preserveAspectRatio="xMidYMax slice"
      fill="none"
      aria-hidden="true"
    >
      <line x1="0" y1="228" x2="440" y2="228" stroke="rgba(255,255,255,0.18)" strokeWidth="2" className="login-fade" />
      <g stroke="rgba(255,255,255,0.2)" strokeWidth="2">
        <rect x="18" y="128" width="54" height="100" className="login-bar" />
        <rect x="82" y="76" width="62" height="152" className="login-bar" />
        <rect x="154" y="106" width="50" height="122" className="login-bar" />
        <rect x="214" y="44" width="58" height="184" className="login-bar" />
        <rect x="282" y="94" width="56" height="134" className="login-bar" />
        <rect x="348" y="124" width="58" height="104" className="login-bar" />
      </g>
      <g stroke="rgba(255,255,255,0.13)" strokeWidth="2" strokeDasharray="3 6" className="login-fade">
        <line x1="45" y1="128" x2="45" y2="228" />
        <line x1="113" y1="76" x2="113" y2="228" />
        <line x1="179" y1="106" x2="179" y2="228" />
        <line x1="310" y1="94" x2="310" y2="228" />
        <line x1="377" y1="124" x2="377" y2="228" />
      </g>
      <rect
        x="214"
        y="44"
        width="58"
        height="184"
        fill="rgba(62,240,168,0.06)"
        stroke="#3ef0a8"
        strokeOpacity="0.55"
        strokeWidth="2"
        className="login-bar login-highlight"
      />
      <polyline
        points="18,186 82,158 154,166 214,118 282,126 348,84 406,92"
        stroke="#3ef0a8"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="login-trend"
      />
      <circle cx="348" cy="84" r="8" fill="#3ef0a8" opacity="0.2" className="login-halo" />
      <circle cx="348" cy="84" r="4" fill="#3ef0a8" className="login-dot" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activePreset, setActivePreset] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<HTMLDivElement>(null);

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
          // Sequenced entrance: form column -> story column -> persona stagger.
          // Transforms + autoAlpha only.
          const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
          tl.addLabel("in", 0);
          if (leftRef.current) {
            tl.fromTo(
              leftRef.current,
              { y: 24, autoAlpha: 0 },
              { y: 0, autoAlpha: 1, duration: 0.6, clearProps: "transform" },
              "in"
            );
          }
          if (rightRef.current) {
            tl.fromTo(
              rightRef.current,
              { y: 24, autoAlpha: 0 },
              { y: 0, autoAlpha: 1, duration: 0.65, clearProps: "transform" },
              "in+=0.12"
            );
          }
          if (cardRef.current) {
            const personas = cardRef.current.querySelectorAll(".persona-btn");
            if (personas.length > 0) {
              tl.fromTo(
                personas,
                { y: 10, autoAlpha: 0 },
                {
                  y: 0,
                  autoAlpha: 1,
                  duration: 0.4,
                  stagger: { each: 0.05, from: "start" },
                  clearProps: "transform",
                },
                "in+=0.35"
              );
            }
          }
        }
      );
      return () => mm.revert();
    },
    { scope: containerRef }
  );

  // Chart draw-in: bars rise from the baseline, the trend line draws
  // itself, then the signal dot pops with a soft halo pulse.
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
          const q = gsap.utils.selector(artRef);
          const tl = gsap.timeline({
            defaults: { ease: "power3.out" },
            delay: 0.45,
          });
          tl.addLabel("draw", 0);

          const bars = q(".login-bar");
          if (bars.length > 0) {
            tl.fromTo(
              bars,
              { scaleY: 0, transformOrigin: "50% 100%" },
              {
                scaleY: 1,
                duration: 0.7,
                stagger: 0.08,
                clearProps: "transform",
              },
              "draw"
            );
          }

          const fades = q(".login-fade");
          if (fades.length > 0) {
            tl.fromTo(
              fades,
              { autoAlpha: 0 },
              { autoAlpha: 1, duration: 0.5, stagger: 0.04 },
              "draw+=0.2"
            );
          }

          const trend = q(".login-trend")[0] as unknown as SVGPolylineElement | undefined;
          if (trend) {
            const len = trend.getTotalLength();
            tl.fromTo(
              trend,
              { strokeDasharray: len, strokeDashoffset: len },
              {
                strokeDashoffset: 0,
                duration: 1.3,
                ease: "power2.inOut",
              },
              "draw+=0.3"
            );
          }

          const dot = q(".login-dot");
          if (dot.length > 0) {
            tl.fromTo(
              dot,
              { scale: 0, transformOrigin: "50% 50%" },
              {
                scale: 1,
                duration: 0.5,
                ease: "back.out(2)",
                clearProps: "transform",
              },
              "draw+=1.2"
            );
          }

          const halo = q(".login-halo");
          if (halo.length > 0) {
            tl.to(
              halo,
              {
                opacity: 0.45,
                duration: 1.1,
                ease: "sine.inOut",
                repeat: -1,
                yoyo: true,
              },
              "draw+=1.6"
            );
          }

          // Roaming highlight: once the entrance is over, glide the mint
          // bar + signal dot across different bars in an endless loop.
          const highlight = q(".login-highlight")[0];
          const markers = [q(".login-dot")[0], q(".login-halo")[0]].filter(
            (el): el is HTMLElement => el != null
          );
          if (highlight && markers.length > 0) {
            const roam = gsap.timeline({ repeat: -1, delay: 2.4 });
            HIGHLIGHT_ORDER.forEach((bi) => {
              const b = HIGHLIGHT_BARS[bi];
              const cx = b.x + b.w / 2;
              const cy = b.y - 12;
              roam.to(highlight, {
                attr: { x: b.x, y: b.y, width: b.w, height: CHART_BASELINE - b.y },
                duration: 0.55,
                ease: "power2.inOut",
              });
              roam.to(
                markers,
                { attr: { cx, cy }, duration: 0.55, ease: "power2.inOut" },
                "<"
              );
              roam.to({}, { duration: 1.15 });
            });
          }
        }
      );
      return () => mm.revert();
    },
    { scope: containerRef }
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

  // Demo-only preset filler. All local seed personas share the default
  // seed password, so every preset fills email + password for one-click sign-in.
  const fillPersona = (roleEmail: string, rolePassword = "Admin12345!@#") => {
    setEmail(roleEmail);
    setPassword(rolePassword);
    setError("");
  };

  const personas = [
    {
      key: "admin",
      title: "Admin",
      desc: "Full control & settings",
      email: "admin@example.com",
      tick: "bg-emerald-400",
      text: "text-emerald-300",
      hover: "hover:border-emerald-300/30 hover:bg-emerald-400/[0.07]",
    },
    {
      key: "finance",
      title: "Finance",
      desc: "Policies & stop cases",
      email: "finance@example.com",
      tick: "bg-indigo-400",
      text: "text-indigo-300",
      hover: "hover:border-indigo-300/30 hover:bg-indigo-400/[0.07]",
    },
    {
      key: "ops",
      title: "Operations",
      desc: "Approve tasks & pause",
      email: "ops@example.com",
      tick: "bg-cyan-400",
      text: "text-cyan-300",
      hover: "hover:border-cyan-300/30 hover:bg-cyan-400/[0.07]",
    },
    {
      key: "support",
      title: "Support",
      desc: "Escalate cases",
      email: "support@example.com",
      tick: "bg-amber-400",
      text: "text-amber-300",
      hover: "hover:border-amber-300/30 hover:bg-amber-400/[0.07]",
    },
  ];

  return (
    <div ref={containerRef} className="min-h-screen bg-black p-2 text-slate-100 sm:p-3 lg:h-screen lg:overflow-hidden">
      <div className="relative flex min-h-[calc(100vh-1rem)] items-center justify-center overflow-hidden rounded-[26px] border-2 border-[#34343a] bg-black px-4 py-6 sm:min-h-[calc(100vh-1.5rem)] lg:h-[calc(100vh-1.5rem)] lg:min-h-0 lg:py-4">
      {/* Backdrop: faint grid + restrained glows */}
      <div aria-hidden="true" className="absolute inset-0">
        <div className="bg-grid-faint opacity-70" />
        <div className="absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-emerald-500/[0.07] blur-[110px]" />
        <div className="absolute -right-32 bottom-1/4 h-96 w-96 rounded-full bg-cyan-500/[0.06] blur-[110px]" />
      </div>

      <div className="relative z-10 w-full max-w-5xl lg:min-h-0">
        <div
          ref={cardRef}
          className="grid overflow-hidden rounded-[28px] border border-white/10 bg-[#101013] shadow-[0_40px_100px_-40px_rgba(0,0,0,0.9)] lg:grid-cols-2"
        >
          {/* Left — sign-in form */}
          <div ref={leftRef} className="p-6 sm:p-8">
            <div className="flex items-center gap-2">
              <FinPointLogo className="h-7 w-7" />
              <span className="text-[15px] font-bold tracking-tight text-white">FinPoint</span>
            </div>

            <div className="mx-auto mt-6 max-w-sm">
              <p className="eyebrow text-center text-[10px] text-slate-500">Control plane access</p>
              <h1 className="mt-2 text-center text-[26px] font-bold tracking-tight text-white">
                Sign In
              </h1>
              <p className="mx-auto mt-1 max-w-xs text-center text-[13px] font-normal leading-relaxed text-white/45">
                Autonomous financial recovery &amp; churn mitigation platform
              </p>

              <form onSubmit={handleLogin} className="mt-5 space-y-3">
                {error && (
                  <div className="rounded-xl border border-rose-300/25 bg-rose-400/10 p-3 text-xs text-rose-200">
                    {error}
                  </div>
                )}

                <Input
                  label="Operator Email"
                  type="email"
                  placeholder="name@company.com"
                  icon={<Mail className="h-3.5 w-3.5" />}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setActivePreset(null);
                  }}
                  required
                />

                <Input
                  label="Password"
                  type="password"
                  placeholder="••••••••"
                  icon={<Lock className="h-3.5 w-3.5" />}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setActivePreset(null);
                  }}
                  required
                />

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={loading}
                  className="mt-2 w-full"
                  icon={<ArrowRight className="h-4 w-4" />}
                >
                  Sign In to Control Plane
                </Button>
              </form>

              {/* Quick persona switcher — fills email + password */}
              <div className="mt-4 border-t border-white/[0.07] pt-4">
                <p className="eyebrow mb-2 text-center text-[10px] text-slate-500">
                  Quick Role Presets (Demo / Test — fills email + password)
                </p>
                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  {personas.map((p) => {
                    const isActive = activePreset === p.key;
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => {
                          fillPersona(p.email);
                          setActivePreset(p.key);
                        }}
                        aria-pressed={isActive}
                        className={`persona-btn flex cursor-pointer items-center gap-2.5 rounded-2xl border p-2 text-left transition-[transform,border-color,background-color] duration-200 hover:-translate-y-px ${
                          isActive
                            ? "border-white/25 bg-white/[0.07]"
                            : `border-white/[0.08] bg-white/[0.03] ${p.hover}`
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`h-8 w-[3px] shrink-0 rounded-full ${p.tick}`}
                        />
                        <span className="min-w-0">
                          <span className={`block text-xs font-semibold ${p.text}`}>
                            {p.title}
                          </span>
                          <span className="block truncate text-[10px] text-slate-500">
                            {p.desc}
                          </span>
                        </span>
                      </button>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() => {
                      fillPersona("viewer@example.com");
                      setActivePreset("viewer");
                    }}
                    aria-pressed={activePreset === "viewer"}
                    className={`persona-btn col-span-2 flex cursor-pointer items-center gap-2.5 rounded-2xl border p-2 text-left transition-[transform,border-color,background-color] duration-200 hover:-translate-y-px ${
                      activePreset === "viewer"
                        ? "border-white/25 bg-white/[0.07]"
                        : "border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="h-8 w-[3px] shrink-0 rounded-full bg-white/50"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-slate-200">Viewer</span>
                      <span className="block truncate text-[10px] text-slate-500">
                        Observation only
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Right — product story */}
          <div
            ref={rightRef}
            className="relative hidden border-l border-white/[0.08] bg-[#151517] lg:flex lg:flex-col"
          >
            <div className="px-8 pt-8">
              <span aria-hidden="true" className="font-serif text-6xl leading-none text-[#3ef0a8]">
                &ldquo;
              </span>
              <p className="-mt-3 text-[19px] font-medium leading-relaxed tracking-tight text-white">
                Zero-risk simulation. Policy-guarded autonomy. Every recovery structured,
                reviewed, and fully audited.
              </p>
              <span
                aria-hidden="true"
                className="mt-1 block text-right font-serif text-4xl leading-none text-[#3ef0a8]"
              >
                &rdquo;
              </span>
              <div className="mt-4 flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/40">
                  <FinPointLogo className="h-6 w-6" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-white">FinPoint Control Plane</p>
                  <p className="text-[11px] text-white/45">Autonomous revenue recovery</p>
                </div>
              </div>

              {/* Capability rows — dashboard MiniMetric language */}
              <div className="mt-4 space-y-1.5">
                <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3">
                  <span aria-hidden="true" className="h-9 w-[3px] shrink-0 rounded-full bg-emerald-400" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-white">Policy guardrails</p>
                    <p className="truncate text-[11px] text-white/45">
                      Deterministic enforcement on every action
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3">
                  <span aria-hidden="true" className="h-9 w-[3px] shrink-0 rounded-full bg-cyan-400" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-white">Human approvals</p>
                    <p className="truncate text-[11px] text-white/45">
                      High-value recoveries reviewed
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3">
                  <span aria-hidden="true" className="h-9 w-[3px] shrink-0 rounded-full bg-amber-400" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-white">Audit trail</p>
                    <p className="truncate text-[11px] text-white/45">
                      Every event attributable
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div ref={artRef} className="mt-4 min-h-0 flex-1 px-8 pb-0">
              <LoginArt />
            </div>
          </div>
        </div>

        <p className="mt-3 hidden text-center font-mono text-[10px] tracking-wider text-slate-600 [@media(min-height:800px)]:block">
          ZERO-RISK SIMULATION · POLICY-GUARDED · AUDITED
        </p>
      </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-black text-xs text-slate-500">
          Loading...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
