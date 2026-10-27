/**
 * Token bucket: `capacity` requests may burst, refilled continuously at
 * `ratePerMinute`. One bucket per virtual key, kept in process memory.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly ratePerMinute: number,
    readonly capacity: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Try to take one token. On failure, `retryAfterMs` says when one will be available. */
  take(now = Date.now()): { ok: boolean; remaining: number; retryAfterMs: number } {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true, remaining: Math.floor(this.tokens), retryAfterMs: 0 };
    }
    const perMs = this.ratePerMinute / 60_000;
    return { ok: false, remaining: 0, retryAfterMs: Math.ceil((1 - this.tokens) / perMs) };
  }

  private refill(now: number) {
    const elapsed = Math.max(0, now - this.last);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.ratePerMinute) / 60_000);
    this.last = now;
  }
}
