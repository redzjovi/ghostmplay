import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncService } from './sync.service'
import { buildImageUrl } from './sync.service'
import type { SearchRedisItem } from './api/ghost-marketplace.client'

/**
 * There is no page cap, so the only thing that ends a walk is the upstream
 * returning a short page. That makes the termination path worth pinning: the
 * synthetic client below serves more pages than any cap this app used to apply,
 * so a regression that reintroduced one would stop early and be caught here.
 */
const ITEM = (n: number) => ({
  item_id: n,
  view_count: 0,
  price: 1 + (n % 7),
  created_at: 1_700_000_000 - n,
  token_id: String(500_000 + n),
  uid: 'u',
  game_name: 'GhostMGlobal',
  seller: '0xseller',
  item_name: `Item ${n}`,
  currency: 'NUMI',
  image_url: 'QmImage',
  trait_pairs: ['Level=0', 'Grade Effect=Normal'],
  trait_nums: { Level: 0, Enchant: 0 },
}) as unknown as SearchRedisItem

/**
 * Serves `pages` full pages of 12, then an empty one — the shape the real
 * upstream shows, where `count` merely echoes the page size.
 */
function fakeClient(pages: number, perPage = 12) {
  const calls: number[] = []
  const searchRedis = vi.fn(async ({ offset }: { offset?: number } = {}) => {
    const o = offset ?? 0
    calls.push(o)
    const start = o * perPage
    const items = start >= pages * perPage ? [] : Array.from({ length: perPage }, (_, i) => ITEM(start + i + 1))
    return { count: items.length, ipfs: 'https://ipfs.example', items }
  })
  return { client: { searchRedis, detail: vi.fn(async () => null) } as never, searchRedis, calls }
}

describe('SyncService.refresh — termination', () => {
  let upsertFromApi: ReturnType<typeof vi.fn>
  let findCreatedAtMap: ReturnType<typeof vi.fn>

  beforeEach(() => {
    upsertFromApi = vi.fn(async () => ({}))
    // Every item is new, so `latest` has nothing to break on.
    findCreatedAtMap = vi.fn(async () => new Map<number, number>())
  })

  const make = (client: unknown) =>
    new SyncService(client as never, { upsertFromApi, findCreatedAtMap } as never)

  it('walks past 200 pages, which is where the old cap stopped it', async () => {
    const { client, calls } = fakeClient(260)
    const svc = make(client)
    vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
    const res = await svc.refresh({ mode: 'all' })

    // 260 pages is far beyond the 200-page cap this used to carry, so reaching
    // 261 requests (the empty one) is the proof the cap is gone.
    expect(calls.length).toBe(261)
    expect(calls[200]).toBe(200)
    expect(res.synced).toBe(260 * 12)
  })

  it('stops on the short page, not on a page budget', async () => {
    // The real upstream's final page is partial; a walk must end there too.
    const calls: number[] = []
    const searchRedis = vi.fn(async ({ offset }: { offset?: number } = {}) => {
      const o = offset ?? 0
      calls.push(o)
      const n = o === 3 ? 5 : 12
      return { count: n, ipfs: '', items: Array.from({ length: n }, (_, i) => ITEM(o * 12 + i + 1)) }
    })
    const svc = new SyncService({ searchRedis, detail: vi.fn() } as never, {
      upsertFromApi,
      findCreatedAtMap,
    } as never)
    vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
    const res = await svc.refresh({ mode: 'all' })
    expect(res.synced).toBe(12 + 12 + 12 + 5)
    expect(calls).toEqual([0, 1, 2, 3])
  })

  it('stops on an empty page when the upstream gives no total to go on', async () => {
    const { client, calls } = fakeClient(3)
    const svc = make(client)
    vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
    await svc.refresh({ mode: 'all' })
    // 3 full pages + the empty one that proves the end.
    expect(calls).toEqual([0, 1, 2, 3])
  })

  it('latest mode still breaks as soon as it meets a known item', async () => {
    // The early exit is the only thing bounding the cron, so it must survive the
    // removal of the page cap.
    findCreatedAtMap = vi.fn(async () => new Map([[1, 1_700_000_000 - 1]]))
    const { client, calls } = fakeClient(100)
    const svc = make(client)
    vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
    const res = await svc.refresh({ mode: 'latest' })
    // Item 1 is known and unchanged, so the very first row ends it.
    expect(calls).toEqual([0])
    expect(res.synced).toBe(0)
  })

  it('defaults to latest when no mode is given', async () => {
    findCreatedAtMap = vi.fn(async () => new Map([[1, 1_700_000_000 - 1]]))
    const { client, calls } = fakeClient(50)
    const svc = make(client)
    vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
    await svc.refresh()
    expect(calls).toEqual([0])
  })

  it('no longer writes sold state from an empty detail', async () => {
    // The inference is gone: an empty detail is logged and nothing more. Sold
    // state comes from the transfer ledger via markItemsSold.
    const detail = vi.fn(async () => {
      throw new Error('HTTP 503')
    })
    const searchRedis = vi.fn(async () => ({ count: 1, ipfs: '', items: [ITEM(1)] }))
    const svc = new SyncService({ searchRedis, detail } as never, {
      upsertFromApi,
      findCreatedAtMap,
    } as never)
    vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
    await svc.refresh({ mode: 'all' })
    expect(upsertFromApi).toHaveBeenCalledTimes(1)
    expect(Object.keys(upsertFromApi.mock.calls[0][0])).not.toContain('sold')
  })
})

describe('buildImageUrl', () => {
  // A CIDv0 is "Qm" plus 44 base58 characters, and the matcher enforces that
  // length — a short stand-in like "QmAbc" is not a CID and takes no branch.
  const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'

  it('returns empty for nothing usable', () => {
    expect(buildImageUrl('', '')).toBe('')
    expect(buildImageUrl('https://base', '   ')).toBe('')
  })

  it('leaves an already-routed /ipfs/ URL alone', () => {
    expect(buildImageUrl('', `https://cdn.example/ipfs/${CID}`)).toBe(`https://cdn.example/ipfs/${CID}`)
  })

  it('routes a gateway-hosted CID under /ipfs/', () => {
    expect(buildImageUrl('', `https://cdn.example/${CID}`)).toBe(`https://cdn.example/ipfs/${CID}`)
  })

  it('routes a bare CID against the configured base', () => {
    expect(buildImageUrl('https://ipfs.example', CID)).toBe(`https://ipfs.example/ipfs/${CID}`)
  })

  it('re-routes a CID the base is already prefixed onto', () => {
    // searchRedis can hand back "<base>/<cid>", which is not a usable URL.
    expect(buildImageUrl('https://ipfs.example', `https://ipfs.example/${CID}`)).toBe(
      `https://ipfs.example/ipfs/${CID}`
    )
  })

  it('handles the CIDv1 forms', () => {
    expect(buildImageUrl('https://ipfs.example', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(
      'https://ipfs.example/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    )
  })

  it('passes a real URL through untouched', () => {
    expect(buildImageUrl('https://ipfs.example', 'https://other.example/x.png')).toBe(
      'https://other.example/x.png'
    )
  })
})
