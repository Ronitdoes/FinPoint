import React from "react";

interface SkeletonProps {
  className?: string;
}

/** Base shimmer block. Pair with explicit width/height via className. */
export function Skeleton({ className = "" }: SkeletonProps) {
  return <div aria-hidden="true" className={`skeleton-shimmer rounded-lg ${className}`} />;
}

/** Table-shaped skeleton: header pills + body rows with varied widths. */
export function SkeletonTable({
  rows = 6,
  cols = 6,
  className = "",
}: SkeletonProps & { rows?: number; cols?: number }) {
  return (
    <div className={className} aria-hidden="true" role="presentation">
      <div
        className="grid gap-3 border-b border-white/[0.06] pb-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: cols }).map((_, i) => (
          <div key={i} className="skeleton-shimmer h-2.5 rounded-full" style={{ width: `${55 + ((i * 13) % 30)}%` }} />
        ))}
      </div>
      <div className="divide-y divide-white/[0.05]">
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="grid items-center gap-3 py-3"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: cols }).map((_, c) => (
              <div
                key={c}
                className="skeleton-shimmer h-3 rounded-full"
                style={{ width: `${45 + ((r * 29 + c * 17) % 50)}%` }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Metric-card-shaped skeleton blocks in a responsive grid. */
export function SkeletonCards({
  count = 4,
  className = "",
  cardClassName = "",
}: SkeletonProps & { count?: number; cardClassName?: string }) {
  return (
    <div className={`grid grid-cols-1 gap-2.5 sm:grid-cols-2 ${className}`} aria-hidden="true" role="presentation">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={`rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3.5 ${cardClassName}`}
        >
          <div className="skeleton-shimmer h-2.5 w-1/2 rounded-full" />
          <div
            className="skeleton-shimmer mt-3 h-6 rounded-lg"
            style={{ width: `${55 + ((i * 23) % 30)}%` }}
          />
          <div className="skeleton-shimmer mt-2 h-2 w-1/3 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Chart-panel-shaped skeleton: legend row + plot area with axis ticks. */
export function SkeletonChart({
  height = 280,
  className = "",
}: SkeletonProps & { height?: number }) {
  return (
    <div className={className} aria-hidden="true" role="presentation">
      <div className="flex items-center justify-end gap-3">
        <div className="skeleton-shimmer h-2.5 w-16 rounded-full" />
        <div className="skeleton-shimmer h-2.5 w-20 rounded-full" />
      </div>
      <div className="relative mt-3 overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02]" style={{ height }}>
        {[0.18, 0.4, 0.62, 0.84].map((top) => (
          <div
            key={top}
            className="absolute inset-x-4 border-t border-dashed border-white/[0.07]"
            style={{ top: `${top * 100}%` }}
          />
        ))}
        <div className="skeleton-shimmer absolute inset-x-4 bottom-4 top-4 rounded-xl" />
      </div>
    </div>
  );
}

/** Compact label/value stat rows skeleton. */
export function SkeletonStats({
  count = 4,
  className = "",
}: SkeletonProps & { count?: number }) {
  return (
    <div className={`divide-y divide-white/[0.06] ${className}`} aria-hidden="true" role="presentation">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-2 py-2">
          <div className="skeleton-shimmer h-2.5 rounded-full" style={{ width: `${30 + ((i * 19) % 20)}%` }} />
          <div className="skeleton-shimmer h-4 w-16 rounded-md" />
        </div>
      ))}
    </div>
  );
}
