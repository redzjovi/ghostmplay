import { ConflictException, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { IsNull, Not, Repository, type QueryDeepPartialEntity } from 'typeorm'
import { SyncStateEntity, SYNC_KINDS, type SyncKind, type SyncMode, type SyncStatus } from './entities'
import { LockService, type Lock } from '../../common/lock.service'
import { SyncService } from '../marketplace/sync.service'
import { HistorySyncService } from '../marketplace/history-sync.service'
import { MarketplaceService } from '../marketplace/marketplace.service'
import { HistoryService } from '../marketplace/history.service'
import { describeError, isTransientError } from './transient'

/**
 * The TTL on a lock is a backstop for a process that dies, not a budget for a
 * run's duration. LockService renews it while the lock is held, so a backfill may
 * take as long as the upstream makes it take without a second scrape starting
 * underneath it. It is sized to comfortably outlive a full history backfill, so
 * that even if renewal were ever broken the common case still finishes in time.
 */
const LOCK_TTL_SECONDS = 7200

/** Transient-failure budget. Kept small: a real outage should fail visibly, not hang. */
const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 2000

export interface EnqueueOptions {
  kind: SyncKind
  mode: SyncMode
  itemName?: string
}

export interface EnqueueResult {
  /** True when a run of this kind was already in flight and this call joined it. */
  deduped: boolean
  kind: SyncKind
  mode: SyncMode
  runningSince: string | null
}

/** Per-kind row counts, so the caller can report what actually disappeared. */
export type ClearResult = {
  kind: SyncKind
  deleted: { items: number; details: number } | { transfers: number }
}

export interface SyncKindStatus {
  kind: SyncKind
  running: boolean
  runningSince: string | null
  mode: SyncMode | null
  lastStatus: SyncStatus | null
  lastFinishedAt: string | null
  /** `synced` lifted out of `lastStats`, since every scraper reports it. */
  lastSynced: number | null
  /** The raw blob, for kind-specific extras such as history's enriched/claimed. */
  lastStats: Record<string, number> | null
  lastError: string | null
}

export interface SyncStatusSnapshot {
  marketplace: SyncKindStatus
  history: SyncKindStatus
}

/**
 * Runs scraper work in the background, one run per kind at a time.
 *
 * Why this exists: sync used to be a blocking IPC call that paginated the upstream
 * API to exhaustion while the caller waited. In a shared web container that is a
 * liability — it holds a request open, it is unbounded, and a deploy
 * (`compose down`) kills it mid-flight. Now a request acquires a lock and returns,
 * and the UI polls one row per kind for progress.
 *
 * Dedupe is the lock, not a table lookup. The lock key is `sync:<kind>`, so two
 * concurrent triggers of the same kind contend for the same key whether they
 * arrive at this process or at another one; the in-process `inflight` set then
 * covers the window before the lock is visible, and the case where a long run
 * outlives its TTL. Keying on a job id, as an earlier version did, meant the lock
 * never actually contended and the table query was doing all the work.
 */
@Injectable()
export class SyncOrchestratorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncOrchestratorService.name)
  /**
   * Kind -> the run currently holding it. The key set doubles as the in-process
   * dedupe check (`has`), and the value lets a caller await a run that has
   * already started, which is what makes sequencing the kinds possible.
   */
  private readonly inflight = new Map<SyncKind, Promise<void>>()

  constructor(
    @InjectRepository(SyncStateEntity)
    private readonly stateRepo: Repository<SyncStateEntity>,
    private readonly lock: LockService,
    private readonly marketplaceSync: SyncService,
    private readonly historySync: HistorySyncService,
    // Only for clear(): each scraper owns the table it writes, so each service
    // deletes its own rather than the orchestrator reaching into both repos.
    private readonly marketplace: MarketplaceService,
    private readonly history: HistoryService
  ) {}

  /**
   * Recovers from a process that died mid-run.
   *
   * A run left with `running_since` set cannot still be running: the process that
   * owned it has either died or been redeployed. Its Redis lock is orphaned in the
   * same way, and is the more dangerous of the two — it outlives the row, so
   * without releasing it every later trigger dedupes against a run that no longer
   * exists and sync silently stops until the TTL runs out.
   */
  async onApplicationBootstrap(): Promise<void> {
    const stranded = await this.stateRepo.find({
      where: SYNC_KINDS.map((kind) => ({ kind, runningSince: Not(IsNull()) })),
    })

    if (stranded.length > 0) {
      this.logger.warn(`Marked ${stranded.length} interrupted sync(s) from a previous run`)
      await this.stateRepo.update(
        { runningSince: Not(IsNull()) },
        {
          runningSince: null,
          lastStatus: 'interrupted',
          lastFinishedAt: new Date(),
          lastError: 'Interrupted by restart',
        } as QueryDeepPartialEntity<SyncStateEntity>
      )
    }

    // Released for every kind, not just the stranded ones: a process killed between
    // taking the lock and committing the row would leave the lock with no row to
    // match it.
    for (const kind of SYNC_KINDS) {
      await this.lock.forceRelease(`sync:${kind}`)
    }
  }

  /**
   * Claims the lock for this kind and starts the scrape in the background.
   *
   * Returns immediately. If a run of the same kind is already going — in this
   * process or another — that run is joined rather than duplicated, because a
   * double-clicked "Sync full" must not launch a second unbounded scrape of the
   * same API.
   */
  async enqueue(opts: EnqueueOptions): Promise<EnqueueResult> {
    const { kind, mode } = opts

    if (this.inflight.has(kind)) {
      this.logger.log(`Joining in-flight ${kind} sync`)
      return { deduped: true, kind, mode, runningSince: await this.runningSinceOf(kind) }
    }

    const lock = await this.lock.acquire(`sync:${kind}`, LOCK_TTL_SECONDS)
    if (!lock) {
      this.logger.log(`Lock for ${kind} held elsewhere; joining that run`)
      return { deduped: true, kind, mode, runningSince: await this.runningSinceOf(kind) }
    }

    const startedAt = new Date()
    // Registered before any await, exactly where `inflight.add` used to sit, so
    // the window in which a same-process trigger is deduped is unchanged. The
    // deferred is resolved by the run itself; capturing run()'s promise directly
    // would require moving the state upsert into run(), which the specs stub out.
    let resolveDone!: () => void
    const settled = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    this.inflight.set(kind, settled)

    // Only the in-flight columns are written, so the previous run's finished_at and
    // stats stay readable while this one is under way.
    await this.stateRepo.upsert(
      { kind, mode, runningSince: startedAt, lastStartedAt: startedAt, lastStatus: 'running' },
      { conflictPaths: ['kind'] }
    )

    // Deliberately not awaited: the HTTP response returns as soon as the lock is
    // held, and the work continues on the event loop. `settled()` is the handle
    // for callers that do need to wait.
    void this.run(opts, lock).finally(resolveDone)

    return { deduped: false, kind, mode, runningSince: startedAt.toISOString() }
  }

  /**
   * Resolves once the in-flight run of `kind` finishes; null if there is none.
   *
   * Safe to await when the run was deduped into someone else's — that is the
   * point. run() never rejects (it catches into finish()), so this cannot throw,
   * and it is bounded: the HTTP client times out and withRetry caps the attempts.
   */
  settled(kind: SyncKind): Promise<void> | null {
    return this.inflight.get(kind) ?? null
  }

  /** Executes the scrape and always leaves the row in a truthful terminal state. */
  async run(opts: EnqueueOptions, lock: Lock): Promise<void> {
    const { kind, mode } = opts
    try {
      this.logger.log(`Running sync kind=${kind} mode=${mode}`)
      const stats = await this.execute(opts)
      await this.finish(kind, 'done', stats, null)
      this.logger.log(`Sync ${kind}/${mode} done: ${JSON.stringify(stats)}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.error(`Sync ${kind}/${mode} failed: ${message}`)
      await this.finish(kind, 'failed', null, message)
    } finally {
      await lock.release().catch(() => undefined)
      this.inflight.delete(kind)
    }
  }

  /**
   * Deletes everything one kind of scraper owns. Irreversible, admin-only, and
   * never performed while that kind is being scraped.
   *
   * The lock does double duty as the "is anything running?" test. Checking
   * `inflight` covers this process; failing to acquire `sync:<kind>` covers the
   * rest, including another process holding a lease. Either way the answer is a
   * conflict rather than a delete racing an in-flight insert.
   */
  async clear(kind: SyncKind): Promise<ClearResult> {
    if (this.inflight.has(kind)) {
      throw new ConflictException(`A ${kind} sync is in progress`)
    }

    const lock = await this.lock.acquire(`sync:${kind}`, LOCK_TTL_SECONDS)
    if (!lock) {
      throw new ConflictException(`A ${kind} sync is in progress elsewhere`)
    }

    try {
      const deleted = kind === 'marketplace' ? await this.marketplace.clearAll() : await this.history.clearAll()
      // The stored state now describes a table that no longer exists, so it is
      // reset rather than left to report a success over an empty result. `kind` and
      // `mode` are kept, and the row reads as "never run" until the next scrape.
      await this.stateRepo.update({ kind }, {
        runningSince: null,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastStatus: null,
        lastStats: null,
        lastError: null,
      } as QueryDeepPartialEntity<SyncStateEntity>)
      this.logger.warn(`Cleared all ${kind} data: ${JSON.stringify(deleted)}`)
      return { kind, deleted }
    } finally {
      await lock.release().catch(() => undefined)
    }
  }

  private async execute(opts: EnqueueOptions): Promise<Record<string, unknown>> {
    const { kind, mode, itemName } = opts
    // No page cap. Both scrapers walk to the upstream's natural end — an empty
    // page — so a backfill covers everything the API holds. What keeps a long run
    // from overlapping with the next one is the lock, which renews itself.
    // Retried because a DNS blip or 5xx from the upstream should not lose the
    // whole run. Re-running is safe: both scrapers upsert by a stable key
    // (item id, tx hash), so a retry is idempotent, just slower.
    return this.withRetry(`sync ${kind}/${mode}`, async () => {
      if (kind === 'marketplace') {
        const res = await this.marketplaceSync.refresh({ itemName, mode: mode === 'all' ? 'all' : 'latest' })
        return { ...res, mode }
      }

      const res =
        mode === 'full'
          ? await this.historySync.backfill()
          : await this.historySync.refreshLatest()
      return { ...res, mode }
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
    kind: SyncKind,
    status: Exclude<SyncStatus, 'running'>,
    stats: Record<string, unknown> | null,
    error: string | null
  ): Promise<void> {
    // Cast needed because TypeORM's jsonb partial type does not admit a plain
    // Record<string, unknown>, which is exactly what the scrapers return.
    await this.stateRepo.upsert(
      {
        kind,
        runningSince: null,
        lastFinishedAt: new Date(),
        lastStatus: status,
        lastStats: stats,
        lastError: error,
      } as QueryDeepPartialEntity<SyncStateEntity>,
      { conflictPaths: ['kind'] }
    )
  }

  /**
   * Everything the UI needs, keyed by kind.
   *
   * Per kind matters: a single "most recent completed run" makes the marketplace
   * page display a history run's item count as though it were the marketplace's.
   */
  async status(): Promise<SyncStatusSnapshot> {
    const rows = await this.stateRepo.find({ where: SYNC_KINDS.map((kind) => ({ kind })) })
    const byKind = new Map(rows.map((row) => [row.kind, row]))

    const forKind = (kind: SyncKind): SyncKindStatus => {
      const row = byKind.get(kind)
      const running = row?.runningSince != null
      const synced = row?.lastStats?.synced
      return {
        kind,
        running,
        runningSince: row?.runningSince ? row.runningSince.toISOString() : null,
        mode: row?.mode ?? null,
        lastStatus: row?.lastStatus ?? null,
        lastFinishedAt: row?.lastFinishedAt ? row.lastFinishedAt.toISOString() : null,
        lastSynced: typeof synced === 'number' ? synced : null,
        // The scrapers only ever put numbers in here; typed as such so views can
        // read kind-specific extras without casting.
        lastStats: (row?.lastStats as Record<string, number> | null) ?? null,
        lastError: row?.lastError ?? null,
      }
    }

    return { marketplace: forKind('marketplace'), history: forKind('history') }
  }

  /** Best-effort read for the deduped enqueue response; never throws. */
  private async runningSinceOf(kind: SyncKind): Promise<string | null> {
    try {
      const row = await this.stateRepo.findOne({ where: { kind } })
      return row?.runningSince ? row.runningSince.toISOString() : null
    } catch {
      return null
    }
  }
}
