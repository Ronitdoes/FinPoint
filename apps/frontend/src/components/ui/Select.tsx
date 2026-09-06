import React from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  options: SelectOption[];
  error?: string;
  helperText?: string;
}

export function Select({
  label,
  options,
  error,
  helperText,
  className = "",
  id,
  ...props
}: SelectProps) {
  const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label
          htmlFor={selectId}
          className="block text-xs font-medium text-slate-300 tracking-tight"
        >
          {label}
        </label>
      )}
      <div className="relative">
        <select
          id={selectId}
          className={`w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs text-slate-100 shadow-inner backdrop-blur-xl transition-[border-color,background-color,box-shadow] focus:border-emerald-300/50 focus:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-emerald-400/15 disabled:cursor-not-allowed disabled:opacity-50 appearance-none pr-8 ${
            error ? "border-rose-500/60 focus:border-rose-500 focus:ring-rose-500/20" : ""
          } ${className}`}
          {...props}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} className="bg-[#0d111a] text-slate-100">
              {opt.label}
            </option>
          ))}
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>
      {error && <p className="text-[11px] text-rose-400 font-medium">{error}</p>}
      {helperText && !error && (
        <p className="text-[11px] text-slate-400">{helperText}</p>
      )}
    </div>
  );
}
