import { Injectable, Logger } from '@nestjs/common'
import { RedisService } from './redis.service'

/**
 * Fixed-window rate limiter.
 *
 * Fails open when Redis is unreachable: a limiter outage must never take the site
 * down. Registration is cheap, so allowing traffic beats blocking every signup.
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name)

  constructor(private readonly redis: RedisService) {}

  /**
   * Increments `key` and returns true when the caller is still within budget:
   * `limit` requests per `windowSeconds`.
   */
  async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const client = this.redis.raw
    if (!client) return true
    try {
      const count = await client.incr(key)
      // Only the first INCR sets the window, so this is a fixed window measured
      // from the caller's first request rather than a sliding one.
      if (count === 1) await client.expire(key, windowSeconds)
      return count <= limit
    } catch (err) {
      this.logger.warn(`Rate limit check failed, allowing: ${(err as Error).message}`)
      return true
    }
  }
}
