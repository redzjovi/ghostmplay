import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LockService } from './lock.service'
import type { RedisService } from './redis.service'

/**
 * The lock's TTL is a backstop for a process that dies, not a lease. A backfill is
 * an unbounded scrape, so a fixed TTL would expire mid-run and let a second scrape
 * start against the same public API. The renewal timer is therefore what makes an
 * uncapped backfill safe, which is why it gets its own spec.
 */
type FakeClient = {
  set: ReturnType<typeof vi.fn>
  del: ReturnType<typeof vi.fn>
  eval: ReturnType<typeof vi.fn>
}

function createRedis(client: FakeClient | null): RedisService {
  return { raw: client } as unknown as RedisService
}

function createClient(over: Partial<FakeClient> = {}): FakeClient {
  return {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    // 1 is what the extend script returns when the token still matches.
    eval: vi.fn(async () => 1),
    ...over,
  }
}

function scriptsRun(client: FakeClient): string[] {
  return client.eval.mock.calls.map((c) => String(c[0]))
}

const EXTEND = 'expire'
const DELETE = 'del'

/** Substring, not identity: the elements are whole Lua scripts. */
const ranExtend = (client: FakeClient) => scriptsRun(client).some((s) => s.includes(EXTEND))
const ranDelete = (client: FakeClient) => scriptsRun(client).some((s) => s.includes(DELETE))

describe('LockService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('grants the lock and stops a second holder', async () => {
    const client = createClient()
    const svc = new LockService(createRedis(client))
    const first = await svc.acquire('sync:marketplace', 7200)
    expect(first).not.toBeNull()

    client.set.mockResolvedValueOnce(null) // as if the key now exists
    const second = await svc.acquire('sync:marketplace', 7200)
    expect(second).toBeNull()
  })

  it('sets the key with the NX flag, so the grant is atomic', async () => {
    const client = createClient()
    const svc = new LockService(createRedis(client))
    await svc.acquire('sync:marketplace', 7200)
    expect(client.set).toHaveBeenCalledWith('lock:sync:marketplace', expect.any(String), 'EX', 7200, 'NX')
  })

  describe('renewal', () => {
    it('extends the TTL on a timer, not once', async () => {
      const client = createClient()
      const svc = new LockService(createRedis(client))
      const lock = await svc.acquire('sync:marketplace', 7200)
      expect(client.eval).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(ranExtend(client)).toBe(true)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(scriptsRun(client).filter((s) => s.includes(EXTEND))).toHaveLength(2)

      await lock!.release()
    })

    it('passes its own token and the TTL to the extend script', async () => {
      const client = createClient()
      const svc = new LockService(createRedis(client))
      const lock = await svc.acquire('sync:marketplace', 7200)
      const token = String(client.set.mock.calls[0][1])

      await vi.advanceTimersByTimeAsync(60_000)
      const [script, keys, key, tok, ttl] = client.eval.mock.calls[0]
      expect(String(script)).toContain(EXTEND)
      // The guard is what makes this safe: a lost lock must not be resurrected.
      expect(String(script)).toContain('ARGV[1]')
      expect(keys).toBe(1)
      expect(key).toBe('lock:sync:marketplace')
      expect(tok).toBe(token)
      expect(ttl).toBe('7200')

      await lock!.release()
    })

    it('stops renewing once the lock has been taken by someone else', async () => {
      // A run that overran its TTL and was legitimately superseded must not keep
      // trying to extend itself over the successor's lock.
      const client = createClient({ eval: vi.fn(async () => 0) })
      const svc = new LockService(createRedis(client))
      const lock = await svc.acquire('sync:marketplace', 7200)

      await vi.advanceTimersByTimeAsync(60_000)
      const afterFirst = client.eval.mock.calls.length
      await vi.advanceTimersByTimeAsync(300_000)
      expect(client.eval.mock.calls).toHaveLength(afterFirst)

      await lock!.release()
    })

    it('keeps trying when a renewal fails, since the TTL is still ahead', async () => {
      const client = createClient({
        eval: vi.fn(async () => {
          throw new Error('LOADING Redis is loading')
        }),
      })
      const svc = new LockService(createRedis(client))
      const lock = await svc.acquire('sync:marketplace', 7200)

      await vi.advanceTimersByTimeAsync(180_000)
      expect(client.eval.mock.calls.length).toBeGreaterThanOrEqual(3)

      await lock!.release()
    })

    it('stops the timer on release, so no stray renewal follows the delete', async () => {
      const client = createClient()
      const svc = new LockService(createRedis(client))
      const lock = await svc.acquire('sync:marketplace', 7200)

      await lock!.release()
      const atRelease = client.eval.mock.calls.length
      expect(ranDelete(client)).toBe(true)

      await vi.advanceTimersByTimeAsync(600_000)
      expect(client.eval.mock.calls).toHaveLength(atRelease)
    })

    it('releases only while it still owns the key', async () => {
      const client = createClient()
      const svc = new LockService(createRedis(client))
      const lock = await svc.acquire('sync:marketplace', 7200)
      await lock!.release()
      const [script, , key, token] = client.eval.mock.calls[0]
      expect(String(script)).toContain(DELETE)
      expect(String(script)).toContain('ARGV[1]')
      expect(key).toBe('lock:sync:marketplace')
      expect(token).toBe(String(client.set.mock.calls[0][1]))
      // del() is never called directly — only through the token check.
      expect(client.del).not.toHaveBeenCalled()
    })
  })

  describe('without Redis', () => {
    it('falls back to an in-process mutex and always grants the first caller', async () => {
      const svc = new LockService(createRedis(null))
      expect(await svc.acquire('sync:marketplace', 7200)).not.toBeNull()
      expect(await svc.acquire('sync:marketplace', 7200)).toBeNull()
    })

    it('re-grants after release, and starts no timer', async () => {
      const svc = new LockService(createRedis(null))
      const lock = await svc.acquire('sync:marketplace', 7200)
      await lock!.release()
      expect(await svc.acquire('sync:marketplace', 7200)).not.toBeNull()
      // Nothing to renew, so nothing may be left running.
      expect(vi.getTimerCount()).toBe(0)
    })

    it('forceRelease is a no-op with no client', async () => {
      const svc = new LockService(createRedis(null))
      expect(await svc.forceRelease('sync:marketplace')).toBe(false)
    })
  })

  describe('degraded Redis', () => {
    it('allows the run and leaves no timer when the client throws', async () => {
      // Failing open is deliberate: a lock service outage must not stop sync
      // entirely, and with one process the in-process mutex still serialises.
      const client = createClient({
        set: vi.fn(async () => {
          throw new Error('ECONNREFUSED')
        }),
      })
      const svc = new LockService(createRedis(client))
      expect(await svc.acquire('sync:marketplace', 7200)).not.toBeNull()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('forceRelease', () => {
    it('deletes an orphaned key without a token check', async () => {
      const client = createClient()
      const svc = new LockService(createRedis(client))
      expect(await svc.forceRelease('sync:history')).toBe(true)
      expect(client.del).toHaveBeenCalledWith('lock:sync:history')
    })

    it('reports false when there was nothing to clear', async () => {
      const client = createClient({ del: vi.fn(async () => 0) })
      const svc = new LockService(createRedis(client))
      expect(await svc.forceRelease('sync:history')).toBe(false)
    })

    it('swallows a Redis failure rather than blocking boot', async () => {
      const client = createClient({
        del: vi.fn(async () => {
          throw new Error('down')
        }),
      })
      const svc = new LockService(createRedis(client))
      await expect(svc.forceRelease('sync:history')).resolves.toBe(false)
    })
  })
})
