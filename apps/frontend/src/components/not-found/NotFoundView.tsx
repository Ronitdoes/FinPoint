"use client";

import React, { useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Home, ArrowLeft, Layers, ArrowUpRight } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Button } from "../ui/Button";
import { FinPointLogo } from "../brand/FinPointLogo";

gsap.registerPlugin(useGSAP);

export function NotFoundView() {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLDivElement>(null);

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
          const tl = gsap.timeline({
            defaults: { duration: 0.65, ease: "power3.out" },
          });

          // Staggered cinematic entrance
          tl.fromTo(
            q(".nf-header"),
            { y: -16, autoAlpha: 0 },
            { y: 0, autoAlpha: 1, duration: 0.5, clearProps: "transform" }
          )
            .fromTo(
              q(".nf-hero-num"),
              { y: 24, autoAlpha: 0 },
              {
                y: 0,
                autoAlpha: 1,
                stagger: 0.08,
                clearProps: "transform",
              },
              "-=0.25"
            )
            .fromTo(
              orbRef.current,
              { scale: 0.8, autoAlpha: 0, rotate: -8 },
              {
                scale: 1,
                autoAlpha: 1,
                rotate: 0,
                duration: 0.7,
                ease: "back.out(1.4)",
                clearProps: "transform",
              },
              "-=0.4"
            )
            .fromTo(
              q(".nf-text"),
              { y: 16, autoAlpha: 0 },
              { y: 0, autoAlpha: 1, stagger: 0.06, clearProps: "transform" },
              "-=0.35"
            )
            .fromTo(
              q(".nf-actions"),
              { y: 14, autoAlpha: 0 },
              { y: 0, autoAlpha: 1, duration: 0.45, clearProps: "transform" },
              "-=0.25"
            )
            .fromTo(
              q(".nf-footer"),
              { autoAlpha: 0 },
              { autoAlpha: 1, duration: 0.4 },
              "-=0.1"
            );

          // Subtle floating ambient pulse on FinPoint orb
          if (orbRef.current) {
            gsap.to(orbRef.current, {
              y: -4,
              duration: 2.4,
              repeat: -1,
              yoyo: true,
              ease: "sine.inOut",
            });
          }
        }
      );

      return () => mm.revert();
    },
    { scope: rootRef }
  );

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/dashboard");
    }
  };

  return (
    <div
      ref={rootRef}
      className="min-h-screen bg-black p-2 sm:p-3 text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-200 flex flex-col"
    >
      {/* Outer rounded container mirroring FinPoint dashboard shell */}
      <div className="relative flex flex-1 min-h-[calc(100vh-1rem)] sm:min-h-[calc(100vh-1.5rem)] flex-col justify-between overflow-hidden rounded-[26px] border-2 border-[#34343a] bg-[#070709] p-4 sm:p-7">
        {/* Subtle grid backdrop */}
        <div className="bg-grid-faint pointer-events-none" aria-hidden="true" />

        {/* Ambient mint glow accents */}
        <div
          className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-96 w-[640px] rounded-full bg-emerald-500/[0.08] blur-[120px]"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[420px] w-[540px] rounded-full bg-[#3ef0a8]/[0.05] blur-[140px]"
          aria-hidden="true"
        />

        {/* 1. Header Bar with FinPoint Brand and Status Indicator */}
        <header className="nf-header relative z-10 flex items-center justify-between gap-4">
          <Link
            href="/dashboard"
            className="group inline-flex h-11 items-center gap-2.5 rounded-full border border-white/[0.14] bg-[#141416]/90 pl-3 pr-4 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)] backdrop-blur-md transition-all duration-200 hover:border-white/25 hover:bg-[#1a1a1e]"
          >
            <FinPointLogo className="h-7 w-7 transition-transform duration-300 group-hover:scale-110" />
            <span className="text-[15px] font-bold tracking-tight text-white">
              FinPoint
            </span>
          </Link>

        </header>

        {/* 2. Hero Centerpiece */}
        <main className="relative z-10 mx-auto my-auto flex w-full max-w-2xl flex-col items-center py-6 text-center">

          {/* 404 Visual with FinPoint Emblem as Center Orb */}
          <div className="my-2 sm:my-4 flex items-center justify-center gap-3 sm:gap-6">
            <span className="nf-hero-num font-mono text-7xl sm:text-9xl font-extrabold tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white via-white/80 to-white/20 select-none drop-shadow-[0_10px_25px_rgba(0,0,0,0.8)]">
              4
            </span>

            {/* Glowing FinPoint Brand Orb Centerpiece */}
            <div
              ref={orbRef}
              className="relative flex h-20 w-20 sm:h-28 sm:w-28 items-center justify-center rounded-3xl border border-white/[0.18] bg-gradient-to-b from-[#182820] to-[#0b1611] shadow-[0_0_50px_rgba(62,240,168,0.25),inset_0_1px_1px_rgba(255,255,255,0.25)]"
            >
              <div
                className="absolute inset-0 rounded-3xl border border-[#3ef0a8]/25 animate-ping opacity-25"
                style={{ animationDuration: "3.2s" }}
              />
              <div className="absolute inset-2 rounded-2xl border border-emerald-500/20" />
              <FinPointLogo className="h-10 w-10 sm:h-14 sm:w-14 drop-shadow-[0_0_18px_rgba(108,245,177,0.7)]" />
            </div>

            <span className="nf-hero-num font-mono text-7xl sm:text-9xl font-extrabold tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white via-white/80 to-white/20 select-none drop-shadow-[0_10px_25px_rgba(0,0,0,0.8)]">
              4
            </span>
          </div>

          {/* Heading */}
          <h1 className="nf-text text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight text-white">
            Route Outside the Recovery Mesh
          </h1>

          {/* Subtitle */}
          <p className="nf-text mt-3 max-w-lg text-sm sm:text-base text-slate-400 leading-relaxed">
            The endpoint or resource you requested does not exist on this tenant.
            Active recovery workflows, retry schedules, and governance policies
            remain fully operational.
          </p>

          {/* 3. Action Buttons */}
          <div className="nf-actions mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link href="/dashboard">
              <Button
                variant="primary"
                size="lg"
                icon={<Home className="h-4 w-4" />}
                className="shadow-[0_0_24px_rgba(62,240,168,0.3)]"
              >
                Return to Dashboard
              </Button>
            </Link>

            <Link href="/cases">
              <Button
                variant="secondary"
                size="lg"
                icon={<Layers className="h-4 w-4" />}
              >
                View Recovery Cases
              </Button>
            </Link>

            <Button
              variant="outline"
              size="lg"
              onClick={handleBack}
              icon={<ArrowLeft className="h-4 w-4" />}
            >
              Go Back
            </Button>
          </div>
        </main>

        {/* 5. Footer Navigation Links */}
        <footer className="nf-footer relative z-10 border-t border-white/[0.06] pt-4 text-center">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-medium text-white/50">
            <span className="text-white/30">Direct Subsystems:</span>
            <Link
              href="/dashboard"
              className="transition-colors hover:text-white flex items-center gap-1"
            >
              Overview <ArrowUpRight className="h-3 w-3 opacity-60" />
            </Link>
            <Link
              href="/cases"
              className="transition-colors hover:text-white flex items-center gap-1"
            >
              Cases <ArrowUpRight className="h-3 w-3 opacity-60" />
            </Link>
            <Link
              href="/risk"
              className="transition-colors hover:text-white flex items-center gap-1"
            >
              Risk Engine <ArrowUpRight className="h-3 w-3 opacity-60" />
            </Link>
            <Link
              href="/policies"
              className="transition-colors hover:text-white flex items-center gap-1"
            >
              Policies <ArrowUpRight className="h-3 w-3 opacity-60" />
            </Link>
            <Link
              href="/tasks"
              className="transition-colors hover:text-white flex items-center gap-1"
            >
              Human Tasks <ArrowUpRight className="h-3 w-3 opacity-60" />
            </Link>
            <Link
              href="/audit"
              className="transition-colors hover:text-white flex items-center gap-1"
            >
              Audit Trail <ArrowUpRight className="h-3 w-3 opacity-60" />
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
