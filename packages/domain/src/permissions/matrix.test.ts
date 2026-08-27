import { describe, it, expect } from "vitest";
import {
  PERMISSION_ACTIONS,
  ROLE_PERMISSIONS,
  hasPermission,
  getRolesWithPermission,
  type PermissionAction,
} from "./matrix";
import { USER_ROLES, type UserRole } from "../enums/user-role";

describe("RBAC Permission Matrix", () => {
  // Expected matrix table from specs/steps/s-09.md §Technical Implementation
  const EXPECTED_MATRIX: Record<PermissionAction, Record<UserRole, boolean>> = {
    READ_CASES_ANALYTICS: {
      VIEWER: true,
      SUPPORT: true,
      OPERATIONS: true,
      FINANCE: true,
      ADMIN: true,
    },
    PAUSE_RESUME_CASE: {
      VIEWER: false,
      SUPPORT: false,
      OPERATIONS: true,
      FINANCE: true,
      ADMIN: true,
    },
    ESCALATE_CASE: {
      VIEWER: false,
      SUPPORT: true,
      OPERATIONS: true,
      FINANCE: true,
      ADMIN: true,
    },
    APPROVE_HUMAN_TASK: {
      VIEWER: false,
      SUPPORT: false,
      OPERATIONS: true,
      FINANCE: true,
      ADMIN: true,
    },
    MANAGE_POLICIES: {
      VIEWER: false,
      SUPPORT: false,
      OPERATIONS: false,
      FINANCE: true,
      ADMIN: true,
    },
    MANAGE_USERS_API_KEYS: {
      VIEWER: false,
      SUPPORT: false,
      OPERATIONS: false,
      FINANCE: false,
      ADMIN: true,
    },
    TRIGGER_REPLAY_DEMO: {
      VIEWER: false,
      SUPPORT: false,
      OPERATIONS: true,
      FINANCE: true,
      ADMIN: true,
    },
  };

  it("covers all 5 roles and all 7 actions in the canonical spec matrix", () => {
    expect(USER_ROLES).toHaveLength(5);
    expect(PERMISSION_ACTIONS).toHaveLength(7);
  });

  describe("Exhaustive Role × Action evaluation", () => {
    for (const action of PERMISSION_ACTIONS) {
      for (const role of USER_ROLES) {
        const expected = EXPECTED_MATRIX[action][role];
        it(`evaluates hasPermission("${role}", "${action}") -> ${expected}`, () => {
          expect(hasPermission(role, action)).toBe(expected);
          expect(ROLE_PERMISSIONS[role].has(action)).toBe(expected);
        });
      }
    }
  });

  describe("getRolesWithPermission helper", () => {
    it("returns correct list of roles for MANAGE_USERS_API_KEYS (ADMIN only)", () => {
      expect(getRolesWithPermission("MANAGE_USERS_API_KEYS")).toEqual(["ADMIN"]);
    });

    it("returns correct list of roles for READ_CASES_ANALYTICS (all roles)", () => {
      expect(getRolesWithPermission("READ_CASES_ANALYTICS")).toEqual([
        "VIEWER",
        "SUPPORT",
        "OPERATIONS",
        "FINANCE",
        "ADMIN",
      ]);
    });

    it("returns correct list of roles for MANAGE_POLICIES (FINANCE, ADMIN)", () => {
      expect(getRolesWithPermission("MANAGE_POLICIES")).toEqual([
        "FINANCE",
        "ADMIN",
      ]);
    });
  });
});
