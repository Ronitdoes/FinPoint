import React from "react";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?:
    | "default"
    | "success"
    | "warning"
    | "danger"
    | "info"
    | "outline"
    | "secondary";
  size?: "sm" | "md" | "lg";
  dot?: boolean;
  pulse?: boolean;
}

export function Badge({
  children,
  variant = "default",
  size = "md",
  dot = false,
  pulse = false,
  className = "",
  ...props
}: BadgeProps) {
  const variantStyles = {
    default: "bg-slate-800/80 text-slate-300 border-white/[0.08]",
    success:
      "bg-emerald-500/10 text-emerald-400 border-emerald-500/25 shadow-[0_0_12px_-3px_rgba(16,185,129,0.2)]",
    warning:
      "bg-amber-500/10 text-amber-300 border-amber-500/25 shadow-[0_0_12px_-3px_rgba(245,158,11,0.2)]",
    danger:
      "bg-rose-500/10 text-rose-300 border-rose-500/25 shadow-[0_0_12px_-3px_rgba(244,63,94,0.2)]",
    info:
      "bg-cyan-500/10 text-cyan-300 border-cyan-500/25 shadow-[0_0_12px_-3px_rgba(6,182,212,0.2)]",
    secondary:
      "bg-indigo-500/10 text-indigo-300 border-indigo-500/25 shadow-[0_0_12px_-3px_rgba(99,102,241,0.2)]",
    outline: "bg-transparent text-slate-400 border-white/[0.12]",
  };

  const dotColors = {
    default: "bg-slate-400",
    success: "bg-emerald-400",
    warning: "bg-amber-400",
    danger: "bg-rose-400",
    info: "bg-cyan-400",
    secondary: "bg-indigo-400",
    outline: "bg-slate-400",
  };

  const sizeStyles = {
    sm: "px-2 py-0.5 text-[10px] font-medium tracking-wide",
    md: "px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
    lg: "px-3 py-1 text-xs font-semibold tracking-wide",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border transition-all ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          {pulse && (
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${dotColors[variant]}`}
            />
          )}
          <span
            className={`relative inline-flex rounded-full h-1.5 w-1.5 ${dotColors[variant]}`}
            aria-hidden="true"
          />
        </span>
      )}
      {children}
    </span>
  );
}
