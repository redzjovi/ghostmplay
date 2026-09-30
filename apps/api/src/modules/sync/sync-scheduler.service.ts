import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { SyncOrchestratorService } from './sync-orchestrator.service'
import { SYNC_KINDS } from './entities'

/**
 * Keeps the database warm without anyone clicking a button.
 *
 * Only "latest" runs on a schedule. It is incremental by construction — it walks
 * the newest page until it meets an item already stored with the same created_at
 * — so its cost is proportional to what is new, not to the size of the history.
 * Full backfills stay admin-triggered precisely because they are not.
 *
 * Every minute is affordable for that reason: on an idle upstream, "latest" is
 * roughly one request that immediately finds itself up to date. A tick that arrives
 * while the previous run is still going is deduplicated by the `sync:<kind>` lock
 * and changes nothing, and sync state is a single upserted row per kind, so the
 * table does not grow with the cadence.
 */
@Injectable()
export class SyncSchedulerService {
  private readonly logger = new Logger(SyncSchedulerService.name)

  constructor(private readonly orchestrator: SyncOrchestratorService) {}

  /**
   * One incremental pass of each kind, in sequence: marketplace, then history.
   *
   * The order is a correctness requirement, not a preference. History derives
   * sold state from the transfer ledger, and both history paths stop at the
   * first transfer they already hold. So if history ran against a transfer whose
   * item row the marketplace scraper had not inserted yet, the join would match
   * nothing, and every later run would break on that same now-known transfer
   * before ever retrying it — leaving the item live forever. Running the
   * marketplace first means the row exists by the time history needs it.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'sync-latest' })
  async runLatest(): Promise<void> {
    for (const kind of SYNC_KINDS) {
      try {
        const { deduped } = await this.orchestrator.enqueue({ kind, mode: 'latest' })
        if (!deduped) this.logger.log(`Cron started incremental ${kind} sync`)
        // Awaited so the next kind cannot start early. This also covers the
        // deduped case: a tick that joined someone else's run waits for that run
        // rather than racing ahead of it.
        await this.orchestrator.settled(kind)
      } catch (err) {
        this.logger.error(`Cron ${kind} sync failed to start: ${(err as Error).message}`)
      }
    }
  }
}
