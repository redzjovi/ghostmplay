import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { MarketplaceService } from './marketplace.service'

/**
 * Favorites are per-account. The accountId scope is the security boundary here:
 * every lookup must include it, otherwise one user can read, rename or delete
 * another user's saved searches by guessing an id.
 */
function createFavoriteService(overrides: Partial<Record<string, unknown>> = {}) {
  const favoriteRepo = {
    find: vi.fn(async () => []),
    findOne: vi.fn(async () => null),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => ({ ...x, id: 7, createdAt: new Date(), updatedAt: new Date() })),
    delete: vi.fn(async () => ({ affected: 1 })),
    ...overrides,
  } as unknown as Record<string, ReturnType<typeof vi.fn>>

  const empty = { findOne: vi.fn(), create: vi.fn((x) => x), save: vi.fn(async (x) => x) } as never
  const svc = new MarketplaceService(empty, empty, favoriteRepo as never)
  return { svc, favoriteRepo }
}

const ALICE = 101
const BOB = 202

describe('MarketplaceService favorites — per-account scoping', () => {
  let svc: MarketplaceService
  let favoriteRepo: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    const made = createFavoriteService()
    svc = made.svc
    favoriteRepo = made.favoriteRepo
  })

  it('listFavorites only ever queries the caller’s own rows', async () => {
    await svc.listFavorites(ALICE)
    expect(favoriteRepo.find).toHaveBeenCalledWith({ where: { accountId: ALICE }, order: { name: 'ASC' } })
  })

  it('createFavorite stamps the owner onto the new row', async () => {
    await svc.createFavorite(ALICE, { name: 'Swords', equipmentTypes: ['Weapon'] })
    expect(favoriteRepo.create).toHaveBeenCalledWith(expect.objectContaining({ accountId: ALICE, name: 'Swords' }))
  })

  it('createFavorite normalises comma-joined and array filters alike', async () => {
    await svc.createFavorite(ALICE, { name: 'Mixed', equipment_type: 'Weapon, Armor', grade_effect: 'Rare' })
    expect(favoriteRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ equipmentTypes: ['Weapon', 'Armor'], gradeEffects: ['Rare'] })
    )
  })

  it('createFavorite rejects a duplicate name for the same account', async () => {
    favoriteRepo.findOne.mockResolvedValueOnce({ id: 1, name: 'Swords' } as never)
    await expect(svc.createFavorite(ALICE, { name: 'Swords' })).rejects.toBeInstanceOf(ConflictException)
  })

  it('createFavorite validates the name', async () => {
    await expect(svc.createFavorite(ALICE, { name: '   ' })).rejects.toBeInstanceOf(BadRequestException)
    await expect(svc.createFavorite(ALICE, { name: 'x'.repeat(51) })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('createFavorite maps a unique-violation from the DB onto a 409', async () => {
    favoriteRepo.save.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }) as never)
    await expect(svc.createFavorite(ALICE, { name: 'Swords' })).rejects.toBeInstanceOf(ConflictException)
  })

  it('updateFavorite looks the row up by both id and account', async () => {
    await svc.updateFavorite(ALICE, 7, { name: 'Blades' }).catch(() => undefined)
    expect(favoriteRepo.findOne).toHaveBeenCalledWith({ where: { id: 7, accountId: ALICE } })
  })

  it('updateFavorite throws 404 when the row belongs to someone else', async () => {
    favoriteRepo.findOne.mockResolvedValueOnce(null as never)
    await expect(svc.updateFavorite(BOB, 7, { name: 'hijack' })).rejects.toBeInstanceOf(NotFoundException)
  })

  it('updateFavorite only overwrites the fields actually sent', async () => {
    const existing = {
      id: 7,
      accountId: ALICE,
      name: 'Swords',
      q: 'blade',
      equipmentTypes: ['Weapon'],
      gradeEffects: ['Rare'],
      sort: 'price_asc',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    favoriteRepo.findOne.mockResolvedValueOnce(existing as never)

    await svc.updateFavorite(ALICE, 7, { name: 'Blades' })
    const saved = favoriteRepo.save.mock.calls[0][0] as typeof existing
    expect(saved.name).toBe('Blades')
    // A rename must not wipe the saved filters.
    expect(saved.equipmentTypes).toEqual(['Weapon'])
    expect(saved.gradeEffects).toEqual(['Rare'])
    expect(saved.sort).toBe('price_asc')
    expect(saved.q).toBe('blade')
  })

  it('updateFavorite clears q when it is explicitly sent as null', async () => {
    const existing = {
      id: 7,
      accountId: ALICE,
      name: 'Swords',
      q: 'blade',
      equipmentTypes: ['Weapon'],
      gradeEffects: ['Rare'],
      sort: 'price_asc',
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    favoriteRepo.findOne.mockResolvedValueOnce(existing as never)

    await svc.updateFavorite(ALICE, 7, { q: null })
    const saved = favoriteRepo.save.mock.calls[0][0] as typeof existing
    expect(saved.q).toBeNull()
    expect(saved.equipmentTypes).toEqual(['Weapon'])
  })

  it('updateFavorite rejects a rename that collides within the same account', async () => {
    favoriteRepo.findOne
      .mockResolvedValueOnce({ id: 7, accountId: ALICE, name: 'Swords' } as never)
      .mockResolvedValueOnce({ id: 8, accountId: ALICE, name: 'Blades' } as never)
    await expect(svc.updateFavorite(ALICE, 7, { name: 'Blades' })).rejects.toBeInstanceOf(ConflictException)
  })

  it('deleteFavorite scopes the delete and reports a miss', async () => {
    await svc.deleteFavorite(ALICE, 7)
    expect(favoriteRepo.delete).toHaveBeenCalledWith({ id: 7, accountId: ALICE })

    favoriteRepo.delete.mockResolvedValueOnce({ affected: 0 } as never)
    await expect(svc.deleteFavorite(BOB, 7)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('getFavorite scopes the lookup and 404s for other users', async () => {
    favoriteRepo.findOne.mockResolvedValueOnce(null as never)
    await expect(svc.getFavorite(BOB, 7)).rejects.toBeInstanceOf(NotFoundException)
    expect(favoriteRepo.findOne).toHaveBeenCalledWith({ where: { id: 7, accountId: BOB } })
  })

  it('getFavorite serialises timestamps as ISO strings', async () => {
    const created = new Date('2026-01-02T03:04:05.000Z')
    favoriteRepo.findOne.mockResolvedValueOnce({
      id: 7,
      accountId: ALICE,
      name: 'Swords',
      q: null,
      equipmentTypes: null,
      gradeEffects: null,
      sort: 'recent',
      createdAt: created,
      updatedAt: created,
    } as never)

    const dto = await svc.getFavorite(ALICE, 7)
    expect(dto.createdAt).toBe('2026-01-02T03:04:05.000Z')
    // Null JSON columns come back as empty arrays, which is what the client expects.
    expect(dto.equipmentTypes).toEqual([])
    expect(dto.gradeEffects).toEqual([])
  })
})
