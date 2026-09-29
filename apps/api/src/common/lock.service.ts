import { Injectable, Logger } from '@nestjs/common'
import { RedisService } from './redis.service'

export interface Lock {
  release(): Promise<void>
}

/**
 * Cross-process mutex via SET key token NX EX ttl.
 *
 * A TTL is mandatory rather than optional safety: if the process holding the lock
 * is killed mid-sync (which a DomCloud deploy does), the lock must not outlive it.
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
      // single process still serialise.
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
      return {
        release: async () => {
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
   * and its `release` can never run. Without this, a deploy that kills a sync
   * mid-flight leaves the lock behind for its full TTL, and every trigger after it
   * dedupes against a run that no longer exists — sync silently stops until the TTL
   * expires. The token check in `release` is deliberately bypassed because by
   * definition the token is lost.
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
