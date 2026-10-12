import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RateLimiterService } from './rate-limiter.service'

/**
 * The limiter's only job is the sign-in throttle: 30 attempts per IP per 10
 * minutes, so one network cannot spend everyone's budget. It is a fixed window
 * measured from the first attempt, and entries are dropped when they expire —
 * that eviction is what keeps the map bounded, and a stale entry that survived it
 * would keep refusing an IP that has long since served its time.
 */
const LIMIT = 3
const WINDOW_SECONDS = 60

describe('RateLimiterService', () => {
  let svc: RateLimiterService

  beforeEach(() => {
    svc = new RateLimiterService()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows up to the limit and refuses the next attempt', async () => {
    for (let i = 1; i <= LIMIT; i++) {
      expect(await svc.consume('ip', LIMIT, WINDOW_SECONDS)).toBe(true)
      void i
    }
    expect(await svc.consume('ip', LIMIT, WINDOW_SECONDS)).toBe(false)
  })

  it('counts down within the window, then starts a new one when it elapses', async () => {
    for (let i = 0; i < LIMIT; i++) await svc.consume('ip', LIMIT, WINDOW_SECONDS)
    expect(await svc.consume('ip', LIMIT, WINDOW_SECONDS)).toBe(false)

    // A millisecond short of the window is still the same window.
    vi.advanceTimersByTime(WINDOW_SECONDS * 1000 - 1)
    expect(await svc.consume('ip', LIMIT, WINDOW_SECONDS)).toBe(false)

    vi.advanceTimersByTime(1)
    expect(await svc.consume('ip', LIMIT, WINDOW_SECONDS)).toBe(true)
  })

  it('counts each key separately, so one IP cannot spend another\'s budget', async () => {
    for (let i = 0; i < LIMIT; i++) await svc.consume('ip:a', LIMIT, WINDOW_SECONDS)
    expect(await svc.consume('ip:a', LIMIT, WINDOW_SECONDS)).toBe(false)
    expect(await svc.consume('ip:b', LIMIT, WINDOW_SECONDS)).toBe(true)
  })

  it('forgets an expired key instead of carrying its count forward', async () => {
    for (let i = 0; i < LIMIT; i++) await svc.consume('ip:a', LIMIT, WINDOW_SECONDS)
    vi.advanceTimersByTime(WINDOW_SECONDS * 1000)

    // The stale entry is dropped on this call, so `ip:a` starts over at one.
    expect(await svc.consume('ip:b', LIMIT, WINDOW_SECONDS)).toBe(true)
    expect(await svc.consume('ip:a', LIMIT, WINDOW_SECONDS)).toBe(true)
  })
})