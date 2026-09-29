import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { SyncOrchestratorService } from './sync-orchestrator.service'

/**
 * Keeps the database warm without anyone clicking a button.
 *
 * Only "latest" runs on a schedule. It is incremental by construction — it walks
 * the newest page until it meets an item already stored with the same created_at
 * — so its cost is proportional to what is new, not to the size of the history.
 * Full backfills stay admin-triggered precisely because they are not.
 */
@Injectable()
export class SyncSchedulerService {
  private readonly logger = new Logger(SyncSchedulerService.name)

  constructor(private readonly orchestrator: SyncOrchestratorService) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'sync-latest' })
  async runLatest(): Promise<void> {
    for (const kind of ['marketplace', 'history'] as const) {
      try {
        const { deduped } = await this.orchestrator.enqueue({ kind, mode: 'latest', trigger: 'cron' })
        if (!deduped) this.logger.log(`Cron queued incremental ${kind} sync`)
      } catch (err) {
        this.logger.error(`Cron ${kind} sync failed to queue: ${(err as Error).message}`)
      }
    }
  }
}
