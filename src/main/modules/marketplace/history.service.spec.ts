import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HistoryService } from './history.service'

function createQbMock(): any {
  const calls: Array<{ method: string; sql: string; params: unknown }> = []
  const qb: any = {
    _calls: calls,
    where: vi.fn((sql: string, params?: unknown) => { calls.push({ method: 'where', sql, params }); return qb }),
    andWhere: vi.fn((sql: string, params?: unknown) => { calls.push({ method: 'andWhere', sql, params }); return qb }),
    orderBy: vi.fn(() => qb),
    skip: vi.fn(() => qb),
    take: vi.fn(() => qb),
    leftJoin: vi.fn(() => qb),
    innerJoin: vi.fn(() => qb),
    select: vi.fn(() => qb),
    addSelect: vi.fn(() => qb),
    getManyAndCount: vi.fn(async () => [[], 0] as [unknown[], number]),
    getRawMany: vi.fn(async () => [])
  }
  return qb
}

function createService(qb: any) {
  const transferRepo = {
    createQueryBuilder: vi.fn(() => qb as never),
    findOne: vi.fn(),
    find: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => x),
    update: vi.fn(async () => {})
  }
  const userRepo = {
    findOne: vi.fn(async () => null),
    find: vi.fn(async () => []),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => x),
    update: vi.fn(async () => {})
  }
  const svc = new HistoryService(transferRepo as never, userRepo as never)
  return { svc, transferRepo, userRepo }
}

describe('HistoryService.list', () => {
  let qb: any
  let svc: HistoryService

  beforeEach(() => {
    qb = createQbMock()
    svc = createService(qb).svc
  })

  it('filters by seller address/username', async () => {
    await svc.list({ seller: '0xabc' })
    const calls = qb._calls as Array<{ sql: string; params: Record<string, unknown> }>
    expect(calls.some((c) => c.sql.includes('sellerId') && (c.params as Record<string, unknown>).seller === '%0xabc%')).toBe(true)
  })

  it('filters by buyer', async () => {
    await svc.list({ buyer: '0xdef' })
    const calls = qb._calls as Array<{ sql: string }>
    expect(calls.some((c) => c.sql.includes('buyerId'))).toBe(true)
  })

  it('filters by itemName and q alias', async () => {
    await svc.list({ itemName: 'Gold Box' })
    expect((qb._calls as Array<{ sql: string }>).some((c) => c.sql.includes('itemName'))).toBe(true)
    ;(qb._calls as unknown[]).length = 0
    await svc.list({ q: 'Gold' })
    expect((qb._calls as Array<{ sql: string }>).some((c) => c.sql.includes('itemName'))).toBe(true)
  })

  it('filters by price range', async () => {
    await svc.list({ priceMin: 100, priceMax: 500 })
    const calls = qb._calls as Array<{ sql: string }>
    expect(calls.some((c) => c.sql.includes('price >= :priceMin'))).toBe(true)
    expect(calls.some((c) => c.sql.includes('price <= :priceMax'))).toBe(true)
  })

  it('filters by created range and claimed', async () => {
    await svc.list({ createdFrom: '2026-09-01', createdTo: '2026-09-30', claimed: true })
    const calls = qb._calls as Array<{ sql: string; params: Record<string, unknown> }>
    const fromCall = calls.find((c) => c.sql.includes('t.createdAt >= :createdFrom'))
    expect(fromCall).toBeDefined()
    expect((fromCall!.params as Record<string, unknown>).createdFrom).toEqual(new Date('2026-09-01T00:00:00Z'))
    const toCall = calls.find((c) => c.sql.includes('t.createdAt < :createdTo'))
    expect(toCall).toBeDefined()
    expect((toCall!.params as Record<string, unknown>).createdTo).toEqual(new Date('2026-10-01T00:00:00Z'))
    expect(calls.some((c) => c.sql.includes('claimed'))).toBe(true)
  })

  it('ignores malformed created dates', async () => {
    await svc.list({ createdFrom: 'not-a-date', createdTo: '2026-13-99' })
    const calls = qb._calls as Array<{ sql: string }>
    expect(calls.some((c) => c.sql.includes('createdAt'))).toBe(false)
  })

  it('sorting and pagination', async () => {
    const res = await svc.list({ sort: 'price_asc', page: 0, limit: 200 })
    expect(res.page).toBe(1)
    expect(res.limit).toBe(100)
    expect(qb.orderBy).toHaveBeenCalledWith('t.price', 'ASC')
  })

  it('defaults to createdAt DESC', async () => {
    await svc.list({})
    expect(qb.orderBy).toHaveBeenCalledWith('t.createdAt', 'DESC')
  })

  it('recent sorts like created_at_desc (marketplace parity)', async () => {
    await svc.list({ sort: 'recent' })
    expect(qb.orderBy).toHaveBeenCalledWith('t.createdAt', 'DESC')
  })

  it('filters by sellerName and buyerName exact match on joined users', async () => {
    await svc.list({ sellerName: 'herwan', buyerName: 'alice' })
    const calls = qb._calls as Array<{ sql: string; params: Record<string, unknown> }>
    expect(calls.some((c) => c.sql.includes('su.username = :sellerName') && c.params.sellerName === 'herwan')).toBe(true)
    expect(calls.some((c) => c.sql.includes('bu.username = :buyerName') && c.params.buyerName === 'alice')).toBe(true)
  })

  it('filters by tokenId exact match', async () => {
    await svc.list({ tokenId: 4949 })
    const calls = qb._calls as Array<{ sql: string; params: Record<string, unknown> }>
    expect(calls.some((c) => c.sql.includes('t.tokenId = :tokenId') && c.params.tokenId === 4949)).toBe(true)
  })

  it('ignores non-numeric tokenId', async () => {
    await svc.list({ tokenId: 'abc' })
    const calls = qb._calls as Array<{ sql: string }>
    expect(calls.some((c) => c.sql.includes('tokenId'))).toBe(false)
  })

  it('filters by txHash substring', async () => {
    await svc.list({ txHash: '0xabc' })
    const calls = qb._calls as Array<{ sql: string; params: Record<string, unknown> }>
    expect(calls.some((c) => c.sql.includes('LOWER(t.txHash)') && c.params.txHash === '%0xabc%')).toBe(true)
  })
})

describe('HistoryService distinct helpers', () => {
  it('getDistinctGameNames queries DISTINCT gameName sorted ASC', async () => {
    const qb = createQbMock()
    qb.getRawMany.mockResolvedValue([{ gameName: 'GhostMGlobal' }, { gameName: '' }, { gameName: null }])
    const { svc } = createService(qb)
    const res = await svc.getDistinctGameNames()
    expect(res).toEqual(['GhostMGlobal'])
    expect(qb.select).toHaveBeenCalledWith('DISTINCT t.gameName', 'gameName')
    expect(qb.orderBy).toHaveBeenCalledWith('t.gameName', 'ASC')
  })

  it('getDistinctSellerNames joins seller users', async () => {
    const qb = createQbMock()
    qb.getRawMany.mockResolvedValue([{ username: 'herwan' }, { username: 'bob' }])
    const { svc } = createService(qb)
    const res = await svc.getDistinctSellerNames()
    expect(res).toEqual(['herwan', 'bob'])
    expect(qb.select).toHaveBeenCalledWith('DISTINCT su.username', 'username')
    expect(qb.innerJoin).toHaveBeenCalled()
  })

  it('getDistinctBuyerNames joins buyer users', async () => {
    const qb = createQbMock()
    qb.getRawMany.mockResolvedValue([{ username: 'alice' }])
    const { svc } = createService(qb)
    const res = await svc.getDistinctBuyerNames()
    expect(res).toEqual(['alice'])
    expect(qb.select).toHaveBeenCalledWith('DISTINCT bu.username', 'username')
  })

  it('getDistinctHistoryFilters aggregates all three', async () => {
    const qb = createQbMock()
    let call = 0
    qb.getRawMany.mockImplementation(async () => {
      call++
      if (call === 1) return [{ gameName: 'GhostMGlobal' }]
      if (call === 2) return [{ username: 'herwan' }]
      return [{ username: 'alice' }]
    })
    const { svc } = createService(qb)
    const res = await svc.getDistinctHistoryFilters()
    expect(res).toEqual({ gameNames: ['GhostMGlobal'], sellerNames: ['herwan'], buyerNames: ['alice'] })
  })
})

describe('HistoryService.upsertFromApi', () => {
  const base = {
    tokenId: 4949,
    gameName: 'GhostMGlobal',
    sellerId: '0xSeller',
    buyerId: '0xBuyer',
    itemName: 'Gold Box',
    price: 148,
    txHash: '0xhash',
    createdAt: new Date('2026-09-25T01:45:59.000Z')
  }

  it('creates transfer with claimed flag and updates buyer username inline', async () => {
    const qb = createQbMock()
    const { svc, transferRepo, userRepo } = createService(qb)
    transferRepo.findOne.mockResolvedValue(null)
    await svc.upsertFromApi({ ...base, buyerUsername: 'herwan', claimed: false })
    expect(userRepo.update).toHaveBeenCalledWith({ id: '0xbuyer' }, { username: 'herwan' })
    expect(transferRepo.create).toHaveBeenCalledWith(expect.objectContaining({ claimed: false, gameName: 'GhostMGlobal' }))
    expect(transferRepo.save).toHaveBeenCalled()
  })

  it('creates 400-row as claimed without username update', async () => {
    const qb = createQbMock()
    const { svc, transferRepo, userRepo } = createService(qb)
    transferRepo.findOne.mockResolvedValue(null)
    await svc.upsertFromApi({ ...base, buyerUsername: null, claimed: true })
    expect(userRepo.update).not.toHaveBeenCalled()
    expect(transferRepo.create).toHaveBeenCalledWith(expect.objectContaining({ claimed: true }))
  })

  it('updates existing row gameName but preserves claimed unless explicitly passed', async () => {
    const qb = createQbMock()
    const { svc, transferRepo } = createService(qb)
    transferRepo.findOne.mockResolvedValue({ txHash: '0xhash', claimed: true, currency: 'NUMI' })
    await svc.upsertFromApi({ ...base, gameName: 'GhostMGlobal' })
    const saved = transferRepo.save.mock.calls[0][0]
    expect(saved.gameName).toBe('GhostMGlobal')
    expect(saved.claimed).toBe(true)
  })
})
