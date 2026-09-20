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

function createService(qbMock: QbMock) {
  const itemRepo = {
    createQueryBuilder: vi.fn(() => qbMock as unknown as never),
    findOne: vi.fn(),
    count: vi.fn(),
    find: vi.fn(),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => x),
  } as unknown as never
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

  const svc = new MarketplaceService(itemRepo as never, detailRepo as never, favoriteRepo as never)
  return { svc, itemRepo, qbMock, favoriteRepo }
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
    expect(qb.where).not.toHaveBeenCalled()
    expect(qb.andWhere).not.toHaveBeenCalled()
  })

  it('ignores empty string and whitespace', async () => {
    await svc.list({ equipment_type: '   ', grade_effect: '' })
    expect(qb.where).not.toHaveBeenCalled()
    expect(qb.andWhere).not.toHaveBeenCalled()
  })

  it('trims whitespace in array elements', async () => {
    await svc.list({ equipment_type: [' Weapon ', ' Armor '] })
    const call = qb._calls.find((c) => c.sql.includes('equipmentType IN'))
    expect((call!.params as Record<string, unknown>).equipmentType).toEqual(['Weapon', 'Armor'])
  })

  it('combines q search with equipment_type (andWhere) — LOWER search only name', async () => {
    await svc.list({ q: 'Ghost', equipment_type: 'Weapon' })
    expect(qb.where).toHaveBeenCalledTimes(1)
    expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('LOWER(item.name) LIKE LOWER(:q)'), expect.objectContaining({ q: '%Ghost%' }))
    // should NOT search ownerName — search only item name
    expect(qb._calls.some((c) => c.sql.includes('ownerName'))).toBe(false)
    expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('equipmentType'), expect.any(Object))
  })

  it('combines q + grade_effect + equipment_type all as andWhere chain', async () => {
    await svc.list({ q: 'Blade', equipment_type: ['Weapon'], grade_effect: ['Rare'] })
    expect(qb.where).toHaveBeenCalledTimes(1)
    expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('LOWER(item.name)'), expect.any(Object))
    expect(qb.andWhere).toHaveBeenCalledTimes(2)
  })

  it('ensures q alone uses LOWER on name only without ownerName or Brackets', async () => {
    await svc.list({ q: 'Ghost' })
    expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('LOWER(item.name) LIKE LOWER(:q)'), expect.objectContaining({ q: '%Ghost%' }))
    expect(qb._calls.some((c) => c.sql.includes('ownerName'))).toBe(false)
    expect(qb._calls.some((c) => c.sql.includes('Brackets'))).toBe(false)
    // only one LIKE (name)
    expect(qb._calls.filter((c) => c.sql.includes('LIKE')).length).toBe(1)
  })

  it('q search is case-insensitive via LOWER (ILIKE)', async () => {
    await svc.list({ q: 'gHoSt' })
    expect(qb.where).toHaveBeenCalledWith(expect.stringContaining('LOWER(item.name) LIKE LOWER(:q)'), expect.objectContaining({ q: '%gHoSt%' }))
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
    expect(qb.where).not.toHaveBeenCalled()
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
