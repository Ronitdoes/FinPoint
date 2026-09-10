/**
 * Readiness probes for the e2e suite (s-32 §Requirements 1).
 *
 * Retry (`retry=1` semantics) is allowed ONLY here — infra-readiness waits —
 * never for assertions (step §Reliability).
 */

export interface ReadinessOptions {
  baseUrl: string;
  timeoutMs?: number;
  intervalMs?: number;
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Waits until GET <baseUrl>/health and /ready both return 2xx. */
export async function waitForApiReady(options: ReadinessOptions): Promise<void> {
  const { baseUrl, timeoutMs = 120_000, intervalMs = 1000 } = options;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const [health, ready] = await Promise.all([
      probe(`${baseUrl}/health`),
      probe(`${baseUrl}/ready`),
    ]);
    if (health && ready) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `E2E readiness timed out after ${timeoutMs}ms waiting for ${baseUrl}/health + /ready (attempts=${attempt})`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Scrapes GET <baseUrl>/metrics, returning raw Prometheus text. */
export async function scrapeMetrics(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/metrics`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`GET /metrics failed with status ${res.status}`);
  }
  return await res.text();
}
