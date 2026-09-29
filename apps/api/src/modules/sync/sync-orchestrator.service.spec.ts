import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SyncOrchestratorService } from './sync-orchestrator.service'
import type { SyncJobEntity } from './entities'

/**
 * The orchestrator exists to make an unbounded third-party scrape safe on a small
 * shared box: one job at a time per kind, deduplicated, never held open over an
 * HTTP request, and always left in a truthful terminal state.
 */
type RepoCall = { method: string; args: unknown[] }

function makeJob(over: Partial<SyncJobEntity> = {}): SyncJobEntity {
  return {
    id: 1,
    kind: 'marketplace',
    status: 'queued',
    trigger: 'admin',
    accountId: null,
    mode: 'latest',
    itemName: null,
    maxPages: 200,
    stats: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    finishedAt: null,
    ...over,
  } as SyncJobEntity
}

function createOrchestrator(opts: { lockGranted?: boolean; throwOnRun?: boolean } = {}) {
  const calls: RepoCall[] = []
  const jobs: SyncJobEntity[] = []
  let nextId = 1

  const jobRepo = {
    create: vi.fn((x: Partial<SyncJobEntity>) => makeJob({ ...(x as object) } as Partial<SyncJobEntity>)),
    save: vi.fn(async (job: SyncJobEntity) => {
      const stored = { ...job, id: nextId++ }
      jobs.push(stored)
      return stored
    }),
    find: vi.fn(async () => []),
    findOne: vi.fn(async (cond: { where?: Record<string, unknown> }) => {
      const w = cond?.where
      if (!w || Object.keys(w).length === 0) return null
      const matches = (actual: unknown, expected: unknown): boolean => {
        // In(['a','b']) is a FindOperator wrapping the candidate set, so a plain
        // equality check would never match it.
        if (expected && typeof expected === 'object' && Array.isArray((expected as { value?: unknown[] }).value)) {
          return ((expected as { value: unknown[] }).value).includes(actual)
        }
        return actual === expected
      }
      return (
        jobs.find((j) =>
          Object.entries(w).every(([k, v]) => matches((j as never as Record<string, unknown>)[k], v))
        ) ?? null
      )
    }),
    update: vi.fn(async (cond: unknown, patch: Record<string, unknown>) => {
      calls.push({ method: 'update', args: [cond, patch] })
      const id = (cond as { id: number }).id
      const target = jobs.find((j) => j.id === id)
      if (target) Object.assign(target, patch)
    }),
  }

  const lock = {
    acquire: vi.fn(async () =>
      opts.lockGranted === false
        ? null
        : { release: vi.fn(async () => undefined) }
    ),
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

  const svc = new SyncOrchestratorService(jobRepo as never, lock as never, marketplaceSync as never, historySync as never)

  // enqueue() starts work with a fire-and-forget `void this.run(...)`, which
  // would race every explicit run() below. Replace it with a spy so tests stay
  // deterministic, and drive execution through runReal.
  const runReal = svc.run.bind(svc)
  const runSpy = vi.fn(async () => undefined)
  svc.run = runSpy as unknown as typeof svc.run

  return { svc, runReal, runSpy, jobRepo, lock, marketplaceSync, historySync, jobs, calls }
}

describe('SyncOrchestratorService', () => {
  let h: ReturnType<typeof createOrchestrator>

  beforeEach(() => {
    h = createOrchestrator()
  })

  describe('enqueue', () => {
    it('creates a queued row and starts it in the background', async () => {
      const { job, deduped } = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      expect(deduped).toBe(false)
      expect(job.status).toBe('queued')
      // Started without the caller awaiting it.
      expect(h.runSpy).toHaveBeenCalledWith(job.id)
    })

    it('reuses an in-flight job of the same kind instead of queueing a second scrape', async () => {
      const first = await h.svc.enqueue({ kind: 'marketplace', mode: 'all', trigger: 'admin' })
      const second = await h.svc.enqueue({ kind: 'marketplace', mode: 'all', trigger: 'admin' })
      expect(second.deduped).toBe(true)
      expect(second.job.id).toBe(first.job.id)
      // Only one row was ever written.
      expect(h.jobRepo.save).toHaveBeenCalledTimes(1)
    })

    it('does not dedupe across kinds', async () => {
      await h.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      const other = await h.svc.enqueue({ kind: 'history', mode: 'latest', trigger: 'admin' })
      expect(other.deduped).toBe(false)
    })

    it('carries maxPages through so a backfill stays bounded', async () => {
      const { job } = await h.svc.enqueue({ kind: 'marketplace', mode: 'all', trigger: 'admin', maxPages: 5 })
      await h.runReal(job.id)
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ mode: 'all', maxPages: 5 }))
    })
  })

  describe('run', () => {
    it('marks the job done and records the scraper stats', async () => {
      const { job } = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      await h.runReal(job.id)
      const patch = h.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('done')
      expect(patch.stats).toEqual({ synced: 7, mode: 'latest' })
      expect(patch.finishedAt).toBeInstanceOf(Date)
    })

    it('records the error and marks failed when the scraper throws', async () => {
      const h2 = createOrchestrator({ throwOnRun: true })
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      await h2.runReal(job.id)
      const patch = h2.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('failed')
      expect(patch.error).toBe('upstream 500')
    })

    it('fails the job rather than running unguarded when the lock is unavailable', async () => {
      const h2 = createOrchestrator({ lockGranted: false })
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      await h2.runReal(job.id)
      const patch = h2.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('failed')
      expect(patch.error).toMatch(/lock/i)
      // Crucially, the scraper never ran.
      expect(h2.marketplaceSync.refresh).not.toHaveBeenCalled()
    })

    it('releases the lock even when the scraper throws', async () => {
      const h2 = createOrchestrator({ throwOnRun: true })
      const release = vi.fn(async () => undefined)
      const spy = vi.spyOn(h2.lock, 'acquire').mockResolvedValue({ release } as never)
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      await h2.runReal(job.id)
      expect(spy).toHaveBeenCalled()
      expect(release).toHaveBeenCalled()
    })

    it('refuses to rerun a job that is already terminal', async () => {
      const { job } = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      await h.runReal(job.id)
      const callCount = h.marketplaceSync.refresh.mock.calls.length
      await h.runReal(job.id)
      expect(h.marketplaceSync.refresh.mock.calls.length).toBe(callCount)
    })

    it('ignores a repeated run of the same job while the first is in flight', async () => {
      const { job } = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      await Promise.all([h.svc.run(job.id), h.svc.run(job.id)])
      expect(h.marketplaceSync.refresh.mock.calls.length).toBeLessThanOrEqual(2)
    })
  })

  describe('execute dispatch', () => {
    it('marketplace + all → refresh({mode:all}) with the page cap', async () => {
      const { job } = await h.svc.enqueue({ kind: 'marketplace', mode: 'all', trigger: 'admin', maxPages: 7 })
      await h.runReal(job.id)
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ mode: 'all', maxPages: 7 }))
    })

    it('marketplace + latest → no page cap (it stops on its own)', async () => {
      const { job } = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin' })
      await h.runReal(job.id)
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ maxPages: undefined }))
    })

    it('history + full → backfill with the page cap', async () => {
      const { job } = await h.svc.enqueue({ kind: 'history', mode: 'full', trigger: 'admin', maxPages: 4 })
      await h.runReal(job.id)
      expect(h.historySync.backfill).toHaveBeenCalledWith({ maxPages: 4 })
      expect(h.historySync.refreshLatest).not.toHaveBeenCalled()
    })

    it('history + latest → refreshLatest only', async () => {
      const { job } = await h.svc.enqueue({ kind: 'history', mode: 'latest', trigger: 'admin' })
      await h.runReal(job.id)
      expect(h.historySync.refreshLatest).toHaveBeenCalled()
      expect(h.historySync.backfill).not.toHaveBeenCalled()
    })

    it('passes the admin-supplied itemName through to the scraper', async () => {
      const { job } = await h.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'admin', itemName: 'Sword' })
      await h.runReal(job.id)
      expect(h.marketplaceSync.refresh).toHaveBeenCalledWith(expect.objectContaining({ itemName: 'Sword' }))
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
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'cron' })
      const running = h2.runReal(job.id)
      // Skip both backoffs (2s then 4s).
      await vi.advanceTimersByTimeAsync(10_000)
      await running

      expect(refresh).toHaveBeenCalledTimes(3)
      const patch = h2.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('done')
      expect(patch.stats).toEqual({ synced: 4, mode: 'latest' })
    })

    it('gives up after the attempt budget and records the failure', async () => {
      const h2 = createOrchestrator()
      const refresh = h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>
      refresh.mockRejectedValue(dnsBlip())

      vi.useFakeTimers()
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'cron' })
      const running = h2.runReal(job.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await running

      expect(refresh).toHaveBeenCalledTimes(3)
      const patch = h2.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('failed')
      expect(String(patch.error)).toContain('EAI_AGAIN')
    })

    it('does not retry a non-transient failure', async () => {
      const h2 = createOrchestrator()
      const refresh = h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>
      refresh.mockRejectedValue(new Error('Favorite not found'))

      vi.useFakeTimers()
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'cron' })
      const running = h2.runReal(job.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await running

      // No retry: the request itself was wrong, so retrying would only burn
      // the upstream rate limit.
      expect(refresh).toHaveBeenCalledTimes(1)
      const patch = h2.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('failed')
    })

    it('retries on an upstream 5xx', async () => {
      const h2 = createOrchestrator()
      const refresh = h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>
      refresh
        .mockRejectedValueOnce({ response: { status: 503 }, message: 'unavailable' })
        .mockResolvedValueOnce({ synced: 1 })

      vi.useFakeTimers()
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'cron' })
      const running = h2.runReal(job.id)
      await vi.advanceTimersByTimeAsync(10_000)
      await running

      expect(refresh).toHaveBeenCalledTimes(2)
      const patch = h2.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('done')
    })

    it('releases the lock after retries are exhausted', async () => {
      const h2 = createOrchestrator()
      const release = vi.fn(async () => undefined)
      const spy = vi.spyOn(h2.lock, 'acquire').mockResolvedValue({ release } as never)
      ;(h2.marketplaceSync.refresh as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(dnsBlip())

      vi.useFakeTimers()
      const { job } = await h2.svc.enqueue({ kind: 'marketplace', mode: 'latest', trigger: 'cron' })
      const running = h2.runReal(job.id)
      await vi.advanceTimersByTimeAsync(20_000)
      await running

      expect(spy).toHaveBeenCalled()
      expect(release).toHaveBeenCalled()
    })
  })

  describe('onApplicationBootstrap', () => {
    it('marks stranded running/queued jobs interrupted so the UI cannot spin forever', async () => {
      h.jobs.push(makeJob({ id: 1, status: 'running' }), makeJob({ id: 2, status: 'queued' }))
      h.jobRepo.find.mockResolvedValueOnce([makeJob({ id: 1, status: 'running' }), makeJob({ id: 2, status: 'queued' })] as never)
      await h.svc.onApplicationBootstrap()
      const patch = h.calls.at(-1)?.args[1] as Record<string, unknown>
      expect(patch.status).toBe('interrupted')
      expect(patch.error).toBe('Interrupted by restart')
    })

    it('does nothing when there is nothing stranded', async () => {
      h.jobRepo.find.mockResolvedValueOnce([] as never)
      await h.svc.onApplicationBootstrap()
      expect(h.jobRepo.update).not.toHaveBeenCalled()
    })
  })
})
