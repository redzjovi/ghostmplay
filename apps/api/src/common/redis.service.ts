import { Global, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'

/**
 * Owns the single Valkey/Redis connection for the process.
 *
 * Every consumer (rate limiter, sync lock) takes this rather than opening its own
 * client, so there is one socket and one connect/retry story to reason about.
 *
 * Degrades to unavailable when REDIS_URL is unset: the rate limiter then fails
 * open and the sync lock falls back to an in-process mutex. Neither is a
 * correctness problem on a single-container deployment, because there is only
 * one process that could ever contend.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  private readonly client: Redis | null

  constructor() {
    const url = process.env.REDIS_URL
    if (!url) {
      this.logger.warn('REDIS_URL not set — rate limiting and cross-process locking are degraded')
      this.client = null
      return
    }

    this.client = new Redis(url, {
      lazyConnect: true,
      // Queue commands issued while the socket is still coming up, so requests in
      // the first moments after boot are still counted rather than silently
      // bypassing the limit. maxRetriesPerRequest + commandTimeout stop a
      // hard-down Redis from hanging them instead.
      enableOfflineQueue: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 1000,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    })
    this.client.on('ready', () => this.logger.log('Redis connected'))
    this.client.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`))
    void this.client.connect().catch((err) => {
      this.logger.warn(`Redis unavailable, degrading: ${err.message}`)
    })
  }

  get isAvailable(): boolean {
    return this.client !== null
  }

  get raw(): Redis | null {
    return this.client
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => undefined)
  }
}
