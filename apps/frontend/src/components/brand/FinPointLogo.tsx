/**
 * FinPoint brand mark — mint slash trio with a baseline dot,
 * drawn as pure SVG (no image assets).
 */
export function FinPointLogo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" className={className} role="img" aria-label="FinPoint logo">
      <g fill="#6CF5B1">
        <rect x="7" y="7" width="7" height="19" rx="2.4" transform="rotate(22 10.5 16.5)" />
        <rect x="16.5" y="7" width="7" height="19" rx="2.4" transform="rotate(22 20 16.5)" />
        <rect x="16.5" y="28.5" width="7" height="6.5" rx="2" transform="rotate(22 20 31.75)" />
      </g>
    </svg>
  );
}
