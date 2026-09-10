// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { RiskFactorBreakdown } from "../components/risk/RiskFactorBreakdown";

afterEach(cleanup);

const FACTORS = {
  rules: [
    {
      detail: "Customer has 4 failed payment(s) (threshold >= 1)",
      points: 20,
      ruleId: "payment_failed_count_gte_1",
      matched: true,
    },
    {
      detail: "Subject amount meets high-value threshold",
      points: 0,
      ruleId: "amount_high",
      matched: false,
    },
  ],
  baseScore: 0,
  totalScore: 60,
  band: "HIGH",
  evaluatedAt: "2026-09-10T14:13:05.281Z",
  breakdown: {
    amount_high: 0,
    customer_active: 10,
    payment_failed_count_gte_1: 20,
  },
};

describe("RiskFactorBreakdown (structured factor rendering)", () => {
  it("renders each rule with detail, points, and matched state", () => {
    render(<RiskFactorBreakdown factors={FACTORS} />);
    expect(
      screen.getByText("Customer has 4 failed payment(s) (threshold >= 1)")
    ).toBeTruthy();
    expect(screen.getByText("+20 pts")).toBeTruthy();
    expect(screen.getByText("+0 pts")).toBeTruthy();
    expect(screen.getByText("Matched")).toBeTruthy();
    expect(screen.getByText("Not matched")).toBeTruthy();
    // ruleId appears as the sub-caption and in the breakdown rows.
    expect(screen.getAllByText("payment_failed_count_gte_1").length).toBeGreaterThan(0);
  });

  it("renders band badge, total score, and a formatted date (never raw ISO)", () => {
    const { container } = render(<RiskFactorBreakdown factors={FACTORS} />);
    expect(screen.getByText("HIGH")).toBeTruthy();
    expect(container.textContent).toContain("60");
    expect(container.textContent).not.toContain("2026-09-10T14:13:05.281Z");
    // Formatted date appears instead.
    expect(container.textContent).toMatch(/Sep 10, 2026/);
  });

  it("renders proportional breakdown bars for every rule", () => {
    render(<RiskFactorBreakdown factors={FACTORS} />);
    const bar = screen.getByRole("img", {
      name: /payment_failed_count_gte_1 contributes 20 of 60 points/,
    });
    expect(bar).toBeTruthy();
    expect(screen.getByText("customer_active")).toBeTruthy();
  });

  it("never dumps the raw rules array as a JSON blob", () => {
    const { container } = render(<RiskFactorBreakdown factors={FACTORS} />);
    expect(container.textContent).not.toContain('"ruleId"');
    expect(container.textContent).not.toContain('"matched":true');
  });

  it("shows an empty state when no factors are stored", () => {
    const { unmount } = render(<RiskFactorBreakdown factors={{}} />);
    expect(
      screen.getByText("No specific factor breakdown stored")
    ).toBeTruthy();
    unmount();

    render(<RiskFactorBreakdown factors={null} />);
    expect(
      screen.getByText("No specific factor breakdown stored")
    ).toBeTruthy();
  });

  it("degrades unknown scalar keys to labeled rows without throwing", () => {
    render(
      <RiskFactorBreakdown
        factors={{ customSignal: "elevated", retryCount: 3 }}
      />
    );
    expect(screen.getByText("Custom Signal")).toBeTruthy();
    expect(screen.getByText("elevated")).toBeTruthy();
    expect(screen.getByText("Retry Count")).toBeTruthy();
  });
});
