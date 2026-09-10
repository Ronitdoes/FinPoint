/**
 * Vitest globalSetup for the e2e project (s-32).
 *
 * In-process (default): nothing to boot — each test file builds its own
 * `buildApp` + `InProcessEventBus` against the shared dev Postgres/Redis.
 * Composed profile: when E2E_BASE_URL is set, waits for /health + /ready here
 * so per-file setup stays fast (the single allowed retry point).
 */
import { waitForApiReady } from "./readiness";

export default async function globalSetup(): Promise<void> {
  const baseUrl = process.env.E2E_BASE_URL;
  if (baseUrl) {
    console.log(`[e2e] composed mode: waiting for API at ${baseUrl}`);
    await waitForApiReady({ baseUrl });
    console.log("[e2e] API ready");
  } else {
    console.log("[e2e] in-process mode: per-file harness boots buildApp + InProcessEventBus");
  }
}
