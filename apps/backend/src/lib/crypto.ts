import { createHash, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { hash, verify, Algorithm } from "@node-rs/argon2";

/**
 * Password Hashing & Verification via argon2id (ADR-012 & Step 09).
 */
export async function hashPassword(password: string): Promise<string> {
  return await hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456, // 19 MiB (OWASP recommendation)
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/**
 * Generates a high-entropy cryptographically secure random session token.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Generates a tenant-scoped machine API key in format: `rrk_<tenantPrefix>_<randomHex>`
 */
export function generateApiKey(tenantId: string): { rawKey: string; prefix: string; keyHash: string } {
  const tenantPrefix = tenantId.replace(/-/g, "").slice(0, 8);
  const randomHex = randomBytes(24).toString("hex");
  const rawKey = `rrk_${tenantPrefix}_${randomHex}`;
  const prefix = `rrk_${tenantPrefix}_${randomHex.slice(0, 4)}...`;
  const keyHash = sha256(rawKey);

  return { rawKey, prefix, keyHash };
}

/**
 * Computes SHA-256 hex digest for lookup indexing of sessions and API keys.
 */
export function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Constant-time string comparison to defend against timing side-channels.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return nodeTimingSafeEqual(bufA, bufB);
}
