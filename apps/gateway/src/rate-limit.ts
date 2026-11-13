export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Token-bucket rate limiter keyed by caller.
 *
 * State is per gateway process. With several gateway replicas each replica
 * enforces the limit independently, so the effective limit is
 * `replicas x limit`; a shared store or ingress-level limiting is the
 * production answer (see docs/security/security-architecture.md).
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly refillPerMs: number;

  constructor(
    private readonly perMinute: number,
    private readonly burst: number = Math.max(10, Math.ceil(perMinute / 4)),
    private readonly now: () => number = Date.now,
  ) {
    this.refillPerMs = perMinute / 60_000;
  }

  take(key: string): RateDecision {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, updatedAt: t };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(this.burst, bucket.tokens + (t - bucket.updatedAt) * this.refillPerMs);
      bucket.updatedAt = t;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1000));
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  /** Drops buckets that have been full (idle) long enough to be irrelevant. */
  sweep(): void {
    const t = this.now();
    const idleMs = (this.burst / this.refillPerMs) * 2;
    for (const [key, bucket] of this.buckets) {
      if (t - bucket.updatedAt > idleMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
