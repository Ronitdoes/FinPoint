import React from "react";
import { Loader2 } from "lucide-react";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "primary"
    | "secondary"
    | "outline"
    | "danger"
    | "warning"
    | "ghost"
    | "success";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: React.ReactNode;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  icon,
  className = "",
  ...props
}: ButtonProps) {
  const variantStyles = {
    primary:
      "bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold border-emerald-400/30 shadow-sm shadow-emerald-950/40 hover:shadow-md hover:shadow-emerald-500/20 active:bg-emerald-600 active:scale-[0.98]",
    secondary:
      "bg-[#131926] hover:bg-[#1a2335] text-slate-200 border-white/[0.08] hover:border-white/[0.16] shadow-sm active:bg-[#0f141e] active:scale-[0.98]",
    outline:
      "bg-transparent hover:bg-white/[0.04] text-slate-300 border-white/[0.12] hover:border-white/[0.24] hover:text-white active:scale-[0.98]",
    danger:
      "bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border-rose-500/30 hover:border-rose-500/50 shadow-sm active:bg-rose-500/30 active:scale-[0.98]",
    warning:
      "bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border-amber-500/30 hover:border-amber-500/50 shadow-sm active:bg-amber-500/30 active:scale-[0.98]",
    success:
      "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border-emerald-500/30 hover:border-emerald-500/50 shadow-sm active:bg-emerald-500/30 active:scale-[0.98]",
    ghost:
      "bg-transparent hover:bg-white/[0.06] text-slate-400 hover:text-slate-200 border-transparent active:scale-[0.98]",
  };

  const sizeStyles = {
    sm: "px-2.5 py-1.5 text-xs font-medium rounded-lg",
    md: "px-3.5 py-2 text-xs font-medium rounded-xl",
    lg: "px-4.5 py-2.5 text-sm font-medium rounded-xl",
  };

  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 border transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none select-none focus:outline-none focus:ring-2 focus:ring-emerald-500/20 ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-current shrink-0" />
      ) : (
        icon && <span className="shrink-0">{icon}</span>
      )}
      {children}
    </button>
  );
}
