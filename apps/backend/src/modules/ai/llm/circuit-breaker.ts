export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export class CircuitBreakerOpenError extends Error {
  readonly code = "CIRCUIT_BREAKER_OPEN";

  constructor(message: string = "LLM circuit breaker is OPEN; routing to fallback") {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number; // default: 5
  cooldownMs?: number; // default: 60000 (60s)
}

export class LlmCircuitBreaker {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private lastFailureTime: number | null = null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60000;
  }

  public getState(): {
    state: CircuitState;
    consecutiveFailures: number;
    lastFailureTime: number | null;
  } {
    this.updateStateIfCooldownElapsed();
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  public isOpen(): boolean {
    this.updateStateIfCooldownElapsed();
    return this.state === "OPEN";
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "CLOSED";
  }

  public recordFailure(): void {
    this.consecutiveFailures += 1;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }

  public reset(): void {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    this.lastFailureTime = null;
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.updateStateIfCooldownElapsed();

    if (this.state === "OPEN") {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  private updateStateIfCooldownElapsed(): void {
    if (this.state === "OPEN" && this.lastFailureTime !== null) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cooldownMs) {
        this.state = "HALF_OPEN";
      }
    }
  }
}

/**
 * Singleton circuit breaker instance for the backend process.
 */
export const defaultCircuitBreaker = new LlmCircuitBreaker();
