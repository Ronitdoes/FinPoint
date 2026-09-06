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
      "bg-[#3ef0a8] hover:bg-[#63f7bb] text-black font-semibold border-[#3ef0a8] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.45),0_10px_36px_-10px_rgba(62,240,168,0.65)] hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5),0_12px_44px_-10px_rgba(62,240,168,0.75)] active:scale-[0.98]",
    secondary:
      "bg-white/[0.05] hover:bg-white/[0.10] text-slate-200 border-white/10 hover:border-white/15 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] active:scale-[0.98]",
    outline:
      "bg-white/[0.05] hover:bg-white/[0.10] text-slate-300 border-white/10 hover:border-white/15 backdrop-blur-xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] hover:text-white active:scale-[0.98]",
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
      className={`inline-flex items-center justify-center gap-2 border will-change-transform transition-[transform,background-color,border-color,box-shadow] duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none select-none focus:outline-none focus:ring-2 focus:ring-emerald-500/20 ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
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
