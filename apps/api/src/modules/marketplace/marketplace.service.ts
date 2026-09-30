import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { MarketplaceItemEntity } from './entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from './entities/marketplace-item-detail.entity'
import { MarketplaceFavoriteEntity } from './entities/marketplace-favorite.entity'
import type { MarketplaceListQuery, MarketplaceFavorite, CreateFavoriteInput, UpdateFavoriteInput } from '@ghostmplay/shared'

@Injectable()
export class MarketplaceService {
  constructor(
    @InjectRepository(MarketplaceItemEntity)
    private readonly itemRepo: Repository<MarketplaceItemEntity>,
    @InjectRepository(MarketplaceItemDetailEntity)
    private readonly detailRepo: Repository<MarketplaceItemDetailEntity>,
    @InjectRepository(MarketplaceFavoriteEntity)
    private readonly favoriteRepo: Repository<MarketplaceFavoriteEntity>
  ) {}

  async list(query: MarketplaceListQuery = {}) {
    const page = Math.max(1, query.page ?? 1)
    const limit = Math.min(100, Math.max(1, query.limit ?? 20))
    const skip = (page - 1) * limit

    const qb = this.itemRepo.createQueryBuilder('item')
    // Live listings only. This must be the FIRST predicate: a later .where()
    // resets the whole WHERE clause and discards it, so the `q` and filter
    // blocks below have to use andWhere.
    qb.where('item.soldAt IS NULL')
    let hasWhere = true
    const qTrimmed = query.q?.trim()
    if (qTrimmed) {
      qb.andWhere('LOWER(item.name) LIKE LOWER(:q)', { q: `%${qTrimmed}%` })
    }

    const normalizeMulti = (v: unknown): string[] | string | undefined => {
      if (v === undefined || v === null) return undefined
      if (Array.isArray(v)) {
        const arr = (v as unknown[]).map((x) => String(x).trim()).filter(Boolean)
        return arr.length ? arr : undefined
      }
      if (typeof v === 'string') {
        const trimmed = v.trim()
        if (!trimmed) return undefined
        if (trimmed.includes(',')) {
          const arr = trimmed.split(',').map((s) => s.trim()).filter(Boolean)
          return arr.length ? arr : undefined
        }
        return trimmed
      }
      return v as string | undefined
    }

    // canonical snake_case sama dengan api & db (equipment_type / grade_effect), fallback to camelCase alias
    const equipmentTypeVal = normalizeMulti(query.equipment_type ?? query.equipmentType)
    const gradeEffectVal = normalizeMulti(query.grade_effect ?? query.gradeEffect)

    const filters: Array<[string, unknown]> = []
    if (equipmentTypeVal !== undefined) filters.push(['equipmentType', equipmentTypeVal])
    if (gradeEffectVal !== undefined) filters.push(['gradeEffect', gradeEffectVal])
    if (query.level !== undefined) filters.push(['level', query.level])

    for (const [k, v] of filters) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v) && v.length === 0) continue
      if (Array.isArray(v)) {
        if (hasWhere) qb.andWhere(`item.${k} IN (:...${k})`, { [k]: v })
        else { qb.where(`item.${k} IN (:...${k})`, { [k]: v }); hasWhere = true }
      } else {
        if (hasWhere) qb.andWhere(`item.${k} = :${k}`, { [k]: v })
        else { qb.where(`item.${k} = :${k}`, { [k]: v }); hasWhere = true }
      }
    }

    if (query.sort === 'price_asc') qb.orderBy('item.price', 'ASC')
    else if (query.sort === 'price_desc') qb.orderBy('item.price', 'DESC')
    else qb.orderBy('item.createdAt', 'DESC') // recent / created_at_desc / default

    qb.skip(skip).take(limit)

    if (process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1') {
      try {
        console.log('[MarketplaceService.list] SQL:', qb.getSql(), 'PARAMS:', qb.getParameters(), 'QUERY:', JSON.stringify(query))
      } catch {}
    }

    const [data, total] = await qb.getManyAndCount()
    if (process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1') {
      console.log(`[MarketplaceService.list] result total=${total} returned=${data.length} page=${page} limit=${limit}`)
    }
    return { data, total, page, limit }
  }

  /**
   * Sold items are deliberately NOT filtered here.
   *
   * A token that exists in our DB has already been through the marketplace
   * scraper, so a deep link to it must keep resolving — and rendering as
   * "sold out" — rather than 404ing. browse() is where sold items stop being
   * offered.
   */
  async getByTokenId(tokenId: number) {
    const item = await this.itemRepo.findOne({ where: { tokenId } })
    if (!item) return null
    const detail = await this.detailRepo.findOne({
      where: { itemId: item.id }
    })
    return { item, detail }
  }

  async existsById(id: number): Promise<boolean> {
    return (await this.itemRepo.count({ where: { id } })) > 0
  }

  async getDistinctEquipmentTypes(): Promise<string[]> {
    const rows = await this.itemRepo
      .createQueryBuilder('item')
      .select('DISTINCT item.equipmentType', 'equipmentType')
      .where("item.equipmentType IS NOT NULL AND TRIM(item.equipmentType) != ''")
      // Scoped to live listings, or the filter dropdowns keep offering
      // equipment types and grade effects that nothing in the list can match.
      .andWhere('item.soldAt IS NULL')
      .orderBy('item.equipmentType', 'ASC')
      .getRawMany()
    return rows.map((r) => r.equipmentType as string).filter(Boolean)
  }

  async getDistinctGradeEffects(): Promise<string[]> {
    const rows = await this.itemRepo
      .createQueryBuilder('item')
      .select('DISTINCT item.gradeEffect', 'gradeEffect')
      .where("item.gradeEffect IS NOT NULL AND TRIM(item.gradeEffect) != ''")
      .andWhere('item.soldAt IS NULL')
      .orderBy('item.gradeEffect', 'ASC')
      .getRawMany()
    return rows.map((r) => r.gradeEffect as string).filter(Boolean)
  }

  async getDistinctFilters(): Promise<{ equipmentTypes: string[]; gradeEffects: string[] }> {
    const [equipmentTypes, gradeEffects] = await Promise.all([this.getDistinctEquipmentTypes(), this.getDistinctGradeEffects()])
    return { equipmentTypes, gradeEffects }
  }

  async findPriceById(id: number): Promise<number | null> {
    const row = await this.itemRepo.findOne({ where: { id }, select: ['id', 'price'] })
    return row ? Number(row.price) : null
  }

  async findPricesMap(ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map()
    const rows = await this.itemRepo.find({ where: ids.map((id) => ({ id })), select: ['id', 'price'] } as never)
    const m = new Map<number, number>()
    for (const r of rows as MarketplaceItemEntity[]) m.set(Number(r.id), Number(r.price))
    return m
  }

  async findCreatedAtMap(ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map()
    const rows = await this.itemRepo.find({ where: ids.map((id) => ({ id })), select: ['id', 'createdAt'] } as never)
    const m = new Map<number, number>()
    for (const r of rows as MarketplaceItemEntity[]) {
      const v = (r as MarketplaceItemEntity).createdAt
      const epoch = v instanceof Date ? Math.floor(v.getTime() / 1000) : Math.floor(new Date(v as unknown as string).getTime() / 1000)
      if (Number.isFinite(epoch)) m.set(Number(r.id), epoch)
    }
    return m
  }

  // ---- Favorites ----
  private toFavoriteDto(e: MarketplaceFavoriteEntity): MarketplaceFavorite {
    return {
      id: e.id,
      name: e.name,
      q: e.q ?? null,
      equipmentTypes: e.equipmentTypes ?? [],
      gradeEffects: e.gradeEffects ?? [],
      sort: e.sort ?? 'recent',
      createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
      updatedAt: e.updatedAt instanceof Date ? e.updatedAt.toISOString() : String(e.updatedAt)
    }
  }

  private normalizeFavoriteArrays(input: CreateFavoriteInput | UpdateFavoriteInput): { equipmentTypes: string[]; gradeEffects: string[]; q: string | null; sort: string } {
    const qRaw = (input as unknown as Record<string, unknown>).q
    const q = typeof qRaw === 'string' ? (qRaw.trim() || null) : (qRaw == null ? null : String(qRaw).trim() || null)
    const sort = typeof input.sort === 'string' && input.sort.trim() ? input.sort.trim() : 'recent'
    const norm = (v: unknown): string[] => {
      if (v === undefined || v === null) return []
      if (Array.isArray(v)) return (v as unknown[]).map((x) => String(x).trim()).filter(Boolean)
      if (typeof v === 'string') {
        const t = v.trim()
        if (!t) return []
        return t.includes(',') ? t.split(',').map((s) => s.trim()).filter(Boolean) : [t]
      }
      return []
    }
    const equipmentTypes = norm((input as Record<string, unknown>).equipmentTypes ?? (input as Record<string, unknown>).equipment_type)
    const gradeEffects = norm((input as Record<string, unknown>).gradeEffects ?? (input as Record<string, unknown>).grade_effect)
    return { equipmentTypes, gradeEffects, q, sort }
  }

  async listFavorites(accountId: number): Promise<MarketplaceFavorite[]> {
    const rows = await this.favoriteRepo.find({ where: { accountId }, order: { name: 'ASC' } })
    return rows.map((r) => this.toFavoriteDto(r))
  }

  async createFavorite(accountId: number, input: CreateFavoriteInput): Promise<MarketplaceFavorite> {
    const name = input.name?.trim()
    if (!name) throw new BadRequestException('Favorite name is required')
    if (name.length > 50) throw new BadRequestException('Favorite name max 50 chars')
    const exists = await this.favoriteRepo.findOne({ where: { accountId, name } })
    if (exists) throw new ConflictException(`Favorite "${name}" already exists`)
    const { equipmentTypes, gradeEffects, q, sort } = this.normalizeFavoriteArrays(input)
    const ent = this.favoriteRepo.create({
      accountId,
      name,
      q,
      equipmentTypes,
      gradeEffects,
      sort
    })
    try {
      const saved = await this.favoriteRepo.save(ent)
      return this.toFavoriteDto(saved)
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException(`Favorite "${name}" already exists`)
      }
      throw e
    }
  }

  async updateFavorite(accountId: number, id: number, input: UpdateFavoriteInput): Promise<MarketplaceFavorite> {
    const ent = await this.favoriteRepo.findOne({ where: { id, accountId } })
    // Scoping the lookup by accountId means another user's favorite id is
    // indistinguishable from a missing one, which avoids leaking existence.
    if (!ent) throw new NotFoundException('Favorite not found')
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) throw new BadRequestException('Favorite name is required')
      if (name.length > 50) throw new BadRequestException('Favorite name max 50 chars')
      if (name !== ent.name) {
        const dup = await this.favoriteRepo.findOne({ where: { accountId, name } })
        if (dup) throw new ConflictException(`Favorite "${name}" already exists`)
        ent.name = name
      }
    }
    // if any filter fields provided, replace them; allow clearing via empty array / null q
    const hasFilterKeys = ['q','equipmentTypes','gradeEffects','equipment_type','grade_effect','sort'].some(k=> k in input)
    if (hasFilterKeys) {
      const norm = this.normalizeFavoriteArrays(input as CreateFavoriteInput)
      // Only touch the keys the caller actually sent, so renaming does not wipe filters.
      const src = input as Record<string,unknown>
      if ('q' in src) ent.q = norm.q
      if ('equipmentTypes' in src || 'equipment_type' in src) ent.equipmentTypes = norm.equipmentTypes
      if ('gradeEffects' in src || 'grade_effect' in src) ent.gradeEffects = norm.gradeEffects
      if ('sort' in src) ent.sort = norm.sort
    }
    // updatedAt is maintained by @UpdateDateColumn.
    const saved = await this.favoriteRepo.save(ent)
    return this.toFavoriteDto(saved)
  }

  async deleteFavorite(accountId: number, id: number): Promise<void> {
    const result = await this.favoriteRepo.delete({ id, accountId })
    if (!result.affected) throw new NotFoundException('Favorite not found')
  }

  async getFavorite(accountId: number, id: number): Promise<MarketplaceFavorite> {
    const ent = await this.favoriteRepo.findOne({ where: { id, accountId } })
    if (!ent) throw new NotFoundException('Favorite not found')
    return this.toFavoriteDto(ent)
  }

  /**
   * Reconcile the item table against the transfer ledger: a token that appears
   * in `marketplace_token_transfers` was sold, so its listing is over.
   *
   * Deliberately table-wide rather than scoped to the transfers a run just
   * fetched. Both history paths stop early at the first transfer they already
   * have — `refreshLatest` breaks on a known tx_hash — so a scope built from
   * "the fresh ones" would silently never revisit a transfer whose item row did
   * not exist yet at the time. Re-deriving from the whole ledger is a hash join
   * on an indexed token_id that makes that class of miss unrepresentable.
   *
   * `sold_at IS NULL` does double duty: it makes the statement a no-op once a row
   * is marked, and it pins sold_at to the first sale we ever observed rather
   * than letting a later transfer overwrite it.
   *
   * The `t.created_at >= i.created_at` guard is what makes a relist survivable.
   * A token that sold and was then relisted arrives as a new item_id for the same
   * token, and upsertFromApi clears sold_at so the new listing is live again — but
   * its previous sale is still in the ledger, and without the guard the very next
   * run would re-sell the item using a transfer that predates the listing. The
   * invariant is that sold_at can never be earlier than created_at.
   */
  async markItemsSold(): Promise<number> {
    // RETURNING is what makes the count obtainable: through the pg driver an
    // UPDATE without it hands back an empty row set, so `affected` would always
    // read as 0 and the sync panel would report "0 sold" on every run.
    const rows = await this.itemRepo.query(
      `
        UPDATE "marketplace_items" i
        SET "sold_at" = t."created_at", "sold_price" = t."price"
        FROM (
            SELECT DISTINCT ON ("token_id") "token_id", "price", "created_at"
            FROM "marketplace_token_transfers"
            WHERE "price" > 0
            ORDER BY "token_id", "created_at" DESC
        ) t
        WHERE i."token_id" = t."token_id"
          AND i."sold_at" IS NULL
          AND t."created_at" >= i."created_at"
        RETURNING i."id"
      `
    )
    return Array.isArray(rows) ? rows.length : 0
  }

  /**
   * Deletes every listing, and every detail row with it.
   *
   * Counted inside the same transaction as the delete, so the numbers reported
   * back are the rows that actually went rather than a count that could drift
   * between two statements. `marketplace_item_detail` needs no explicit delete —
   * its foreign key is ON DELETE CASCADE — but it is counted so the caller can say
   * what disappeared.
   *
   * This is irreversible and there is no undo. A re-sync repopulates the table,
   * but sold state is rebuilt from the transfer ledger rather than restored, so
   * a listing that had sold is only marked again once history runs.
   */
  async clearAll(): Promise<{ items: number; details: number }> {
    return this.itemRepo.manager.transaction(async (m) => {
      const details = await m.count(MarketplaceItemDetailEntity)
      const res = await m.createQueryBuilder().delete().from(MarketplaceItemEntity).execute()
      return { items: res.affected ?? 0, details }
    })
  }

  async upsertFromApi(raw: {
    id: number // item_id reuse as PK per user
    tokenId: number
    sellerId: string
    sellerName: string | null
    imageUrl: string
    name: string
    currency?: string
    price: number
    gradeEffect: string
    level: number
    enchant: number
    equipmentType: string
    createdAt: Date // timestamptz from created_at epoch == market_time (duplicate removed)
    mintTime?: Date | string | null // moved from detail to item
    detail?: {
      attributes?: unknown
      datas?: unknown
      infos?: unknown
    }
  }) {
    const mintTimeVal = raw.mintTime ? new Date(raw.mintTime as string) : null
    // A relisted item comes back from the upstream with a NEW item_id but the SAME
    // token_id, so looking up by id alone misses the existing row and the insert
    // below trips the unique index on token_id. Matching on either key keeps the
    // original row, which is what preserves its detail blob and sale history.
    let item = await this.itemRepo.findOne({ where: { id: raw.id } })
    const relisted = !item && Number.isFinite(raw.tokenId)
    if (relisted) {
      item = await this.itemRepo.findOne({ where: { tokenId: raw.tokenId } })
    }
    if (!item) {
      item = this.itemRepo.create({
        id: raw.id,
        tokenId: raw.tokenId,
        sellerId: raw.sellerId,
        sellerName: raw.sellerName ?? null,
        imageUrl: raw.imageUrl,
        name: raw.name,
        currency: raw.currency ?? 'NUMI',
        price: raw.price,
        gradeEffect: raw.gradeEffect,
        level: raw.level,
        enchant: raw.enchant,
        equipmentType: raw.equipmentType,
        createdAt: raw.createdAt,
        mintTime: mintTimeVal && !isNaN(mintTimeVal.getTime()) ? mintTimeVal : null,
        // A brand new row is live by definition; sold state arrives later, from
        // the transfer ledger.
        soldAt: null,
        soldPrice: null
      })
    } else {
      Object.assign(item, {
        tokenId: raw.tokenId,
        sellerId: raw.sellerId,
        sellerName: raw.sellerName ?? null,
        imageUrl: raw.imageUrl,
        name: raw.name,
        currency: raw.currency ?? item.currency,
        price: raw.price,
        gradeEffect: raw.gradeEffect,
        level: raw.level,
        enchant: raw.enchant,
        equipmentType: raw.equipmentType,
        createdAt: raw.createdAt,
        ...(mintTimeVal && !isNaN(mintTimeVal.getTime()) ? { mintTime: mintTimeVal } : {}),
        // Only a row that is genuinely back on the market clears its sale. A
        // plain re-scrape of a sold item keeps sold_at, otherwise every sync
        // would resurrect it between the marketplace and history runs.
        ...(relisted ? { soldAt: null, soldPrice: null } : {})
      })
    }
    item = await this.itemRepo.save(item)

    if (raw.detail) {
      let detail = await this.detailRepo.findOne({ where: { itemId: item.id } })
      if (!detail) {
        detail = this.detailRepo.create({
          itemId: item.id,
          attributes: raw.detail.attributes ?? null,
          datas: raw.detail.datas ?? null,
          infos: raw.detail.infos ?? null
        })
      } else {
        detail.attributes = raw.detail.attributes ?? detail.attributes
        detail.datas = raw.detail.datas ?? detail.datas
        detail.infos = raw.detail.infos ?? detail.infos
      }
      await this.detailRepo.save(detail)
    }
    return item
  }
}
