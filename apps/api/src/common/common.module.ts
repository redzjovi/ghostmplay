import { Global, Module } from '@nestjs/common'
import { RateLimiterService } from './rate-limiter.service'
import { LockService } from './lock.service'

/**
 * Shared singletons. Global so feature modules can inject them without every
 * module re-providing them (a second instance would mean a second lock table and
 * a second rate-limit budget, which are exactly the two things that must be one).
 */
@Global()
@Module({
  providers: [RateLimiterService, LockService],
  exports: [RateLimiterService, LockService],
})
export class CommonModule {}