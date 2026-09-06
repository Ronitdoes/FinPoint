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
    default:
      "bg-white/[0.05] text-slate-300 border-white/10 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]",
    success:
      "bg-emerald-400/10 text-emerald-300 border-emerald-400/20 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_0_12px_-3px_rgba(16,185,129,0.2)]",
    warning:
      "bg-amber-400/10 text-amber-300 border-amber-400/20 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_0_12px_-3px_rgba(245,158,11,0.2)]",
    danger:
      "bg-rose-400/10 text-rose-300 border-rose-400/20 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_0_12px_-3px_rgba(244,63,94,0.2)]",
    info: "bg-cyan-400/10 text-cyan-300 border-cyan-400/20 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_0_12px_-3px_rgba(6,182,212,0.2)]",
    secondary:
      "bg-indigo-400/10 text-indigo-300 border-indigo-400/20 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_0_12px_-3px_rgba(99,102,241,0.2)]",
    outline:
      "bg-white/[0.03] text-slate-400 border-white/10 backdrop-blur-md shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]",
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
      className={`inline-flex items-center gap-1.5 rounded-full border transition-[transform,background-color,border-color] ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
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
