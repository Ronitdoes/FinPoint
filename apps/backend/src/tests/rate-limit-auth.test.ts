import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app";
import { db, end, tenants, users, createTenant, createUser, eq } from "@repo/db";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../lib/crypto";

describe("Auth Rate Limiting & Lockout Backoff (Step 09)", () => {
  let app: FastifyInstance;
  const runId = Math.random().toString(36).slice(2, 8);
  const testEmail = `rate-limit-${runId}@example.com`;
  const testPassword = "ValidPassword123!";

  beforeAll(async () => {
    // Enable rate limit
    app = await buildApp({ disableRateLimit: false, logger: false });
    await app.ready();

    const tenant = await createTenant(
      { db },
      { name: `RL Test Tenant ${runId}`, slug: `rl-test-tenant-${runId}` },
    );

    const hash = await hashPassword(testPassword);
    await createUser(
      { db },
      {
        tenantId: tenant.id,
        email: testEmail,
        name: "RL User",
        role: "ADMIN",
        passwordHash: hash,
        status: "ACTIVE",
      },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it("permits 5 failed login attempts then returns 429 RATE_LIMITED on the 6th attempt", async () => {
    const wrongPassword = "WrongPassword999!";

    // 5 attempts should return 401 INVALID_CREDENTIALS
    for (let i = 1; i <= 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: testEmail,
          password: wrongPassword,
        },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("INVALID_CREDENTIALS");
    }

    // 6th attempt must be locked out with 429 RATE_LIMITED
    const lockedRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: testEmail,
        password: wrongPassword,
      },
    });

    expect(lockedRes.statusCode).toBe(429);
    const lockedBody = JSON.parse(lockedRes.body);
    expect(lockedBody.error.code).toBe("RATE_LIMITED");

    // Even with the correct password, lockout denies access (prevents timing attacks)
    const correctUnderLockout = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: testEmail,
        password: testPassword,
      },
    });

    expect(correctUnderLockout.statusCode).toBe(429);
    const correctUnderLockoutBody = JSON.parse(correctUnderLockout.body);
    expect(correctUnderLockoutBody.error.code).toBe("RATE_LIMITED");
  });
});
