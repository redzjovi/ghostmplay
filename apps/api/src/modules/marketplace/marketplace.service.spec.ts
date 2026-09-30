import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MarketplaceService } from './marketplace.service'

// Mock QueryBuilder captures where/andWhere calls to verify camelCase property handling (column snake via @Column(name))
type QbMock = {
  where: ReturnType<typeof vi.fn>
  andWhere: ReturnType<typeof vi.fn>
  orderBy: ReturnType<typeof vi.fn>
  skip: ReturnType<typeof vi.fn>
  take: ReturnType<typeof vi.fn>
  getManyAndCount: ReturnType<typeof vi.fn>
  // distinct queries
  select: ReturnType<typeof vi.fn>
  getRawMany: ReturnType<typeof vi.fn>
  // internal state
  _calls: Array<{ method: string; sql: string; params: unknown }>
}

function createQbMock(): QbMock {
  const calls: QbMock['_calls'] = []
  const qb: QbMock = {
    _calls: calls,
    where: vi.fn((sql: string, params?: unknown) => {
      calls.push({ method: 'where', sql, params })
      return qb as unknown as never
    }),
    andWhere: vi.fn((sql: string, params?: unknown) => {
      calls.push({ method: 'andWhere', sql, params })
      return qb as unknown as never
    }),
    orderBy: vi.fn(() => qb as unknown as never),
    skip: vi.fn(() => qb as unknown as never),
    take: vi.fn(() => qb as unknown as never),
    getManyAndCount: vi.fn(async () => [[], 0] as [unknown[], number]),
    select: vi.fn(() => qb as unknown as never),
    getRawMany: vi.fn(async () => []),
  }
  return qb
}

/** The live-listings predicate that opens every list query. */
const LIVE_ONLY = 'item.soldAt IS NULL'

// The list query always opens with LIVE_ONLY, so assertions about caller-supplied
// filters have to look past it — and since it owns the only `where`, everything
// else is necessarily an `andWhere` now.
function userAndWhere(qb: QbMock) {
  return qb._calls.filter((c) => c.method === 'andWhere' && !c.sql.includes('soldAt'))
}

type ItemRepoMock = {
  createQueryBuilder: ReturnType<typeof vi.fn>
  findOne: ReturnType<typeof vi.fn>
  count: ReturnType<typeof vi.fn>
  find: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  /** Only clearAll() reaches for it, to run the count and the delete atomically. */
  manager: { transaction: ReturnType<typeof vi.fn> }
}

function createService(qbMock: QbMock) {
  // clearAll() counts and deletes through one transaction on the repo's manager,
  // so the manager mock runs the callback and hands back its result.
  const deleteQb = {
    delete: vi.fn(() => deleteQb),
    from: vi.fn(() => deleteQb),
    execute: vi.fn(async () => ({ affected: 519 }))
  }
  const manager = {
    transaction: vi.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({ count: vi.fn(async () => 488), createQueryBuilder: () => deleteQb })
    ),
  }

  const itemRepo: ItemRepoMock = {
    createQueryBuilder: vi.fn(() => qbMock as unknown as never),
    findOne: vi.fn(),
    count: vi.fn(),
    find: vi.fn(),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => x),
    query: vi.fn(async () => []),
    manager,
  }
  const detailRepo = {
    findOne: vi.fn(),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => x),
  } as unknown as never
  const favoriteRepo = {
    find: vi.fn(async () => []),
    findOne: vi.fn(async () => null),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => ({ ...x, id: 1, createdAt: new Date(), updatedAt: new Date() })),
    remove: vi.fn(async () => {}),
  } as unknown as never

  const svc = new MarketplaceService(itemRepo as never, detailRepo, favoriteRepo)
  return { svc, itemRepo, qbMock, favoriteRepo, manager, deleteQb }
}

describe('MarketplaceService.list — equipment_type & grade_effect (column snake, property camel)', () => {
  let qb: QbMock
  let svc: MarketplaceService

  beforeEach(() => {
    qb = createQbMock()
    svc = createService(qb).svc
  })

  it('filters by single equipment_type (snake query, camel property)', async () => {
    await svc.list({ equipment_type: 'Weapon' })
    expect(qb._calls.some((c) => c.sql.includes('item.equipmentType = :equipmentType') && (c.params as Record<string, unknown>).equipmentType === 'Weapon')).toBe(true)
  })

  it('filters by multiple equipment_type (array)', async () => {
    await svc.list({ equipment_type: ['Weapon', 'Armor'] })
    const call = qb._calls.find((c) => c.sql.includes('item.equipmentType IN'))
    expect(call).toBeDefined()
    expect((call!.params as Record<string, unknown>).equipmentType).toEqual(['Weapon', 'Armor'])
  })

  it('filters by single grade_effect (snake query, camel property)', async () => {
    await svc.list({ grade_effect: 'Rare' })
    expect(qb._calls.some((c) => c.sql.includes('item.gradeEffect = :gradeEffect') && (c.params as Record<string, unknown>).gradeEffect === 'Rare')).toBe(true)
  })

  it('filters by multiple grade_effect (array)', async () => {
    await svc.list({ grade_effect: ['Rare', 'Legacy'] })
    const call = qb._calls.find((c) => c.sql.includes('item.gradeEffect IN'))
    expect(call).toBeDefined()
    expect((call!.params as Record<string, unknown>).gradeEffect).toEqual(['Rare', 'Legacy'])
  })

  it('filters by both equipment_type and grade_effect together (multiple each)', async () => {
    await svc.list({ equipment_type: ['Weapon', 'Accessory'], grade_effect: ['Normal', 'Rare'] })
    const eqCall = qb._calls.find((c) => c.sql.includes('equipmentType'))
    const geCall = qb._calls.find((c) => c.sql.includes('gradeEffect'))
    expect(eqCall?.sql).toContain('IN')
    expect(geCall?.sql).toContain('IN')
    // second filter should be andWhere since hasWhere already true
    expect(qb.andWhere).toHaveBeenCalled()
  })

  it('handles comma-separated string for equipment_type', async () => {
    await svc.list({ equipment_type: 'Weapon, Armor, Accessory' })
    const call = qb._calls.find((c) => c.sql.includes('equipmentType IN'))
    expect(call).toBeDefined()
    expect((call!.params as Record<string, unknown>).equipmentType).toEqual(['Weapon', 'Armor', 'Accessory'])
  })

  it('handles comma-separated string for grade_effect', async () => {
    await svc.list({ grade_effect: 'Rare,Legacy' })
    const call = qb._calls.find((c) => c.sql.includes('gradeEffect IN'))
    expect(call).toBeDefined()
    expect((call!.params as Record<string, unknown>).gradeEffect).toEqual(['Rare', 'Legacy'])
  })

  it('supports camelCase alias (backward compat) for equipmentType', async () => {
    await svc.list({ equipmentType: 'Weapon' } as never)
    expect(qb._calls.some((c) => c.sql.includes('equipmentType') )).toBe(true)
  })

  it('supports camelCase alias for gradeEffect', async () => {
    await svc.list({ gradeEffect: ['Rare'] } as never)
    expect(qb._calls.some((c) => c.sql.includes('gradeEffect') )).toBe(true)
  })

  it('snake_case takes precedence over camelCase alias', async () => {
    await svc.list({ equipment_type: 'Armor', equipmentType: 'Weapon' } as never)
    const call = qb._calls.find((c) => c.sql.includes('equipmentType'))
    expect((call!.params as Record<string, unknown>).equipmentType).toBe('Armor')
  })

  it('ignores empty array (no filter)', async () => {
    await svc.list({ equipment_type: [] })
    expect(userAndWhere(qb)).toHaveLength(0)
  })

  it('ignores empty string and whitespace', async () => {
    await svc.list({ equipment_type: '   ', grade_effect: '' })
    expect(userAndWhere(qb)).toHaveLength(0)
  })

  it('trims whitespace in array elements', async () => {
    await svc.list({ equipment_type: [' Weapon ', ' Armor '] })
    const call = qb._calls.find((c) => c.sql.includes('equipmentType IN'))
    expect((call!.params as Record<string, unknown>).equipmentType).toEqual(['Weapon', 'Armor'])
  })

  it('combines q search with equipment_type (andWhere) — LOWER search only name', async () => {
    await svc.list({ q: 'Ghost', equipment_type: 'Weapon' })
    const added = userAndWhere(qb)
    expect(added).toHaveLength(2)
    expect(added[0].sql).toContain('LOWER(item.name) LIKE LOWER(:q)')
    // should NOT search ownerName — search only item name
    expect(qb._calls.some((c) => c.sql.includes('ownerName'))).toBe(false)
    expect(added.some((c) => c.sql.includes('equipmentType'))).toBe(true)
  })

  it('combines q + grade_effect + equipment_type all as andWhere chain', async () => {
    await svc.list({ q: 'Blade', equipment_type: ['Weapon'], grade_effect: ['Rare'] })
    const added = userAndWhere(qb)
    expect(added).toHaveLength(3)
    expect(added[0].sql).toContain('LOWER(item.name)')
  })

  it('ensures q alone uses LOWER on name only without ownerName or Brackets', async () => {
    await svc.list({ q: 'Ghost' })
    const call = qb._calls.find((c) => c.sql.includes('LOWER(item.name) LIKE LOWER(:q)'))
    expect(call).toBeDefined()
    expect(qb._calls.some((c) => c.sql.includes('ownerName'))).toBe(false)
    expect(qb._calls.some((c) => c.sql.includes('Brackets'))).toBe(false)
    // only one LIKE (name)
    expect(qb._calls.filter((c) => c.sql.includes('LIKE')).length).toBe(1)
  })

  it('q search is case-insensitive via LOWER (ILIKE)', async () => {
    await svc.list({ q: 'gHoSt' })
    // verify param preserves original case for LOWER() to handle
    const call = qb._calls.find((c) => c.sql.includes('LOWER(item.name)'))
    expect((call!.params as Record<string, unknown>).q).toBe('%gHoSt%')
  })

  it('handles level filter alongside snake_case filters', async () => {
    await svc.list({ equipment_type: 'Weapon', grade_effect: 'Rare', level: 65 })
    expect(qb._calls.some((c) => c.sql.includes('level'))).toBe(true)
  })

  it('pagination defaults and limits', async () => {
    const res = await svc.list({ equipment_type: 'Weapon', page: 0, limit: 200 })
    expect(res.page).toBe(1)
    expect(res.limit).toBe(100) // capped
    expect(qb.skip).toHaveBeenCalledWith(0)
    expect(qb.take).toHaveBeenCalledWith(100)
  })

  it('sorting price_asc / price_desc / recent', async () => {
    await svc.list({ sort: 'price_asc' })
    expect(qb.orderBy).toHaveBeenCalledWith('item.price', 'ASC')
    qb.orderBy.mockClear()
    await svc.list({ sort: 'price_desc' })
    expect(qb.orderBy).toHaveBeenCalledWith('item.price', 'DESC')
    qb.orderBy.mockClear()
    await svc.list({ sort: 'recent' })
    expect(qb.orderBy).toHaveBeenCalledWith('item.createdAt', 'DESC')
  })

  it('ignores whitespace-only comma string', async () => {
    await svc.list({ equipment_type: ' , , ' })
    expect(userAndWhere(qb)).toHaveLength(0)
  })
})

describe('MarketplaceService sold state', () => {
  let qb: QbMock
  let svc: MarketplaceService
  let itemRepo: ItemRepoMock

  beforeEach(() => {
    qb = createQbMock()
    const h = createService(qb)
    svc = h.svc
    itemRepo = h.itemRepo
  })

  const raw = (over: Record<string, unknown> = {}) => ({
    id: 7,
    tokenId: 4949,
    sellerId: '0xSeller',
    sellerName: null,
    imageUrl: 'QmX',
    name: 'Test',
    price: 148,
    gradeEffect: 'Normal',
    level: 0,
    enchant: 0,
    equipmentType: 'Weapon',
    createdAt: new Date('2026-09-20T00:06:31Z'),
    ...over
  })

  describe('list filtering', () => {
    it('excludes sold items with a single leading where()', async () => {
      await svc.list({})
      // First, because TypeORM's where() resets the clause and drops andWheres.
      expect(qb._calls[0].method).toBe('where')
      expect(qb._calls[0].sql).toBe(LIVE_ONLY)
    })

    it('keeps the sold predicate when a search term is supplied', async () => {
      // The regression this guards: q used to call where(), which would have
      // reset the clause and let sold items back into the results.
      await svc.list({ q: 'Ghost' })
      expect(qb._calls[0].sql).toBe(LIVE_ONLY)
      expect(qb._calls.some((c) => c.sql.includes('LOWER(item.name)'))).toBe(true)
    })

    it('keeps the sold predicate alongside every filter kind', async () => {
      await svc.list({ q: 'Ghost', equipment_type: 'Weapon', grade_effect: 'Rare', level: 65 })
      expect(qb._calls.filter((c) => c.sql === LIVE_ONLY)).toHaveLength(1)
      expect(userAndWhere(qb)).toHaveLength(4)
    })

    it('never emits a second where() that could reset the clause', async () => {
      await svc.list({ q: 'Ghost', equipment_type: 'Weapon', grade_effect: 'Rare', level: 65 })
      expect(qb._calls.filter((c) => c.method === 'where')).toHaveLength(1)
    })
  })

  describe('getDistinct* filtering', () => {
    it('scopes equipment types to live items', async () => {
      await svc.getDistinctEquipmentTypes()
      expect(qb.andWhere).toHaveBeenCalledWith(LIVE_ONLY)
    })

    it('scopes grade effects to live items', async () => {
      await svc.getDistinctGradeEffects()
      expect(qb.andWhere).toHaveBeenCalledWith(LIVE_ONLY)
    })
  })

  describe('getByTokenId', () => {
    it('still returns sold items so deep links resolve', async () => {
      const sold = { id: 7, tokenId: 4949, soldAt: new Date('2026-09-25T01:45:59Z'), soldPrice: 148 }
      itemRepo.findOne.mockResolvedValueOnce(sold)
      const res = await svc.getByTokenId(4949)
      expect(res?.item).toBe(sold)
      // No sold filter here: a sold item must render as "sold out", not 404.
      expect(itemRepo.findOne).toHaveBeenCalledWith({ where: { tokenId: 4949 } })
    })
  })

  describe('markItemsSold', () => {
    it('joins the transfer ledger table-wide, not by a fetched token scope', async () => {
      itemRepo.query.mockResolvedValue([{ id: 1 }, { id: 2 }])
      const marked = await svc.markItemsSold()
      expect(marked).toBe(2)
      const sql = String(itemRepo.query.mock.calls[0][0])
      expect(sql).toContain('marketplace_token_transfers')
      expect(sql).toContain('i."sold_at" IS NULL')
      expect(sql).toContain('RETURNING')
      // No token scope: refreshLatest stops at the first known tx_hash, so a
      // scoped update would never revisit a transfer it had already fetched.
      expect(sql).not.toMatch(/ANY\s*\(|=\s*\$\d/)
    })

    it('ignores zero-value transfers, which are not sales', async () => {
      await svc.markItemsSold()
      const sql = String(itemRepo.query.mock.calls[0][0])
      expect(sql).toContain('"price" > 0')
    })

    it('requires the sale to postdate the listing, so a relist survives', async () => {
      // A relisted token keeps its token_id, so its previous sale is still in the
      // ledger. Without this guard the next run re-sells the new listing using a
      // transfer that predates it, and sold_at ends up earlier than created_at.
      await svc.markItemsSold()
      const sql = String(itemRepo.query.mock.calls[0][0])
      expect(sql).toContain('t."created_at" >= i."created_at"')
    })

    it('reports zero when nothing changed', async () => {
      itemRepo.query.mockResolvedValue([])
      expect(await svc.markItemsSold()).toBe(0)
    })
  })

  describe('upsertFromApi', () => {
    it('inserts a new listing as live', async () => {
      itemRepo.findOne.mockResolvedValue(null)
      await svc.upsertFromApi(raw())
      const created = itemRepo.create.mock.calls[0][0]
      expect(created.soldAt).toBeNull()
      expect(created.soldPrice).toBeNull()
    })

    it('clears sold state when a relisted item reappears under a new id', async () => {
      // The unique index is on token_id. A relist arrives as a new item_id for
      // the same token, so looking up by id alone would fall through to an
      // insert and throw 23505.
      const existing = { id: 7, tokenId: 4949, soldAt: new Date('2026-09-25T01:45:59Z'), soldPrice: 148 }
      itemRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing)
      await svc.upsertFromApi(raw({ id: 8, tokenId: 4949 }))
      expect(itemRepo.findOne).toHaveBeenCalledTimes(2)
      expect(itemRepo.findOne.mock.calls[1][0]).toEqual({ where: { tokenId: 4949 } })
      expect(itemRepo.save.mock.calls[0][0].soldAt).toBeNull()
    })

    it('keeps sold state on a plain re-scrape of a sold item', async () => {
      const soldAt = new Date('2026-09-25T01:45:59Z')
      itemRepo.findOne.mockResolvedValueOnce({ id: 7, tokenId: 4949, soldAt, soldPrice: 148 })
      await svc.upsertFromApi(raw())
      const saved = itemRepo.save.mock.calls[0][0]
      // A re-scrape happens on every sync; if it cleared sold state, each
      // marketplace run would resurrect the item until history caught up.
      expect(saved.soldAt).toBe(soldAt)
      expect(saved.soldPrice).toBe(148)
    })
  })
})

describe('MarketplaceService distinct helpers (column snake, property camel)', () => {
  it('getDistinctEquipmentTypes queries correct column and sorts ASC', async () => {
    const qb = createQbMock()
    qb.getRawMany.mockResolvedValue([{ equipmentType: 'Armor' }, { equipmentType: 'Weapon' }, { equipmentType: '' }])
    const { svc } = createService(qb)
    const res = await svc.getDistinctEquipmentTypes()
    expect(res).toEqual(['Armor', 'Weapon'])
    expect(qb.select).toHaveBeenCalledWith('DISTINCT item.equipmentType', 'equipmentType')
    expect(qb.orderBy).toHaveBeenCalledWith('item.equipmentType', 'ASC')
  })

  it('getDistinctGradeEffects queries correct column and sorts ASC', async () => {
    const qb = createQbMock()
    qb.getRawMany.mockResolvedValue([{ gradeEffect: 'Legacy' }, { gradeEffect: 'Rare' }])
    const { svc } = createService(qb)
    const res = await svc.getDistinctGradeEffects()
    expect(res).toEqual(['Legacy', 'Rare'])
    expect(qb.select).toHaveBeenCalledWith('DISTINCT item.gradeEffect', 'gradeEffect')
  })

  it('getDistinctFilters aggregates both', async () => {
    const qb = createQbMock()
    // Need two different QBs for each call; simplest: mock sequenced getRawMany
    let call = 0
    qb.getRawMany.mockImplementation(async () => {
      call++
      return call === 1 ? [{ equipmentType: 'Weapon' }] : [{ gradeEffect: 'Rare' }]
    })
    const { svc } = createService(qb)
    const res = await svc.getDistinctFilters()
    expect(res.equipmentTypes).toEqual(['Weapon'])
    expect(res.gradeEffects).toEqual(['Rare'])
  })
})

describe('MarketplaceService.clearAll', () => {
  it('deletes every item and reports both counts', async () => {
    const h = createService(createQbMock())
    const res = await h.svc.clearAll()
    expect(h.deleteQb.delete).toHaveBeenCalled()
    expect(h.deleteQb.from).toHaveBeenCalled()
    expect(res).toEqual({ items: 519, details: 488 })
  })

  it('counts and deletes inside one transaction, so the numbers match the rows', async () => {
    const h = createService(createQbMock())
    await h.svc.clearAll()
    expect(h.manager.transaction).toHaveBeenCalledTimes(1)
  })

  it('relies on the FK cascade rather than deleting details itself', async () => {
    // marketplace_item_detail is ON DELETE CASCADE, so a second statement would
    // only be redundant.
    const h = createService(createQbMock())
    await h.svc.clearAll()
    expect(h.deleteQb.from).toHaveBeenCalledTimes(1)
  })

  it('reports zero items when the table was already empty', async () => {
    const h = createService(createQbMock())
    h.deleteQb.execute.mockResolvedValue({ affected: 0 })
    expect(await h.svc.clearAll()).toEqual({ items: 0, details: 488 })
  })
})
