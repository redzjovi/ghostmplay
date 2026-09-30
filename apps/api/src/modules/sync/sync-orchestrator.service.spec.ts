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
    // `update(criteria, partial)` takes the criteria directly — unlike `find`,
    // which wraps them in a `where` key. Honoured here so `update({kind}, …)`
    // reaches a row whose runningSince is already null, and so boot recovery's
    // Not(IsNull()) clause still spares the kind that was not running.
    update: vi.fn(async (criteria: Row, patch: Row) => {
      calls.push({ method: 'update', args: [criteria, patch] })
      let affected = 0
      for (const [kind, row] of rows) {
        if ('kind' in criteria && criteria.kind !== kind) continue
        if ('runningSince' in criteria && row.runningSince == null) continue
        rows.set(kind, { ...row, ...patch })
        affected++
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
    // Required, not defaulted: the orchestrator always passes an options object,
    // and a default would make the param optional, so call[0] would type as
    // possibly-undefined in the dispatch tests below.
    refresh: vi.fn(async (_opts: { mode?: string; itemName?: string }) => {
      if (opts.throwOnRun) throw new Error('upstream 500')
      return { synced: 7 }
    }),
  }
  const historySync = {
    backfill: vi.fn(async () => ({ synced: 3, total: 9, enriched: 1, claimed: 2, skipped: 0 })),
    refreshLatest: vi.fn(async () => ({ synced: 2, total: 5, enriched: 0, claimed: 1, skipped: 0 })),
  }

  // clear() dispatches to the services that own each table, not to the scrapers.
  const marketplace = { clearAll: vi.fn(async () => ({ items: 519, details: 488 })) }
  const history = { clearAll: vi.fn(async () => ({ transfers: 8042 })) }

  const svc = new SyncOrchestratorService(
    stateRepo as never,
    lock as never,
    marketplaceSync as never,
    historySync as never,
    marketplace as never,
    history as never
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

  return {
    svc,
    runReal,
    runSpy,
    stateRepo,
    lock,
    marketplaceSync,
    historySync,
    marketplace,
    history,
    rows,
    calls,
    lastPatch,
  }
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
  })

  describe('settled', () => {
    // What makes sequencing the two kinds possible: a caller that has just been
    // deduped still needs a handle on the run it joined, or the scheduler cannot
    // order history after marketplace.
    it('is null when nothing is in flight', () => {
      expect(h.svc.settled('marketplace')).toBeNull()
    })

    it('resolves once the run it started has finished', async () => {
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      const p = h.svc.settled('marketplace')
      expect(p).not.toBeNull()
      await expect(p).resolves.toBeUndefined()
    })

    it('does not resolve while the run is still going', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      h.svc.run = vi.fn(async () => {
        await gate
      }) as unknown as typeof h.svc.run
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })

      let done = false
      const waiter = h.svc.settled('marketplace')!.then(() => {
        done = true
      })
      await Promise.resolve()
      expect(done).toBe(false)

      release()
      await waiter
      expect(done).toBe(true)
    })

    it('hands back the run a deduplicated trigger joined', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      h.svc.run = vi.fn(async () => {
        await gate
      }) as unknown as typeof h.svc.run
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      const second = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      expect(second.deduped).toBe(true)

      const p = h.svc.settled('marketplace')
      expect(p).not.toBeNull()
      release()
      await expect(p).resolves.toBeUndefined()
    })

    it('resolves rather than rejecting when the scrape itself fails', async () => {
      // The invariant the scheduler's bare `await` relies on. Driven through the
      // real run(): it catches the failure into finish('failed'), so the gate can
      // never surface a rejection to the caller.
      const failing = createOrchestrator({ throwOnRun: true })
      failing.svc.run = failing.runReal
      await failing.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      await expect(failing.svc.settled('marketplace')).resolves.toBeUndefined()
      expect(failing.rows.get('marketplace')?.lastStatus).toBe('failed')
    })

    it('tracks each kind separately', async () => {
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest' })
      await h.svc.enqueue({ kind: 'history', mode: 'latest' })
      expect(h.svc.settled('marketplace')).not.toBeNull()
      expect(h.svc.settled('history')).not.toBeNull()
    })
  })

  describe('clear', () => {
    it('deletes marketplace rows and reports the counts', async () => {
      const res = await h.svc.clear('marketplace')
      expect(h.marketplace.clearAll).toHaveBeenCalledTimes(1)
      expect(h.history.clearAll).not.toHaveBeenCalled()
      expect(res).toEqual({ kind: 'marketplace', deleted: { items: 519, details: 488 } })
    })

    it('deletes history rows and reports the count', async () => {
      const res = await h.svc.clear('history')
      expect(h.history.clearAll).toHaveBeenCalledTimes(1)
      expect(h.marketplace.clearAll).not.toHaveBeenCalled()
      expect(res).toEqual({ kind: 'history', deleted: { transfers: 8042 } })
    })

    it('takes the same lock a scrape would, so the two cannot overlap', async () => {
      await h.svc.clear('marketplace')
      expect(h.lock.acquire).toHaveBeenCalledWith('sync:marketplace', expect.any(Number))
    })

    it('refuses while that kind is in flight in this process', async () => {
      // The delete must not race an in-flight insert, or the table ends up
      // half-repopulated by the run that was already writing to it.
      const run = h.svc.run.bind(h.svc)
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h.svc.enqueue(opts)
      // enqueue registered the kind as in-flight before its fire-and-forget run.
      await expect(h.svc.clear('marketplace')).rejects.toThrow(/in progress/)
      expect(h.marketplace.clearAll).not.toHaveBeenCalled()
      await run(opts, { release: async () => undefined })
    })

    it('refuses when the lock is held elsewhere, and does not delete', async () => {
      const h2 = createOrchestrator({ lockGranted: false })
      await expect(h2.svc.clear('history')).rejects.toThrow(/in progress elsewhere/)
      expect(h2.history.clearAll).not.toHaveBeenCalled()
    })

    it('releases the lock even when the delete throws', async () => {
      const h2 = createOrchestrator()
      const lock = { release: vi.fn(async () => undefined) }
      h2.lock.acquire.mockResolvedValue(lock as never)
      h2.marketplace.clearAll.mockRejectedValue(new Error('deadlock detected'))
      await expect(h2.svc.clear('marketplace')).rejects.toThrow('deadlock detected')
      expect(lock.release).toHaveBeenCalled()
    })

    it('resets the stored state so it stops describing a table that is gone', async () => {
      // Otherwise the Data page keeps reporting "done, 516 synced" over an
      // empty result.
      await h.svc.enqueue({ kind: 'marketplace', mode: 'all' })
      await h.runReal({ kind: 'marketplace', mode: 'all' } as const, { release: async () => undefined })
      expect(h.rows.get('marketplace')?.lastStatus).toBe('done')

      await h.svc.clear('marketplace')
      const row = h.rows.get('marketplace')!
      expect(row.lastStatus).toBeNull()
      expect(row.lastFinishedAt).toBeNull()
      expect(row.lastStats).toBeNull()
      expect(row.lastError).toBeNull()
      // kind and mode survive, so the row is still addressable.
      expect(row.kind).toBe('marketplace')
      expect(row.mode).toBe('all')
    })

    it('leaves the other kind\'s state alone', async () => {
      await h.svc.enqueue({ kind: 'history', mode: 'full' })
      await h.runReal({ kind: 'history', mode: 'full' } as const, { release: async () => undefined })
      await h.svc.clear('marketplace')
      expect(h.rows.get('history')?.lastStatus).toBe('done')
      expect(h.rows.get('history')?.lastStats).not.toBeNull()
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
      // The TTL is a backstop for a dead process, not a budget: LockService renews
      // it while the lock is held. It still has to comfortably cover a full history
      // backfill, so that even a broken renewal leaves the common case finishing.
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
    it('marketplace + all → refresh({mode:all}) with no page cap', async () => {
      const opts = { kind: 'marketplace', mode: 'all' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith({ mode: 'all', itemName: undefined })
    })

    it('marketplace + latest → refresh({mode:latest})', async () => {
      const opts = { kind: 'marketplace', mode: 'latest' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith({ mode: 'latest', itemName: undefined })
    })

    it('never passes a page cap to either scraper', async () => {
      // The cap is gone: both scrapers walk to the upstream's natural end, and the
      // self-renewing lock is what stops a long walk from overlapping the next run.
      const mkt = { kind: 'marketplace', mode: 'all' } as const
      await h.svc.enqueue(mkt)
      await h.runReal(mkt, { release: async () => undefined })
      for (const call of h.marketplaceSync.refresh.mock.calls) {
        expect(Object.keys(call[0])).not.toContain('maxPages')
      }

      const h2 = createOrchestrator()
      const hist = { kind: 'history', mode: 'full' } as const
      await h2.svc.enqueue(hist)
      await h2.runReal(hist, { release: async () => undefined })
      expect(h2.historySync.backfill).toHaveBeenCalledWith()
    })

    it('marketplace + all → passes the item name filter through', async () => {
      const opts = { kind: 'marketplace', mode: 'all', itemName: 'Gold Box' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith({ mode: 'all', itemName: 'Gold Box' })
    })

    it('history + full → backfill', async () => {
      const opts = { kind: 'history', mode: 'full' } as const
      await h.svc.enqueue(opts)
      await h.runReal(opts, { release: async () => undefined })
      expect(h.historySync.backfill).toHaveBeenCalledWith()
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
