import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncOrchestratorService } from './sync-orchestrator.service'
import type { SyncStateEntity } from './entities'

/**
 * The orchestrator exists to make an unbounded third-party scrape safe on a small
 * shared box: one run at a time per kind, deduplicated, never held open over an
 * HTTP request, and always left in a truthful terminal state.
 *
 * The store here is a two-row map keyed by kind, mirroring the `sync_state` table
 * that replaced `sync_jobs`. `upsert` merges a partial row into the map, so tests
 * assert on final row state rather than on the sequence of writes.
 */
type Row = Partial<SyncStateEntity> & { kind: string }
type Upsert = { method: string; args: unknown[] }

const ALL_KINDS = ['marketplace', 'history'] as const

function makeState(over: Partial<SyncStateEntity> = {}): SyncStateEntity {
  return {
    kind: 'marketplace',
    mode: 'latest',
    runningSince: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastStats: null,
    lastError: null,
    ...over,
  } as SyncStateEntity
}

function createOrchestrator(opts: { lockGranted?: boolean; throwOnRun?: boolean } = {}) {
  const calls: Upsert[] = []
  const rows = new Map<string, SyncStateEntity>()

  const stateRepo = {
    findOne: vi.fn(async (cond: { where?: Row }) => {
      const kind = cond?.where?.kind
      return (kind ? rows.get(kind) : null) ?? null
    }),
    // The boot query is `find({ where: [{kind, runningSince: Not(IsNull())}, ...] })`,
    // i.e. OR across clauses, so each clause admits a row.
    find: vi.fn(async (cond: { where?: Row[] }) => {
      const clauses = cond?.where ?? []
      if (clauses.length === 0) return [...rows.values()]
      return [...rows.values()].filter((row) =>
        clauses.some((w) => {
          const spec = w as { runningSince?: { type?: string } }
          if (spec.runningSince && row.runningSince == null) return false
          return true
        })
      )
    }),
    upsert: vi.fn(async (patch: Row) => {
      calls.push({ method: 'upsert', args: [patch] })
      rows.set(patch.kind, { ...makeState(), ...rows.get(patch.kind), ...patch })
      return { identifiers: [], generatedMaps: [], raw: [] }
    }),
    update: vi.fn(async (_cond: unknown, patch: Row) => {
      calls.push({ method: 'update', args: [_cond, patch] })
      let affected = 0
      for (const [kind, row] of rows) {
        if (row.runningSince != null) {
          rows.set(kind, { ...row, ...patch })
          affected++
        }
      }
      return { affected, raw: [], generatedMaps: [] }
    }),
  }

  const lock = {
    acquire: vi.fn(async (_key: string, _ttlSeconds: number) =>
      opts.lockGranted === false ? null : { release: vi.fn(async () => undefined) }
    ),
    forceRelease: vi.fn(async (_key: string) => false),
  }

  const marketplaceSync = {
    refresh: vi.fn(async () => {
      if (opts.throwOnRun) throw new Error('upstream 500')
      return { synced: 7 }
    }),
  }
  const historySync = {
    backfill: vi.fn(async () => ({ synced: 3, total: 9, enriched: 1, claimed: 2, skipped: 0 })),
    refreshLatest: vi.fn(async () => ({ synced: 2, total: 5, enriched: 0, claimed: 1, skipped: 0 })),
  }

  const svc = new SyncOrchestratorService(
    stateRepo as never,
    lock as never,
    marketplaceSync as never,
    historySync as never
  )

  // enqueue() starts work with a fire-and-forget `void this.run(...)` holding the
  // lock it just took, which would race every explicit run() below. Swap in a spy
  // that releases immediately, and drive real execution through runReal.
  const runReal = svc.run.bind(svc)
  const runSpy = vi.fn(async (_o: unknown, held: { release(): Promise<void> }) => {
    await held.release()
  })
  svc.run = runSpy as unknown as typeof svc.run

  const lastPatch = (): Record<string, unknown> =>
    (calls.at(-1)?.args.at(-1) as Record<string, unknown>) ?? {}

  return { svc, runReal, runSpy, stateRepo, lock, marketplaceSync, historySync, rows, calls, lastPatch }
}

describe('SyncOrchestratorService', () => {
  let h: ReturnType<typeof createOrchestrator>

  beforeEach(() => {
    h = createOrchestrator()
  })

  describe('enqueue', () => {
    it('marks the kind running and starts the work in the background', async () => {
      const res = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      expect(res.deduped).toBe(false)
      expect(res.kind).toBe('marketplace')
      expect(res.mode).toBe('latest')
      expect(h.rows.get('marketplace')?.runningSince).toBeInstanceOf(Date)
      expect(h.rows.get('marketplace')?.lastStatus).toBe('running')
      // Started without the caller awaiting it.
      expect(h.runSpy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'marketplace', mode: 'latest' }),
        expect.anything()
      )
    })

    it('deduplicates a second trigger of the same kind instead of scraping twice', async () => {
      const first = await h.svc.enqueue({ kind: 'marketplace', mode: 'all' })
      const second = await h.svc.enqueue({ kind: 'marketplace', mode: 'all' })
      expect(second.deduped).toBe(true)
      expect(first.deduped).toBe(false)
      // Only one run was ever started.
      expect(h.runSpy).toHaveBeenCalledTimes(1)
    })

    it('does not dedupe across kinds', async () => {
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      const other = await h.svc.enqueue({ kind: 'history', mode: 'latest' })
      expect(other.deduped).toBe(false)
      expect(h.runSpy).toHaveBeenCalledTimes(2)
    })

    it('treats a lock held elsewhere as deduped, and never runs unguarded', async () => {
      const h2 = createOrchestrator({ lockGranted: false })
      const res = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      expect(res.deduped).toBe(true)
      // The crucial part: the scraper must not run without the lock.
      expect(h2.marketplaceSync.refresh).not.toHaveBeenCalled()
      expect(h2.runSpy).not.toHaveBeenCalled()
    })

    it('carries maxPages through so a backfill stays bounded', async () => {
      const opts = { kind: 'marketplace', mode: 'all', maxPages: 5 } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ mode: 'all', maxPages: 5 }))
    })
  })

  describe('lock key', () => {
    // The bug this guards: the lock used to be keyed `sync:<jobId>`, where the id
    // is unique per request. Two concurrent triggers therefore never contended for
    // the same key, and dedupe was carried entirely by a table lookup.
    it('keys the lock by kind, so two triggers of the same kind contend', async () => {
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      expect(h.lock.acquire).toHaveBeenCalledWith('sync:marketplace', expect.any(Number))
    })

    it('uses a distinct key per kind so the two do not block each other', async () => {
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      await h.svc.enqueue({ kind: 'history', mode: 'latest' })
      const keys = h.lock.acquire.mock.calls.map((c) => c[0])
      expect(keys).toEqual(['sync:marketplace', 'sync:history'])
      expect(new Set(keys).size).toBe(2)
    })

    it('gives a backfill a TTL long enough to outlive it', async () => {
      await h.svc.enqueue({ kind: 'history', mode: 'full' })
      const ttl = h.lock.acquire.mock.calls[0][1] as number
      // A 200-page backfill is minutes, not seconds; a 1-hour TTL could expire
      // mid-run and let a second scrape start.
      expect(ttl).toBeGreaterThanOrEqual(3600)
    })
  })

  describe('run', () => {
    it('records the scraper stats and clears the running marker', async () => {
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })

      const row = h.rows.get('marketplace')!
      expect(row.lastStatus).toBe('done')
      expect(row.lastStats).toEqual({ synced: 7, mode: 'latest' })
      expect(row.lastFinishedAt).toBeInstanceOf(Date)
      expect(row.runningSince).toBeNull()
      expect(row.lastError).toBeNull()
    })

    it('records the error and marks failed when the scraper throws', async () => {
      const h2 = createOrchestrator({ throwOnRun: true })
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      await h2.runReal(opts, { release: async () => undefined })

      const row = h2.rows.get('marketplace')!
      expect(row.lastStatus).toBe('failed')
      expect(row.lastError).toBe('upstream 500')
      expect(row.runningSince).toBeNull()
    })

    it('releases the lock even when the scraper throws', async () => {
      const h2 = createOrchestrator({ throwOnRun: true })
      const release = vi.fn(async () => undefined)
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      await h2.runReal(opts, { release })
      expect(release).toHaveBeenCalled()
    })

    it('releases the lock and frees the kind so a later trigger can run', async () => {
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })

      // The in-process guard is cleared in `finally`; without that, the kind would
      // stay busy for the lifetime of the process.
      const second = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      expect(second.deduped).toBe(false)
    })

    it('ignores a repeated enqueue of a kind while the first run is in flight', async () => {
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      await Promise.all([
        h.svc.enqueue({ kind: 'marketplace', mode: 'latest' }),
        h.svc.enqueue({ kind: 'marketplace', mode: 'latest' }),
      ])
      expect(h.runSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('execute dispatch', () => {
    it('marketplace + all → refresh({mode:all}) with the page cap', async () => {
      const opts = { kind: 'marketplace', mode: 'all', maxPages: 7 } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ mode: 'all', maxPages: 7 }))
    })

    it('marketplace + latest → no page cap (it stops on its own)', async () => {
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ maxPages: undefined }))
    })

    it('history + full → backfill with the page cap', async () => {
      const opts = { kind: 'history', mode: 'full', maxPages: 4 } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.historySync.backfill).toHaveBeenCalledWith({ maxPages: 4 })
      expect(h.historySync.refreshLatest).not.toHaveBeenCalled()
    })

    it('history + latest → refreshLatest only', async () => {
      const opts = { kind: 'history', mode: 'latest' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.historySync.refreshLatest).toHaveBeenCalled()
      expect(h.historySync.backfill).not.toHaveBeenCalled()
    })

    it('passes the admin-supplied itemName through to the scraper', async () => {
      const opts = { kind: 'marketplace', mode: 'latest', itemName: 'Sword' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ itemName: 'Sword' }))
    })
  })

  describe('status', () => {
    it('reports one entry per kind even when nothing has ever run', async () => {
      const snap = await h.svc.status()
      expect(Object.keys(snap).sort()).toEqual([...ALL_KINDS].sort())
      expect(snap.marketplace.running).toBe(false)
      expect(snap.marketplace.lastFinishedAt).toBeNull()
      expect(snap.history.running).toBe(false)
    })

    it('surfaces running state and the item count for the kind that ran', async () => {
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h.svc.enqueue(opts)
      const running = await h.svc.status()
      expect(running.marketplace.running).toBe(true)
      expect(running.marketplace.runningSince).not.toBeNull()

      await h.runReal(opts, { release: async () => undefined })
      const done = await h.svc.status()
      expect(done.marketplace.running).toBe(false)
      expect(done.marketplace.lastStatus).toBe('done')
      expect(done.marketplace.lastSynced).toBe(7)
    })

    // The bug this guards: status() used to return a single "most recently
    // completed run", so a finished history sync made the marketplace page
    // display a history item count as its own.
    it('does not let one kind’s completed run become the other kind’s last sync', async () => {
      const history = { kind: 'history', mode: 'full' } as const
      await h.svc.enqueue(history)
      await h.runReal(history, { release: async () => undefined })

      const snap = await h.svc.status()
      expect(snap.history.lastStatus).toBe('done')
      expect(snap.history.lastSynced).toBe(3)
      // The marketplace never ran, so it must not inherit history's numbers.
      expect(snap.marketplace.lastStatus).toBeNull()
      expect(snap.marketplace.lastFinishedAt).toBeNull()
      expect(snap.marketplace.lastSynced).toBeNull()
    })

    it('reports the error for a failed kind without touching the other', async () => {
      const h2 = createOrchestrator({ throwOnRun: true })
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      await h2.runReal(opts, { release: async () => undefined })

      const snap = await h2.svc.status()
      expect(snap.marketplace.lastStatus).toBe('failed')
      expect(snap.marketplace.lastError).toBe('upstream 500')
      expect(snap.history.lastError).toBeNull()
    })
  })

  describe('transient-failure retry', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    /** A DNS blip, the failure mode actually seen in the container. */
    function dnsBlip() {
      return Object.assign(new Error('getaddrinfo EAI_AGAIN market-api.numine.io'), { code: 'EAI_AGAIN' })
    }

    it('retries a transient failure and succeeds on a later attempt', async () => {
      const h2 = createOrchestrator()
      const refresh = h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>
      refresh
        .mockRejectedValueOnce(dnsBlip())
        .mockRejectedValueOnce(dnsBlip())
        .mockResolvedValueOnce({ synced: 4 })

      vi.useFakeTimers()
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      // Skip both backoffs (2s then 4s).
      const running = h2.runReal(opts, { release: async () => undefined })
      await vi.advanceTimersByTimeAsync(10_000)
      await running

      expect(refresh).toHaveBeenCalledTimes(3)
      const row = h2.rows.get('marketplace')!
      expect(row.lastStatus).toBe('done')
      expect(row.lastStats).toEqual({ synced: 4, mode: 'latest' })
    })

    it('gives up after the attempt budget and records the failure', async () => {
      const h2 = createOrchestrator()
      const refresh = h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>
      refresh.mockRejectedValue(dnsBlip())

      vi.useFakeTimers()
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      const running = h2.runReal(opts, { release: async () => undefined })
      await vi.advanceTimersByTimeAsync(20_000)
      await running

      expect(refresh).toHaveBeenCalledTimes(3)
      const row = h2.rows.get('marketplace')!
      expect(row.lastStatus).toBe('failed')
      expect(String(row.lastError)).toContain('EAI_AGAIN')
      expect(row.runningSince).toBeNull()
    })

    it('does not retry a non-transient failure', async () => {
      const h2 = createOrchestrator()
      const refresh = h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>
      refresh.mockRejectedValue(new Error('Favorite not found'))

      vi.useFakeTimers()
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      const running = h2.runReal(opts, { release: async () => undefined })
      await vi.advanceTimersByTimeAsync(20_000)
      await running

      // No retry: the request itself was wrong, so retrying would only burn
      // the upstream rate limit.
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(h2.rows.get('marketplace')!.lastStatus).toBe('failed')
    })

    it('retries on an upstream 5xx', async () => {
      const h2 = createOrchestrator()
      const refresh = h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>
      refresh
        .mockRejectedValueOnce({ response: { status: 503 }, message: 'unavailable' })
        .mockResolvedValueOnce({ synced: 1 })

      vi.useFakeTimers()
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      const running = h2.runReal(opts, { release: async () => undefined })
      await vi.advanceTimersByTimeAsync(10_000)
      await running

      expect(refresh).toHaveBeenCalledTimes(2)
      expect(h2.rows.get('marketplace')!.lastStatus).toBe('done')
    })

    it('releases the lock after retries are exhausted', async () => {
      const h2 = createOrchestrator()
      const release = vi.fn(async () => undefined)
      ;(h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(dnsBlip())

      vi.useFakeTimers()
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h2.svc.enqueue(opts)
      const running = h2.runReal(opts, { release })
      await vi.advanceTimersByTimeAsync(20_000)
      await running

      expect(release).toHaveBeenCalled()
    })
  })

  describe('onApplicationBootstrap', () => {
    it('clears a stale running marker so the UI cannot spin forever', async () => {
      h.rows.set('marketplace', makeState({ kind: 'marketplace', runningSince: new Date(), lastStatus: 'running' }))
      h.rows.set('history', makeState({ kind: 'history' }))

      await h.svc.onApplicationBootstrap()

      expect(h.rows.get('marketplace')?.runningSince).toBeNull()
      expect(h.rows.get('marketplace')?.lastStatus).toBe('interrupted')
      expect(h.rows.get('marketplace')?.lastError).toBe('Interrupted by restart')
      // The idle kind is untouched.
      expect(h.rows.get('history')?.lastStatus).toBeNull()
    })

    it('does not rewrite rows that were never marked running', async () => {
      h.rows.set('marketplace', makeState({ kind: 'marketplace' }))
      h.rows.set('history', makeState({ kind: 'history' }))

      await h.svc.onApplicationBootstrap()

      // The update targets only rows with a running marker; the mock counts those.
      expect(h.stateRepo.update).not.toHaveBeenCalled()
    })

    // The bug this guards. A deploy (or any kill) during a run means `finally`
    // never executes, so the Redis lock survives its owner. It outlives the row,
    // which is why clearing `running_since` alone is not enough: every later
    // trigger then dedupes against a run that no longer exists and sync silently
    // stops for the rest of the TTL.
    it('releases the orphaned Redis lock for an interrupted kind', async () => {
      h.rows.set('marketplace', makeState({ kind: 'marketplace', runningSince: new Date() }))
      await h.svc.onApplicationBootstrap()
      expect(h.lock.forceRelease).toHaveBeenCalledWith('sync:marketplace')
    })

    it('releases both kinds’ locks even when no row was stranded', async () => {
      // A process killed between taking the lock and committing the row leaves a
      // lock with no row to match it, so cleanup cannot be driven by the rows.
      h.rows.set('marketplace', makeState({ kind: 'marketplace' }))
      h.rows.set('history', makeState({ kind: 'history' }))

      await h.svc.onApplicationBootstrap()

      const keys = h.lock.forceRelease.mock.calls.map((c) => c[0])
      expect(keys.sort()).toEqual(['sync:history', 'sync:marketplace'])
    })

    it('lets a new run start after recovery, rather than deduping forever', async () => {
      h.rows.set('marketplace', makeState({ kind: 'marketplace', runningSince: new Date() }))
      await h.svc.onApplicationBootstrap()

      // The lock is free again, so the next cron tick acquires it instead of
      // joining a run that is not happening.
      const res = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      expect(res.deduped).toBe(false)
      expect(h.lock.acquire).toHaveBeenCalledWith('sync:marketplace', expect.any(Number))
    })
  })
})
