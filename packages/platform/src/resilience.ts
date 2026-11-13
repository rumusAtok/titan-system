/** Resilience primitives: timeout, bounded retry, circuit breaker, bulkhead. */

export class TimeoutError extends Error {
  constructor(message = 'operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class CircuitOpenError extends Error {
  constructor(public readonly upstream: string) {
    super(`circuit open for ${upstream}`);
    this.name = 'CircuitOpenError';
  }
}

export class BulkheadFullError extends Error {
  constructor(public readonly upstream: string) {
    super(`too many concurrent calls to ${upstream}`);
    this.name = 'BulkheadFullError';
  }
}

export type CircuitStatus = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call is allowed. */
  resetTimeoutMs?: number;
  now?: () => number;
}

/**
 * Consecutive-failure circuit breaker.
 * closed -> open after `failureThreshold` failures; open -> half_open after
 * `resetTimeoutMs`; a single trial call then closes or re-opens it.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private state: CircuitStatus = 'closed';
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    public readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get status(): CircuitStatus {
    if (this.state === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) return 'half_open';
    return this.state;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const status = this.status;
    if (status === 'open') throw new CircuitOpenError(this.name);
    if (status === 'half_open') {
      if (this.trialInFlight) throw new CircuitOpenError(this.name);
      this.trialInFlight = true;
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      if (status === 'half_open') this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures += 1;
    if (this.state !== 'closed' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }
}

/** Caps concurrent calls to one dependency so it cannot exhaust the caller. */
export class Bulkhead {
  private inFlight = 0;

  constructor(
    public readonly name: string,
    private readonly maxConcurrent: number,
  ) {}

  get active(): number {
    return this.inFlight;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.maxConcurrent) throw new BulkheadFullError(this.name);
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying (e.g. for non-idempotent or permanent failures). */
  retryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Bounded retry with exponential backoff and full jitter. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const base = options.baseDelayMs ?? 100;
  const max = options.maxDelayMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === options.attempts) break;
      if (err instanceof CircuitOpenError || err instanceof BulkheadFullError) break;
      if (options.retryable && !options.retryable(err)) break;
      await sleep(Math.random() * Math.min(max, base * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`operation exceeded ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
