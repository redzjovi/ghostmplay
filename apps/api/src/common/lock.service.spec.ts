import { describe, it, expect, vi } from 'vitest'
import { LockService } from './lock.service'

/**
 * The lock is an in-process mutex, which is a small thing to test and a large
 * thing to be wrong about: it is the only thing stopping a double-clicked
 * "Sync full" from launching a second unbounded scrape of a public API, and it
 * only holds while there is exactly one process. There is no TTL and no renewal,
 * because a lock whose process died is already gone.
 */
describe('LockService', () => {
  it('grants the lock and refuses a second holder', async () => {
    const svc = new LockService()
    expect(await svc.acquire('sync:marketplace')).not.toBeNull()
    expect(await svc.acquire('sync:marketplace')).toBeNull()
  })

  it('re-grants after release', async () => {
    const svc = new LockService()
    const lock = await svc.acquire('sync:marketplace')
    await lock!.release()
    expect(await svc.acquire('sync:marketplace')).not.toBeNull()
  })

  it('keys by kind, so the two scrapers never block each other', async () => {
    const svc = new LockService()
    const marketplace = await svc.acquire('sync:marketplace')
    const history = await svc.acquire('sync:history')

    expect(marketplace).not.toBeNull()
    expect(history).not.toBeNull()
  })

  it('releasing twice is harmless, so a caller cannot break a later run', async () => {
    // `run()` releases in a `finally` and `clear()` releases after a delete. A
    // double release must not free a lock the next holder has since taken.
    const svc = new LockService()
    const lock = await svc.acquire('sync:marketplace')
    await lock!.release()

    const second = await svc.acquire('sync:marketplace')
    await lock!.release()

    expect(await svc.acquire('sync:marketplace')).toBeNull()
    expect(second).not.toBeNull()
  })

  it('starts no timer, because there is nothing to renew', async () => {
    // A renewal timer surviving a release was the old failure mode: it kept a
    // lease alive for a lock nobody held.
    vi.useFakeTimers()
    try {
      const svc = new LockService()
      const lock = await svc.acquire('sync:marketplace')
      await lock!.release()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never releases a lock it has not been given', async () => {
    // `clear()` takes the lock purely as a conflict test and must give it back,
    // or it would block the next scrape of that kind forever.
    const svc = new LockService()
    const held = await svc.acquire('sync:marketplace')

    const probe = await svc.acquire('sync:marketplace')
    expect(probe).toBeNull()

    await held!.release()
    expect(await svc.acquire('sync:marketplace')).not.toBeNull()
  })
})