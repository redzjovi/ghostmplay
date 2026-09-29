import { Global, Module } from '@nestjs/common'
import { RedisService } from './redis.service'
import { RateLimiterService } from './rate-limiter.service'
import { LockService } from './lock.service'

/**
 * Shared singletons. Global so feature modules can inject them without every
 * module re-providing them (a second instance would mean a second Redis socket).
 */
@Global()
@Module({
  providers: [RedisService, RateLimiterService, LockService],
  exports: [RedisService, RateLimiterService, LockService],
})
export class CommonModule {}
