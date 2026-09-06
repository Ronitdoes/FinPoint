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
    "group relative overflow-hidden rounded-[20px] border border-white/[0.07] bg-[#131316] p-5 text-slate-100";
  const elevatedStyles = glass ? "border-white/10 bg-[#141416]" : "";
  const hoverStyles = hoverEffect
    ? "transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-white/[0.15] cursor-pointer"
    : "";

  const glowStyles = {
    none: "",
    emerald: "",
    cyan: "",
    indigo: "",
    rose: "",
  };

  return (
    <div
      className={`${baseStyles} ${elevatedStyles} ${hoverStyles} ${glowStyles[glow]} ${className}`}
      {...props}
    >
      {/* top light refraction streak */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
      />
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
      className={`hairline-b flex items-center justify-between gap-3 pb-3.5 mb-4 ${className}`}
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
