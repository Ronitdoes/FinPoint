import React from "react";
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from "lucide-react";

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "info" | "success" | "warning" | "error";
  title?: string;
  onDismiss?: () => void;
}

export function Alert({
  variant = "info",
  title,
  children,
  onDismiss,
  className = "",
  ...props
}: AlertProps) {
  const variantStyles = {
    info: "bg-cyan-400/10 border-cyan-400/20 text-cyan-200",
    success: "bg-emerald-400/10 border-emerald-400/20 text-emerald-200",
    warning: "bg-amber-400/10 border-amber-400/20 text-amber-200",
    error: "bg-rose-400/10 border-rose-400/20 text-rose-200",
  };

  const icons = {
    info: <Info className="h-4 w-4 text-cyan-400 shrink-0 mt-0.5" />,
    success: <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />,
    warning: <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />,
    error: <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />,
  };

  return (
    <div
      role="alert"
      className={`relative flex items-start gap-3 rounded-2xl border p-4 text-xs backdrop-blur-xl bg-gradient-to-br from-white/[0.06] to-transparent shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] transition-[transform,background-color,border-color] ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {icons[variant]}
      <div className="flex-1">
        {title && <h4 className="font-semibold mb-1 text-slate-100 text-xs">{title}</h4>}
        <div className="text-slate-300 leading-relaxed font-normal">{children}</div>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="rounded-lg p-1 text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition-colors cursor-pointer"
          aria-label="Dismiss alert"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
