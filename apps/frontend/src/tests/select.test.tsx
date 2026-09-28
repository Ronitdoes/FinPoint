// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { useState } from "react";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { Select } from "../components/ui/Select";

afterEach(cleanup);

const OPTIONS = [
  { value: "", label: "All Bands (Critical to Low)" },
  { value: "CRITICAL", label: "CRITICAL (Score ≥ 85)" },
  { value: "HIGH", label: "HIGH (Score 60–84)" },
];

function ControlledHarness({
  initial = "",
  onSelection,
}: {
  initial?: string;
  onSelection?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      label="Risk Band"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        onSelection?.(e.target.value);
      }}
      options={OPTIONS}
    />
  );
}

function trigger() {
  return screen.getByRole("combobox", { name: "Risk Band" });
}

describe("Select listbox (design-language dropdown)", () => {
  it("renders the selected option label in the trigger", () => {
    render(<ControlledHarness initial="HIGH" />);
    expect(trigger().textContent).toContain("HIGH (Score 60–84)");
  });

  it("opens the menu on click and lists every option", () => {
    render(<ControlledHarness />);
    fireEvent.click(trigger());
    const items = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("All Bands (Critical to Low)");
  });

  it("selecting an option fires onChange with target.value and closes", () => {
    const onSelection = vi.fn();
    render(<ControlledHarness onSelection={onSelection} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: /HIGH/ }));
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onSelection).toHaveBeenCalledWith("HIGH");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().textContent).toContain("HIGH (Score 60–84)");
  });

  it("supports full keyboard flow: open, move, select", () => {
    const onSelection = vi.fn();
    render(<ControlledHarness onSelection={onSelection} />);
    const el = trigger();
    (el as HTMLElement).focus();

    fireEvent.keyDown(el, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).not.toBeNull();

    fireEvent.keyDown(el, { key: "ArrowDown" });
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onSelection).toHaveBeenCalledWith("CRITICAL");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape closes the menu without selecting", () => {
    const onSelection = vi.fn();
    render(<ControlledHarness onSelection={onSelection} />);
    const el = trigger();
    fireEvent.click(el);
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(el, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSelection).not.toHaveBeenCalled();
  });

  it("marks the current value with aria-selected", () => {
    render(<ControlledHarness initial="CRITICAL" />);
    fireEvent.click(trigger());
    expect(
      screen
        .getByRole("option", { name: /CRITICAL/ })
        .getAttribute("aria-selected")
    ).toBe("true");
  });

  it("renders error text and honors disabled", () => {
    render(
      <Select
        label="Risk Band"
        value=""
        onChange={() => {}}
        options={OPTIONS}
        error="Selection required"
        disabled
      />
    );
    expect(screen.getByText("Selection required").textContent).toBe(
      "Selection required"
    );
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    // Disabled trigger must not open.
    fireEvent.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
