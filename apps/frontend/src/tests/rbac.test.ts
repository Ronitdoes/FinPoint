import { describe, it, expect } from "vitest";
import {
  hasPermission,
  canPauseResume,
  canEscalate,
  canStop,
  canApproveTasks,
  canManagePolicies,
  canManageAdmin,
} from "../lib/rbac";

describe("Frontend RBAC Matrix & Permission Gating (Spec 01 §22, Step 09, Step 28)", () => {
  it("enforces VIEWER role permissions strictly (observation-only)", () => {
    expect(hasPermission("VIEWER", "READ_CASES_ANALYTICS")).toBe(true);
    expect(canPauseResume("VIEWER")).toBe(false);
    expect(canEscalate("VIEWER")).toBe(false);
    expect(canStop("VIEWER")).toBe(false);
    expect(canApproveTasks("VIEWER")).toBe(false);
    expect(canManagePolicies("VIEWER")).toBe(false);
    expect(canManageAdmin("VIEWER")).toBe(false);
  });

  it("enforces SUPPORT role permissions", () => {
    expect(hasPermission("SUPPORT", "READ_CASES_ANALYTICS")).toBe(true);
    expect(canEscalate("SUPPORT")).toBe(true);
    expect(canPauseResume("SUPPORT")).toBe(false);
    expect(canStop("SUPPORT")).toBe(false);
    expect(canApproveTasks("SUPPORT")).toBe(false);
    expect(canManagePolicies("SUPPORT")).toBe(false);
  });

  it("enforces OPERATIONS role permissions", () => {
    expect(canPauseResume("OPERATIONS")).toBe(true);
    expect(canEscalate("OPERATIONS")).toBe(true);
    expect(canApproveTasks("OPERATIONS")).toBe(true);
    expect(canStop("OPERATIONS")).toBe(false); // Stop is Finance+
    expect(canManagePolicies("OPERATIONS")).toBe(false); // Policies is Finance+
    expect(canManageAdmin("OPERATIONS")).toBe(false);
  });

  it("enforces FINANCE role permissions", () => {
    expect(canPauseResume("FINANCE")).toBe(true);
    expect(canEscalate("FINANCE")).toBe(true);
    expect(canApproveTasks("FINANCE")).toBe(true);
    expect(canStop("FINANCE")).toBe(true);
    expect(canManagePolicies("FINANCE")).toBe(true);
    expect(canManageAdmin("FINANCE")).toBe(false); // Admin only
  });

  it("enforces ADMIN role permissions (full super-user capability)", () => {
    expect(canPauseResume("ADMIN")).toBe(true);
    expect(canEscalate("ADMIN")).toBe(true);
    expect(canApproveTasks("ADMIN")).toBe(true);
    expect(canStop("ADMIN")).toBe(true);
    expect(canManagePolicies("ADMIN")).toBe(true);
    expect(canManageAdmin("ADMIN")).toBe(true);
  });
});
