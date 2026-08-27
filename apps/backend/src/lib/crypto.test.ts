import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  generateApiKey,
  sha256,
  constantTimeEquals,
} from "./crypto";

describe("Backend Crypto Utilities", () => {
  describe("Password Hashing & Verification (argon2id)", () => {
    it("hashes password and verifies successfully with correct password", async () => {
      const password = "SuperSecretPassword123!@#";
      const hash = await hashPassword(password);

      expect(hash).toContain("$argon2id$");
      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it("rejects wrong password with argon2id hash", async () => {
      const password = "CorrectPassword123!";
      const hash = await hashPassword(password);

      const isValid = await verifyPassword("WrongPassword456!", hash);
      expect(isValid).toBe(false);
    });

    it("returns false gracefully on malformed hash", async () => {
      const isValid = await verifyPassword("somePassword", "invalid_malformed_hash");
      expect(isValid).toBe(false);
    });
  });

  describe("Session Token & API Key generation", () => {
    it("generates unique 64-character hex session tokens", () => {
      const token1 = generateSessionToken();
      const token2 = generateSessionToken();

      expect(token1).toHaveLength(64);
      expect(token2).toHaveLength(64);
      expect(token1).not.toEqual(token2);
    });

    it("generates tenant-scoped API key in format rrk_<tenant>_<random>", () => {
      const tenantId = "123e4567-e89b-12d3-a456-426614174000";
      const { rawKey, prefix, keyHash } = generateApiKey(tenantId);

      expect(rawKey).toMatch(/^rrk_123e4567_[0-9a-f]{48}$/);
      expect(prefix).toMatch(/^rrk_123e4567_[0-9a-f]{4}\.\.\.$/);
      expect(keyHash).toBe(sha256(rawKey));
    });
  });

  describe("SHA-256 & Constant-time equality", () => {
    it("computes deterministic SHA-256 hex digest", () => {
      const text = "hello-world-auth";
      const digest1 = sha256(text);
      const digest2 = sha256(text);

      expect(digest1).toHaveLength(64);
      expect(digest1).toBe(digest2);
    });

    it("constantTimeEquals correctly compares equal and non-equal strings", () => {
      expect(constantTimeEquals("secret-token-12345", "secret-token-12345")).toBe(true);
      expect(constantTimeEquals("secret-token-12345", "secret-token-54321")).toBe(false);
      expect(constantTimeEquals("short", "longer-string")).toBe(false);
    });
  });
});
