export interface RateLimiterOptions {
  /** Length of the fixed window in milliseconds. */
  windowMs: number;
  /** Maximum number of recorded events allowed per key within a window. */
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Tiny in-memory, per-key fixed-window rate limiter. Intended for guarding
 * low-volume, security-sensitive endpoints (e.g. shared-secret login) within a
 * single process. State lives in a Map and is not shared across instances, so
 * this is a best-effort defense — not a substitute for an edge/WAF limiter.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly opts: RateLimiterOptions) {}

  /**
   * Report whether `key` is currently over its limit without recording a hit.
   */
  check(
    key: string,
    now: number = Date.now(),
  ): { limited: boolean; retryAfterMs: number } {
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      return { limited: false, retryAfterMs: 0 };
    }
    if (bucket.count >= this.opts.max) {
      return { limited: true, retryAfterMs: bucket.resetAt - now };
    }
    return { limited: false, retryAfterMs: 0 };
  }

  /** Record a hit against `key`, starting a fresh window if needed. */
  record(key: string, now: number = Date.now()): void {
    this.prune(now);
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return;
    }
    bucket.count += 1;
  }

  /** Clear any recorded state for `key` (e.g. after a successful login). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Drop expired buckets so the Map can't grow without bound. */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}
