import { Injectable, Logger } from '@nestjs/common'
import { RedisService } from './redis.service'

export interface Lock {
  release(): Promise<void>
}

/**
 * How often a held lock's TTL is pushed forward. Any value comfortably under the
 * TTL works; 60s against a 2h lease is 120 chances to renew, so a single missed
 * beat is harmless and the timer is cheap enough to ignore.
 */
const RENEW_EVERY_MS = 60_000

/**
 * Cross-process mutex via SET key token NX EX ttl.
 *
 * The TTL is a backstop, not the lease. A backfill is a long unbounded scrape, so
 * a fixed TTL would expire mid-run and let a second scrape start against the same
 * upstream; the timer started in `acquire` therefore renews the lease for as long
 * as the lock is held. Renewal lives here rather than in the caller so it tracks
 * the lock's real lifetime by construction: it begins when the lock is granted
 * and stops in `release`, and a caller that forgets to release loses the lease the
 * same way it would before.
 *
 * `release` only deletes the key when the token still matches, so a slow holder
 * that blew past its TTL cannot delete a successor's lock.
 *
 * Without Redis the lock is a no-op and always granted, which is correct for the
 * single-container deployment this is built for.
 */
@Injectable()
export class LockService {
  private readonly logger = new Logger(LockService.name)
  private readonly local = new Set<string>()

  constructor(private readonly redis: RedisService) {}

  async acquire(key: string, ttlSeconds: number): Promise<Lock | null> {
    const client = this.redis.raw

    if (!client) {
      // No Redis: rely on the in-process guard so overlapping calls within this
      // single process still serialise. Nothing to renew, since there is no TTL.
      if (this.local.has(key)) return null
      this.local.add(key)
      return { release: async () => void this.local.delete(key) }
    }

    const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
    try {
      const ok = await client.set(`lock:${key}`, token, 'EX', ttlSeconds, 'NX')
      if (ok !== 'OK') {
        this.logger.debug(`Lock ${key} is held elsewhere`)
        return null
      }

      let timer: ReturnType<typeof setInterval> | null = null

      const stopRenewal = () => {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
      }

      /**
       * Extends the lease, but only while this holder still owns the key. A blind
       * SET here would be actively harmful: a run that overran its TTL and was
       * legitimately superseded would resurrect itself over the successor's lock
       * and the two would run concurrently. EXPIRE is guarded by the same token
       * check `release` uses, so losing the lock ends the renewal instead.
       */
      const renew = async () => {
        try {
          const extended = await client.eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`,
            1,
            `lock:${key}`,
            token,
            String(ttlSeconds)
          )
          if (!extended) {
            this.logger.warn(`Lock ${key} was taken by another holder; no longer renewing`)
            stopRenewal()
          }
        } catch (err) {
          // A failed renewal means the lease is running down. Not fatal — the TTL
          // is still ahead of us — but worth knowing, so leave the timer going and
          // try again on the next beat.
          this.logger.warn(`Could not renew lock ${key}: ${(err as Error).message}`)
        }
      }

      timer = setInterval(() => void renew(), RENEW_EVERY_MS)
      // Never let a renewal timer hold the process open on its own.
      timer.unref?.()

      return {
        release: async () => {
          // Stop before deleting: a renewal landing after this would find no key
          // and log a spurious "taken by another holder" warning.
          stopRenewal()
          try {
            // Only delete if we still own it.
            await client.eval(
              `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
              1,
              `lock:${key}`,
              token
            )
          } catch (err) {
            this.logger.warn(`Failed to release lock ${key}: ${(err as Error).message}`)
          }
        },
      }
    } catch (err) {
      this.logger.warn(`Lock ${key} unavailable, allowing: ${(err as Error).message}`)
      this.local.add(key)
      return { release: async () => void this.local.delete(key) }
    }
  }

  /**
   * Deletes a lock regardless of who holds it.
   *
   * Only safe at boot, and only because this app runs as a single process: a lock
   * still present when the process starts was set by a process that is now gone,
   * and its `release` — and its renewal timer — died with it. Without this, a
   * deploy that kills a sync mid-flight leaves the lock behind, and every trigger
   * after it dedupes against a run that no longer exists — sync silently stops
   * until the TTL runs out. The token check in `release` is deliberately bypassed
   * because by definition the token is lost.
   *
   * The orphaned key expires on its own too, one TTL after the last renewal, so
   * this only converts a two-hour stall into an immediate one.
   */
  async forceRelease(key: string): Promise<boolean> {
    this.local.delete(key)
    const client = this.redis.raw
    if (!client) return false
    try {
      const deleted = await client.del(`lock:${key}`)
      if (deleted) this.logger.warn(`Released orphaned lock ${key} from a previous process`)
      return deleted > 0
    } catch (err) {
      this.logger.warn(`Could not release orphaned lock ${key}: ${(err as Error).message}`)
      return false
    }
  }
}
