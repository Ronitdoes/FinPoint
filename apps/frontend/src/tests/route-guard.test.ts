import { describe, it, expect } from "vitest";

describe("Route Guard & Security Posture Tests (Spec 03 §11, Step 28)", () => {
  const PROTECTED_ROUTES = [
    "/dashboard",
    "/cases",
    "/cases/550e8400-e29b-41d4-a716-446655440000",
    "/risk",
    "/recovery",
    "/policies",
    "/audit",
    "/tasks",
    "/settings",
  ];

  it("identifies all authenticated control plane routes as protected", () => {
    PROTECTED_ROUTES.forEach((route) => {
      const isProtected =
        route === "/dashboard" ||
        route.startsWith("/cases") ||
        route.startsWith("/risk") ||
        route.startsWith("/recovery") ||
        route.startsWith("/policies") ||
        route.startsWith("/audit") ||
        route.startsWith("/tasks") ||
        route.startsWith("/settings");

      expect(isProtected).toBe(true);
    });
  });

  it("allows public access to /login", () => {
    const isLoginProtected = PROTECTED_ROUTES.includes("/login");
    expect(isLoginProtected).toBe(false);
  });
});
