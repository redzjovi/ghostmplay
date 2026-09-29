import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository, type QueryDeepPartialEntity } from 'typeorm'
import { SyncJobEntity, type SyncJobKind, type SyncJobStatus, type SyncJobTrigger } from './entities'
import { LockService } from '../../common/lock.service'
import { SyncService } from '../marketplace/sync.service'
import { HistorySyncService } from '../marketplace/history-sync.service'
import { describeError, isTransientError } from './transient'

/** A backfill is a long unbounded scrape; the TTL must outlive a normal run. */
const LOCK_TTL_SECONDS = 3600

/** Transient-failure budget. Kept small: a real outage should fail visibly, not hang. */
const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 2000

export interface EnqueueOptions {
  kind: SyncJobKind
  mode: 'all' | 'latest' | 'full'
  trigger: SyncJobTrigger
  accountId?: number | null
  itemName?: string | null
  maxPages?: number
}

export interface SyncStatusSnapshot {
  running: SyncJobEntity | null
  queued: SyncJobEntity | null
  lastCompleted: { kind: SyncJobKind; finishedAt: Date; stats: Record<string, unknown> | null } | null
  recent: SyncJobEntity[]
}

/**
 * Queues scraper work and runs it in the background.
 *
 * Why this exists: sync used to be a blocking IPC call that paginated the
 * upstream API to exhaustion while the caller waited. In a shared web container
 * that is a liability — it holds a request open, it is unbounded, and a deploy
 * (`compose down`) kills it mid-flight. Now an admin enqueues a row, the request
 * returns immediately, and the UI polls the row for progress.
 */
@Injectable()
export class SyncOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncOrchestratorService.name)
  private readonly inflight = new Set<number>()

  constructor(
    @InjectRepository(SyncJobEntity)
    private readonly jobRepo: Repository<SyncJobEntity>,
    private readonly lock: LockService,
    private readonly marketplaceSync: SyncService,
    private readonly historySync: HistorySyncService
  ) {}

  /**
   * A job left "running" cannot still be running: the process that owned it has
   * either died or been redeployed. Mark those interrupted on boot so the UI does
   * not show a spinner forever.
   */
  async onApplicationBootstrap(): Promise<void> {
    const stranded = await this.jobRepo.find({ where: { status: In(['running', 'queued']) } })
    if (stranded.length === 0) return
    this.logger.warn(`Marking ${stranded.length} stranded sync job(s) as interrupted`)
    await this.jobRepo.update(
      { id: In(stranded.map((j) => j.id)) },
      { status: 'interrupted', finishedAt: new Date(), error: 'Interrupted by restart' }
    )
  }

  /**
   * Creates a job and starts it in the background. If one of the same kind is
   * already queued or running, that one is returned instead — a double-clicked
   * "Sync full" must not queue a second unbounded scrape of the same API.
   */
  async enqueue(opts: EnqueueOptions): Promise<{ job: SyncJobEntity; deduped: boolean }> {
    const existing = await this.jobRepo.findOne({
      where: { kind: opts.kind, status: In(['queued', 'running']) },
      order: { id: 'DESC' },
    })
    if (existing) {
      this.logger.log(`Reusing in-flight ${opts.kind} job #${existing.id}`)
      return { job: existing, deduped: true }
    }

    const job = await this.jobRepo.save(
      this.jobRepo.create({
        kind: opts.kind,
        status: 'queued',
        trigger: opts.trigger,
        accountId: opts.accountId ?? null,
        mode: opts.mode,
        itemName: opts.itemName ?? null,
        maxPages: opts.maxPages ?? 200,
        stats: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      })
    )

    // Deliberately not awaited: the HTTP response returns as soon as the row
    // exists, and the work continues on the event loop.
    void this.run(job.id)
    return { job, deduped: false }
  }

  async run(jobId: number): Promise<void> {
    if (this.inflight.has(jobId)) return
    this.inflight.add(jobId)

    const lock = await this.lock.acquire(`sync:${jobId}`, LOCK_TTL_SECONDS)
    if (!lock) {
      await this.finish(jobId, 'failed', null, 'Could not acquire sync lock')
      this.inflight.delete(jobId)
      return
    }

    try {
      const job = await this.jobRepo.findOne({ where: { id: jobId } })
      if (!job) return
      if (job.status === 'interrupted' || job.status === 'done') return

      await this.jobRepo.update({ id: jobId }, { status: 'running', startedAt: new Date() })
      this.logger.log(`Running sync job #${jobId} kind=${job.kind} mode=${job.mode}`)

      const stats = await this.execute(job)
      await this.finish(jobId, 'done', stats, null)
      this.logger.log(`Sync job #${jobId} done: ${JSON.stringify(stats)}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(`Sync job #${jobId} failed: ${message}`)
      await this.finish(jobId, 'failed', null, message)
    } finally {
      await lock.release().catch(() => undefined)
      this.inflight.delete(jobId)
    }
  }

  private async execute(job: SyncJobEntity): Promise<Record<string, unknown>> {
    // Retried because a DNS blip or 5xx from the upstream should not lose the
    // whole job. Re-running is safe: both scrapers upsert by a stable key
    // (item id, tx hash), so a retry is idempotent, just slower.
    return this.withRetry(`sync #${job.id} ${job.kind}/${job.mode}`, async () => {
      if (job.kind === 'marketplace') {
        const res = await this.marketplaceSync.refresh({
          itemName: job.itemName ?? undefined,
          maxPages: job.mode === 'all' ? job.maxPages : undefined,
          mode: job.mode === 'all' ? 'all' : 'latest',
        })
        return { ...res, mode: job.mode }
      }

      const res =
        job.mode === 'full'
          ? await this.historySync.backfill({ maxPages: job.maxPages })
          : await this.historySync.refreshLatest()
      return { ...res, mode: job.mode }
    })
  }

  /** Runs `fn`, retrying only transient network/upstream failures with backoff. */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastError = err
        if (!isTransientError(err) || attempt === MAX_ATTEMPTS) throw err
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
        this.logger.warn(
          `${label} attempt ${attempt}/${MAX_ATTEMPTS} failed (${describeError(err)}); retrying in ${delay}ms`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    throw lastError
  }

  private async finish(
    jobId: number,
    status: SyncJobStatus,
    stats: Record<string, unknown> | null,
    error: string | null
  ): Promise<void> {
    // Cast needed because TypeORM's jsonb partial type does not admit a plain
    // Record<string, unknown>, which is exactly what the scrapers return.
    await this.jobRepo.update(
      { id: jobId },
      { status, stats, error, finishedAt: new Date() } as QueryDeepPartialEntity<SyncJobEntity>
    )
  }

  async getJob(id: number): Promise<SyncJobEntity | null> {
    return this.jobRepo.findOne({ where: { id } })
  }

  async recentJobs(limit = 10): Promise<SyncJobEntity[]> {
    return this.jobRepo.find({ order: { id: 'DESC' }, take: Math.min(50, Math.max(1, limit)) })
  }

  /** Everything the UI needs to render sync state in one request. */
  async status(): Promise<SyncStatusSnapshot> {
    const [running, queued, lastDone, recent] = await Promise.all([
      this.jobRepo.findOne({ where: { status: 'running' }, order: { id: 'DESC' } }),
      this.jobRepo.findOne({ where: { status: 'queued' }, order: { id: 'DESC' } }),
      this.jobRepo.findOne({ where: { status: 'done' }, order: { finishedAt: 'DESC', id: 'DESC' } }),
      this.recentJobs(5),
    ])

    return {
      running,
      queued,
      lastCompleted: lastDone?.finishedAt
        ? { kind: lastDone.kind, finishedAt: lastDone.finishedAt, stats: lastDone.stats }
        : null,
      recent,
    }
  }
}
