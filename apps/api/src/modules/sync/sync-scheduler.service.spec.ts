import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncSchedulerService } from './sync-scheduler.service'
import type { SyncKind } from './entities'

/**
 * The cron runs both kinds every minute, and the order is load-bearing rather
 * than cosmetic.
 *
 * History derives sold state from the transfer ledger, and both of its paths
 * stop at the first transfer they already hold. So if history ran while the
 * marketplace scraper had not yet inserted the item row a transfer refers to,
 * the join would match nothing — and since the transfer is then stored, no
 * later history run would ever look at it again. The item would stay on sale
 * permanently. Running marketplace first closes that window.
 */
function createHarness() {
  const order: string[] = []
  const gates = new Map<SyncKind, Promise<void>>()
  const resolvers = new Map<SyncKind, () => void>()

  const orchestrator = {
    enqueue: vi.fn(async ({ kind, mode }: { kind: SyncKind; mode: string }) => {
      order.push(`enqueue:${kind}`)
      let release!: () => void
      gates.set(
        kind,
        new Promise<void>((r) => {
          release = r
        })
      )
      resolvers.set(kind, release)
      return { deduped: false, kind, mode, runningSince: new Date().toISOString() }
    }),
    // Mirrors the real one: resolves only once that kind's run has settled.
    settled: vi.fn(async (kind: SyncKind) => {
      const gate = gates.get(kind)
      if (gate) await gate
    })
  }

  const svc = new SyncSchedulerService(orchestrator as never)
  vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
  vi.spyOn(svc['logger'], 'error').mockImplementation(() => {})

  return { svc, order, gates, resolvers, orchestrator }
}

/** Lets the scheduler run until it is parked on a gate it cannot pass. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('SyncSchedulerService', () => {
  let h: ReturnType<typeof createHarness>

  beforeEach(() => {
    h = createHarness()
  })

  it('visits marketplace before history', async () => {
    const run = h.svc.runLatest()
    await drain()
    h.resolvers.get('marketplace')!()
    await drain()
    h.resolvers.get('history')!()
    await run
    expect(h.order).toEqual(['enqueue:marketplace', 'enqueue:history'])
  })

  it('does not start history until the marketplace run has finished', async () => {
    // The assertion that matters. Both kinds used to be started back to back,
    // because enqueue() is fire-and-forget, so this ordering was never enforced.
    const run = h.svc.runLatest()
    await drain()
    expect(h.orchestrator.settled).toHaveBeenCalledWith('marketplace')
    expect(h.order).toEqual(['enqueue:marketplace'])

    h.resolvers.get('marketplace')!()
    await drain()
    expect(h.order).toEqual(['enqueue:marketplace', 'enqueue:history'])

    h.resolvers.get('history')!()
    await run
  })

  it('runs only latest', async () => {
    const run = h.svc.runLatest()
    await drain()
    h.resolvers.get('marketplace')!()
    await drain()
    h.resolvers.get('history')!()
    await run
    for (const call of h.orchestrator.enqueue.mock.calls) {
      expect(call[0].mode).toBe('latest')
    }
  })

  it('still runs history when the marketplace run fails to start', async () => {
    h.orchestrator.enqueue = vi.fn(async ({ kind, mode }: { kind: SyncKind; mode: string }) => {
      if (kind === 'marketplace') throw new Error('redis down')
      h.order.push('enqueue:history')
      return { deduped: false, kind, mode, runningSince: null }
    }) as never
    await h.svc.runLatest()
    // One kind failing must not take the other down with it.
    expect(h.order).toEqual(['enqueue:history'])
  })

  it('completes without awaiting a kind that never started', async () => {
    // The lock was held elsewhere, so there is no run to wait on.
    h.orchestrator.enqueue = vi.fn(async ({ kind, mode }: { kind: SyncKind; mode: string }) => {
      h.order.push(`enqueue:${kind}`)
      return { deduped: true, kind, mode, runningSince: null }
    }) as never
    h.orchestrator.settled = vi.fn(async () => undefined) as never
    await expect(h.svc.runLatest()).resolves.toBeUndefined()
    expect(h.order).toEqual(['enqueue:marketplace', 'enqueue:history'])
  })
})
