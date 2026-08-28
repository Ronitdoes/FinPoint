import React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  hoverEffect?: boolean;
  glass?: boolean;
  glow?: "emerald" | "cyan" | "indigo" | "rose" | "none";
}

export function Card({
  children,
  hoverEffect = false,
  glass = false,
  glow = "none",
  className = "",
  ...props
}: CardProps) {
  const baseStyles =
    "relative rounded-2xl border border-white/[0.07] bg-[#0d111a]/85 p-5 shadow-lg shadow-black/40 text-slate-100 backdrop-blur-xl transition-all duration-200";
  const glassStyles = glass
    ? "glass-card"
    : "";
  const hoverStyles = hoverEffect
    ? "hover:border-white/[0.14] hover:bg-[#111622]/90 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/60"
    : "";

  const glowStyles = {
    none: "",
    emerald: "before:absolute before:inset-0 before:-z-10 before:rounded-2xl before:bg-emerald-500/5 before:blur-xl",
    cyan: "before:absolute before:inset-0 before:-z-10 before:rounded-2xl before:bg-cyan-500/5 before:blur-xl",
    indigo: "before:absolute before:inset-0 before:-z-10 before:rounded-2xl before:bg-indigo-500/5 before:blur-xl",
    rose: "before:absolute before:inset-0 before:-z-10 before:rounded-2xl before:bg-rose-500/5 before:blur-xl",
  };

  return (
    <div
      className={`${baseStyles} ${glassStyles} ${hoverStyles} ${glowStyles[glow]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  children,
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`flex items-center justify-between gap-3 pb-3.5 mb-3.5 border-b border-white/[0.06] ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  className = "",
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={`text-sm font-semibold text-slate-100 tracking-tight flex items-center gap-2 ${className}`}
      {...props}
    >
      {children}
    </h3>
  );
}

export function CardDescription({
  children,
  className = "",
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={`text-xs text-slate-400 font-normal ${className}`} {...props}>
      {children}
    </p>
  );
}

export function CardContent({
  children,
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`space-y-4 ${className}`} {...props}>
      {children}
    </div>
  );
}
