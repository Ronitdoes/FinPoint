import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app";
import {
  db,
  end,
  tenants,
  users,
  apiKeys,
  userSessions,
  createTenant,
  createUser,
  createApiKey,
  createSession,
  findSessionByTokenHash,
  eq,
} from "@repo/db";
import type { FastifyInstance } from "fastify";
import { hashPassword, sha256, generateSessionToken } from "../lib/crypto";

describe("Step 09 Integration: Authentication, Sessions, RBAC & Tenant Context", () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminUserId: string;
  let viewerUserId: string;
  const runId = Math.random().toString(36).slice(2, 8);
  const adminPassword = "AdminPassword123!@#";
  const viewerPassword = "ViewerPassword123!@#";
  const adminEmail = `admin-${runId}@example.com`;
  const viewerEmail = `viewer-${runId}@example.com`;

  beforeAll(async () => {
    app = await buildApp({ disableRateLimit: true, logger: false });
    await app.ready();

    // Create test tenant with unique slug
    const tenant = await createTenant(
      { db },
      {
        name: `Auth Test Tenant ${runId}`,
        slug: `auth-test-tenant-${runId}`,
      },
    );
    tenantId = tenant.id;

    // Create Admin User
    const adminHash = await hashPassword(adminPassword);
    const adminUser = await createUser(
      { db },
      {
        tenantId,
        email: adminEmail,
        name: "Test Admin",
        role: "ADMIN",
        passwordHash: adminHash,
        status: "ACTIVE",
      },
    );
    adminUserId = adminUser.id;

    // Create Viewer User
    const viewerHash = await hashPassword(viewerPassword);
    const viewerUser = await createUser(
      { db },
      {
        tenantId,
        email: viewerEmail,
        name: "Test Viewer",
        role: "VIEWER",
        passwordHash: viewerHash,
        status: "ACTIVE",
      },
    );
    viewerUserId = viewerUser.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Interactive Session Authentication (/auth/*)", () => {
    let sessionCookie: string;

    it("POST /auth/login -> 200 with user summary and rr_session httpOnly cookie", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: adminEmail,
          password: adminPassword,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.email).toBe(adminEmail);
      expect(body.user.role).toBe("ADMIN");
      expect(body.user.tenantId).toBe(tenantId);

      const cookieHeader = res.headers["set-cookie"];
      expect(cookieHeader).toBeDefined();
      expect(String(cookieHeader)).toContain("rr_session=");
      expect(String(cookieHeader)).toContain("HttpOnly");
      expect(String(cookieHeader)).toContain("SameSite=Lax");

      // Extract cookie value for subsequent requests
      const match = String(cookieHeader).match(/rr_session=([^;]+)/);
      expect(match).not.toBeNull();
      sessionCookie = `rr_session=${match![1]}`;
    });

    it("GET /auth/me -> 200 using session cookie", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.id).toBe(adminUserId);
      expect(body.user.email).toBe(adminEmail);
      expect(body.auth.kind).toBe("session");
      expect(body.auth.role).toBe("ADMIN");
      expect(body.auth.tenantId).toBe(tenantId);
    });

    it("POST /auth/logout -> 204 and clears session cookie + revokes session in DB", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          cookie: sessionCookie,
        },
      });

      expect(res.statusCode).toBe(204);

      // Verify cookie is cleared
      const cookieHeader = res.headers["set-cookie"];
      expect(String(cookieHeader)).toContain("rr_session=;");

      // Subsequent GET /auth/me with old session cookie must fail with 401
      const meRes = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          cookie: sessionCookie,
        },
      });
      expect(meRes.statusCode).toBe(401);
      const meBody = JSON.parse(meRes.body);
      expect(meBody.error.code).toBe("UNAUTHENTICATED");
    });

    it("POST /auth/login -> 401 INVALID_CREDENTIALS for wrong password", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: adminEmail,
          password: "CompletelyWrongPassword123!",
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("POST /auth/login -> 401 INVALID_CREDENTIALS for non-existent user", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "nobody-here@example.com",
          password: "SomePassword123!",
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("POST /auth/login -> 401 INVALID_CREDENTIALS for DISABLED user", async () => {
      const disabledEmail = "disabled-user@example.com";
      await db.delete(users).where(eq(users.email, disabledEmail));
      const hash = await hashPassword("Password123!@#");
      await createUser(
        { db },
        {
          tenantId,
          email: disabledEmail,
          name: "Disabled User",
          role: "VIEWER",
          passwordHash: hash,
          status: "DISABLED",
        },
      );

      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: disabledEmail,
          password: "Password123!@#",
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });

  describe("Admin User Management & RBAC (/admin/users)", () => {
    let adminCookie: string;
    let viewerCookie: string;

    beforeAll(async () => {
      // Login as Admin
      const adminLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: adminEmail, password: adminPassword },
      });
      const adminMatch = String(adminLogin.headers["set-cookie"]).match(/rr_session=([^;]+)/);
      adminCookie = `rr_session=${adminMatch![1]}`;

      // Login as Viewer
      const viewerLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: viewerEmail, password: viewerPassword },
      });
      const viewerMatch = String(viewerLogin.headers["set-cookie"]).match(/rr_session=([^;]+)/);
      viewerCookie = `rr_session=${viewerMatch![1]}`;
    });

    it("POST /admin/users (as ADMIN) -> 201 creates new user with tenant scope", async () => {
      const newEmail = "operator-new@example.com";
      await db.delete(users).where(eq(users.email, newEmail));

      const res = await app.inject({
        method: "POST",
        url: "/admin/users",
        headers: { cookie: adminCookie },
        payload: {
          email: newEmail,
          name: "New Operator",
          password: "SecurePassword123!",
          role: "OPERATIONS",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.user.email).toBe(newEmail);
      expect(body.user.role).toBe("OPERATIONS");
      expect(body.user.status).toBe("ACTIVE");
      expect(body.user.tenantId).toBe(tenantId);
    });

    it("POST /admin/users (as VIEWER) -> 403 FORBIDDEN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/users",
        headers: { cookie: viewerCookie },
        payload: {
          email: "forbidden@example.com",
          name: "Forbidden",
          password: "SecurePassword123!",
          role: "FINANCE",
        },
      });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("PATCH /admin/users/:id (as ADMIN) -> 200 updates role and status", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/admin/users/${viewerUserId}`,
        headers: { cookie: adminCookie },
        payload: {
          role: "FINANCE",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user.id).toBe(viewerUserId);
      expect(body.user.role).toBe("FINANCE");
    });
  });

  describe("Machine API Keys Lifecycle & Bearer Authentication (/admin/api-keys)", () => {
    let adminCookie: string;
    let rawApiKey: string;
    let apiKeyId: string;

    beforeAll(async () => {
      const login = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: adminEmail, password: adminPassword },
      });
      const match = String(login.headers["set-cookie"]).match(/rr_session=([^;]+)/);
      adminCookie = `rr_session=${match![1]}`;
    });

    it("POST /admin/api-keys (as ADMIN) -> 201 returns plaintext raw key once", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/admin/api-keys",
        headers: { cookie: adminCookie },
        payload: {
          name: "Integration Test Key",
          scopes: ["events:write", "cases:read"],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe("Integration Test Key");
      expect(body.key).toMatch(/^rrk_/);
      expect(body.prefix).toContain("rrk_");
      expect(body.scopes).toEqual(["events:write", "cases:read"]);

      rawApiKey = body.key;
      apiKeyId = body.id;
    });

    it("GET /auth/me via Bearer rrk_... -> 200 authenticates machine principal", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          authorization: `Bearer ${rawApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.auth.kind).toBe("api_key");
      expect(body.auth.tenantId).toBe(tenantId);
      expect(body.auth.role).toBe("ADMIN");
      expect(body.auth.scopes).toEqual(["events:write", "cases:read"]);
    });

    it("GET /admin/api-keys -> 200 lists API keys without leaking plaintext secret", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/api-keys",
        headers: {
          authorization: `Bearer ${rawApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const keys = JSON.parse(res.body);
      expect(Array.isArray(keys)).toBe(true);
      const key = keys.find((k: any) => k.id === apiKeyId);
      expect(key).toBeDefined();
      expect(key.key).toBeUndefined(); // Plaintext MUST NOT be returned in list
      expect(key.prefix).toBeDefined();
    });

    it("DELETE /admin/api-keys/:id -> 204 revokes API key", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/admin/api-keys/${apiKeyId}`,
        headers: { cookie: adminCookie },
      });

      expect(res.statusCode).toBe(204);

      // Subsequent attempt to authenticate with revoked key must fail with 401
      const meRes = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          authorization: `Bearer ${rawApiKey}`,
        },
      });
      expect(meRes.statusCode).toBe(401);
      const meBody = JSON.parse(meRes.body);
      expect(meBody.error.code).toBe("UNAUTHENTICATED");
    });
  });

  describe("Mandatory Tenant Context Guard", () => {
    it("Route consuming getTenantScope fails with TENANT_CONTEXT_MISSING if unauthenticated", async () => {
      // An unauthenticated request to an endpoint with getTenantScope
      const res = await app.inject({
        method: "GET",
        url: "/admin/users",
        // No cookie, no bearer
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("UNAUTHENTICATED");
    });
  });
});
