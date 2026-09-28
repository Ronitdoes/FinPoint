"use client";

import React from "react";
import { formatDate, getRiskBandColor } from "../../lib/format";

export interface RiskRuleContribution {
  detail?: unknown;
  points?: unknown;
  ruleId?: unknown;
  matched?: unknown;
}

export interface RiskFactorBreakdownProps {
  factors: Record<string, unknown> | null | undefined;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuleLike(value: unknown): value is RiskRuleContribution {
  if (!isRecord(value)) return false;
  return (
    "detail" in value || "points" in value || "ruleId" in value || "matched" in value
  );
}

function toPoints(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
      <span className="flex shrink-0 items-center gap-2 text-xs font-medium text-white/70">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" aria-hidden="true" />
        {label}
      </span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

function RuleRow({ rule }: { rule: RiskRuleContribution }) {
  const matched = rule.matched === true;
  const points = toPoints(rule.points);
  const detail = typeof rule.detail === "string" ? rule.detail : null;
  const ruleId = typeof rule.ruleId === "string" ? rule.ruleId : null;

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span
            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
              matched ? "bg-[#3ef0a8]" : "bg-white/20"
            }`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-xs leading-relaxed text-white/75">
              {detail ?? ruleId ?? "Unnamed rule"}
            </p>
            {detail && ruleId && (
              <p className="mt-1 truncate font-mono text-[10px] text-white/30" title={ruleId}>
                {ruleId}
              </p>
            )}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ${
            matched && (points ?? 0) > 0
              ? "border-[#3ef0a8]/30 bg-[#3ef0a8]/10 text-[#3ef0a8]"
              : "border-white/[0.08] bg-black/40 text-white/50"
          }`}
        >
          {points !== null ? `+${points} pts` : "—"}
        </span>
      </div>
      <p className="mt-2 pl-3.5 text-[10px] font-medium uppercase tracking-wider text-white/30">
        {matched ? "Matched" : "Not matched"}
      </p>
    </div>
  );
}

/**
 * Structured rendering of a risk evaluation `factors` payload
 * (`{ rules, baseScore, totalScore, band, evaluatedAt, breakdown }`).
 *
 * Replaces raw `JSON.stringify` dumps with design-language rows: rule
 * contributions with matched state + points, proportional breakdown bars,
 * and formatted scalars. Unknown extra keys degrade to labeled scalar rows
 * (compact JSON only as a last resort) — never an opaque blob.
 */
export function RiskFactorBreakdown({ factors }: RiskFactorBreakdownProps) {
  const bandStyles = (band: string) => getRiskBandColor(band);

  if (!factors || Object.keys(factors).length === 0) {
    return (
      <p className="text-xs italic text-white/40">
        No specific factor breakdown stored
      </p>
    );
  }

  const {
    rules,
    breakdown,
    band,
    baseScore,
    totalScore,
    evaluatedAt,
    ...rest
  } = factors as Record<string, unknown> & {
    rules?: unknown;
    breakdown?: unknown;
    band?: unknown;
    baseScore?: unknown;
    totalScore?: unknown;
    evaluatedAt?: unknown;
  };

  const ruleList = Array.isArray(rules) ? rules.filter(isRuleLike) : [];
  const breakdownMap =
    isRecord(breakdown) &&
    Object.values(breakdown).every((v) => toPoints(v) !== null)
      ? (breakdown as Record<string, unknown>)
      : null;
  const total = toPoints(totalScore) ?? 0;
  const base = toPoints(baseScore);
  const bandLabel = typeof band === "string" ? band : null;
  const evaluated = isIsoDateString(evaluatedAt)
    ? formatDate(evaluatedAt)
    : typeof evaluatedAt === "string" || typeof evaluatedAt === "number"
      ? String(evaluatedAt)
      : null;

  return (
    <div className="space-y-2">
      {bandLabel && (
        <Row label="Band">
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${bandStyles(bandLabel).bg} ${bandStyles(bandLabel).text} ${bandStyles(bandLabel).border}`}
          >
            {bandLabel}
          </span>
        </Row>
      )}

      {ruleList.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-widest text-white/45">
            Rule contributions
          </h4>
          {ruleList.map((rule, index) => (
            <RuleRow
              key={
                typeof rule.ruleId === "string"
                  ? rule.ruleId
                  : `rule-${index}`
              }
              rule={rule}
            />
          ))}
        </div>
      )}

      {base !== null && (
        <Row label="Base score">
          <span className="font-mono text-xs font-semibold tabular-nums text-white/80">
            {base}
          </span>
        </Row>
      )}

      {breakdownMap && Object.keys(breakdownMap).length > 0 && (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.04] p-3.5">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-white/45">
            Points breakdown
          </p>
          <div className="space-y-2.5">
            {Object.entries(breakdownMap).map(([ruleId, raw]) => {
              const points = toPoints(raw) ?? 0;
              const pct =
                total > 0
                  ? Math.max(points > 0 ? 3 : 0, Math.min(100, (points / total) * 100))
                  : 0;
              return (
                <div key={ruleId}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-mono text-white/55" title={ruleId}>
                      {ruleId}
                    </span>
                    <span className="shrink-0 font-mono font-semibold tabular-nums text-white/80">
                      +{points}
                    </span>
                  </div>
                  <div
                    className="h-1 overflow-hidden rounded-full bg-white/[0.06]"
                    role="img"
                    aria-label={`${ruleId} contributes ${points} of ${total} points`}
                  >
                    <div
                      className={`h-full rounded-full ${points > 0 ? "bg-white/40" : "bg-transparent"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Row label="Total score">
        <span className="font-mono text-xs font-bold tabular-nums text-white">
          {total}
          <span className="font-medium text-white/40">/100</span>
        </span>
      </Row>

      {evaluated && (
        <Row label="Evaluated at">
          <span className="font-mono text-[11px] tabular-nums text-white/75">
            {evaluated}
          </span>
        </Row>
      )}

      {Object.entries(rest).map(([key, val]) => (
        <Row key={key} label={humanizeKey(key)}>
          {typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? (
            <span className="font-mono text-[11px] tabular-nums text-white/75">
              {String(val)}
            </span>
          ) : (
            <span className="block max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-2 text-left font-mono text-[10px] leading-relaxed text-white/55">
              {JSON.stringify(val, null, 1)}
            </span>
          )}
        </Row>
      ))}
    </div>
  );
}
