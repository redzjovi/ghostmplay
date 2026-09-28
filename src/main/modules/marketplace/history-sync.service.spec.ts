import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HistorySyncService } from './history-sync.service'

function createHarness() {
  const tokenTransfers = vi.fn()
  const detailStrict = vi.fn(async () => ({ ownerName: '' }))
  const client = { tokenTransfers, detailStrict } as never
  const upsertFromApi = vi.fn(async () => ({}))
  const existsByTxHash = vi.fn(async () => false)
  const history = { upsertFromApi, existsByTxHash } as never
  const svc = new HistorySyncService(client as never, history as never)
  vi.spyOn(svc['logger'], 'log').mockImplementation(() => {})
  return { svc, tokenTransfers, detailStrict, upsertFromApi, existsByTxHash }
}

const t = (over: Record<string, unknown> = {}) => ({
  token_id: '4949',
  seller: '0xSeller',
  buyer: '0xBuyer',
  game_name: 'GhostMGlobal',
  item_name: '100,000,000 Gold Box',
  price: 148,
  currency: 'NUMI',
  tx_hash: '0xhash',
  image_url: 'QmX',
  time: '2026-09-25 01:45:59',
  ...over
})

describe('HistorySyncService', () => {
  beforeEach(() => vi.clearAllMocks())

  it('backfill paginates with page index and upserts with gameName', async () => {
    const h = createHarness()
    h.tokenTransfers
      .mockResolvedValueOnce({ count: 3, lists: [t({ tx_hash: '0x1' }), t({ tx_hash: '0x2' })] })
      .mockResolvedValueOnce({ count: 3, lists: [t({ tx_hash: '0x3' })] })
    const res = await h.svc.backfill({ limit: 2 })
    expect(h.tokenTransfers).toHaveBeenNthCalledWith(1, { limit: 2, offset: 0 })
    expect(h.tokenTransfers).toHaveBeenNthCalledWith(2, { limit: 2, offset: 1 })
    expect(h.upsertFromApi).toHaveBeenCalledTimes(3)
    expect(res.synced).toBe(3)
    expect(h.upsertFromApi).toHaveBeenCalledWith(expect.objectContaining({ gameName: 'GhostMGlobal' }))
  })

  it('backfill stops at last partial page without extra request', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValueOnce({ count: 3, lists: [t({ tx_hash: '0x1' })] })
    await h.svc.backfill({ limit: 2 })
    expect(h.tokenTransfers).toHaveBeenCalledTimes(1)
  })

  it('backfill stops on empty lists', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValueOnce({ count: 10, lists: [] })
    const res = await h.svc.backfill({ limit: 2 })
    expect(h.tokenTransfers).toHaveBeenCalledTimes(1)
    expect(res.synced).toBe(0)
  })

  it('refreshLatest breaks on known txHash', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValue({ count: 10, lists: [t({ tx_hash: '0xnew' }), t({ tx_hash: '0xknown' })] })
    ;(h.existsByTxHash as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (hash: string) => hash === '0xknown')
    const res = await h.svc.refreshLatest({ limit: 15 })
    expect(h.upsertFromApi).toHaveBeenCalledTimes(1)
    expect(res.synced).toBe(1)
  })

  it('inline: 200 sets buyerUsername via upsert', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValue({ count: 1, lists: [t({ tx_hash: '0xa', token_id: '4949' })] })
    h.detailStrict.mockResolvedValue({ ownerName: 'herwan' })
    const res = await h.svc.refreshLatest({ limit: 15 })
    expect(h.detailStrict).toHaveBeenCalledWith(4949, 'GhostMGlobal')
    expect(h.upsertFromApi).toHaveBeenCalledWith(
      expect.objectContaining({ buyerUsername: 'herwan', claimed: false })
    )
    expect(res).toEqual(expect.objectContaining({ synced: 1, enriched: 1, claimed: 0 }))
  })

  it('inline: 400 creates transfer as claimed', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValue({ count: 1, lists: [t({ tx_hash: '0xb', token_id: '4950' })] })
    h.detailStrict.mockRejectedValue({ response: { status: 400 } })
    const res = await h.svc.refreshLatest({ limit: 15 })
    expect(h.upsertFromApi).toHaveBeenCalledWith(
      expect.objectContaining({ buyerUsername: null, claimed: true })
    )
    expect(res).toEqual(expect.objectContaining({ synced: 1, enriched: 0, claimed: 1 }))
  })

  it('inline: 500 leaves unclaimed for retry', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValue({ count: 1, lists: [t({ tx_hash: '0xc', token_id: '4951' })] })
    h.detailStrict.mockRejectedValue({ response: { status: 500 } })
    const res = await h.svc.refreshLatest({ limit: 15 })
    expect(h.upsertFromApi).toHaveBeenCalledWith(
      expect.objectContaining({ buyerUsername: null, claimed: false })
    )
    expect(res).toEqual(expect.objectContaining({ synced: 1, enriched: 0, claimed: 0 }))
  })

  it('backfill skips non-GhostMGlobal rows without detail calls', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValueOnce({
      count: 3,
      lists: [t({ tx_hash: '0x1' }), t({ tx_hash: '0x2', game_name: 'OtherGame' }), t({ tx_hash: '0x3', game_name: '' })]
    })
    const res = await h.svc.backfill({ limit: 3 })
    expect(h.upsertFromApi).toHaveBeenCalledTimes(1)
    expect(h.upsertFromApi).toHaveBeenCalledWith(expect.objectContaining({ txHash: '0x1' }))
    expect(h.detailStrict).toHaveBeenCalledTimes(1)
    expect(res).toEqual(expect.objectContaining({ synced: 1, skipped: 2 }))
  })

  it('refreshLatest skips foreign rows without breaking past newer Ghost rows', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValue({
      count: 10,
      lists: [t({ tx_hash: '0xforeign', game_name: 'OtherGame' }), t({ tx_hash: '0xnew' }), t({ tx_hash: '0xknown' })]
    })
    ;(h.existsByTxHash as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (hash: string) => hash === '0xknown')
    const res = await h.svc.refreshLatest({ limit: 15 })
    expect(h.upsertFromApi).toHaveBeenCalledTimes(1)
    expect(h.upsertFromApi).toHaveBeenCalledWith(expect.objectContaining({ txHash: '0xnew' }))
    expect(h.existsByTxHash).not.toHaveBeenCalledWith('0xforeign')
    expect(res).toEqual(expect.objectContaining({ synced: 1, skipped: 1 }))
  })

  it('backfill defaults to limit 150', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValueOnce({ count: 1, lists: [t({ tx_hash: '0x1' })] })
    await h.svc.backfill()
    expect(h.tokenTransfers).toHaveBeenCalledWith({ limit: 150, offset: 0 })
  })

  it('refreshLatest defaults to limit 150', async () => {
    const h = createHarness()
    h.tokenTransfers.mockResolvedValueOnce({ count: 0, lists: [] })
    await h.svc.refreshLatest()
    expect(h.tokenTransfers).toHaveBeenCalledWith({ limit: 150, offset: 0 })
  })
})
