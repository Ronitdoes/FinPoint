// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Modal } from "../components/ui/Modal";

afterEach(cleanup);

describe("Modal (portal-anchored dialog)", () => {
  it("renders into document.body with portal", () => {
    const onClose = vi.fn();
    render(
      <Modal
        isOpen={true}
        onClose={onClose}
        title="Test Modal Title"
        description="Test modal description"
        footer={<button>Submit</button>}
      >
        <p>Modal body content</p>
      </Modal>
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByText("Test Modal Title")).toBeTruthy();
    expect(screen.getByText("Test modal description")).toBeTruthy();
    expect(screen.getByText("Modal body content")).toBeTruthy();
    expect(screen.getByText("Submit")).toBeTruthy();
  });

  it("does not render anything when isOpen is false", () => {
    render(
      <Modal isOpen={false} onClose={() => {}} title="Hidden Modal">
        <p>Should not exist</p>
      </Modal>
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Hidden Modal")).toBeNull();
  });

  it("calls onClose when the close (X) button is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Closable Modal">
        <p>Content</p>
      </Modal>
    );

    const closeBtn = screen.getByRole("button", { name: "Close modal" });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Escape Modal">
        <p>Content</p>
      </Modal>
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("manages body overflow style to prevent background scrolling", () => {
    const { unmount } = render(
      <Modal isOpen={true} onClose={() => {}} title="Overflow Modal">
        <p>Content</p>
      </Modal>
    );

    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("unset");
  });
});
