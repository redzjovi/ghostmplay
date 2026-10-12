import { Injectable } from '@nestjs/common'

/**
 * Fixed-window rate limiter, per process.
 *
 * The one consumer is the Google sign-in route and its callback, capped at 30
 * attempts per IP per 10 minutes. That is not a quota — sign-in is free and the
 * upstream is Google — it is a throttle on the two endpoints that mint sessions,
 * so one network cannot burn the whole budget and lock out everyone behind it.
 *
 * **In-process, which is exactly enough here.** The budget is per IP, so a second
 * process would hand the same IP two budgets rather than the same one twice; the
 * deployment runs a single Passenger instance (docs/DEPLOY-CPANEL.md), so there is
 * one.
 *
 * The window starts at the caller's first attempt and is fixed, not sliding: a
 * burst at the boundary can pass two windows back to back, which for a sign-in
 * throttle is not worth the bookkeeping.
 *
 * Entries are dropped when their window has elapsed, on the next call. That is
 * what keeps the map bounded without a timer: it holds at most one entry per key
 * that was seen inside the current window, and keys are only ever an IP address.
 */
@Injectable()
export class RateLimiterService {
  private readonly windows = new Map<string, { expiresAt: number; count: number }>()

  /**
   * Counts `key` and returns whether the caller is still within budget:
   * `limit` requests per `windowSeconds`.
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const now = Date.now()
    this.evictExpired(now)

    const window = this.windows.get(key)
    if (!window) {
      this.windows.set(key, { expiresAt: now + windowSeconds * 1000, count: 1 })
      return limit >= 1
    }

    window.count += 1
    return window.count <= limit
  }

  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) this.windows.delete(key)
    }
  }
}