import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { MarketplaceItemEntity } from './entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from './entities/marketplace-item-detail.entity'
import type { MarketplaceListQuery } from '@shared/types'

@Injectable()
export class MarketplaceService {
  constructor(
    @InjectRepository(MarketplaceItemEntity)
    private readonly itemRepo: Repository<MarketplaceItemEntity>,
    @InjectRepository(MarketplaceItemDetailEntity)
    private readonly detailRepo: Repository<MarketplaceItemDetailEntity>
  ) {}

  async list(query: MarketplaceListQuery = {}) {
    const page = Math.max(1, query.page ?? 1)
    const limit = Math.min(100, Math.max(1, query.limit ?? 20))
    const skip = (page - 1) * limit

    const qb = this.itemRepo.createQueryBuilder('item')
    let hasWhere = false
    const qTrimmed = query.q?.trim()
    if (qTrimmed) {
      qb.where('LOWER(item.name) LIKE LOWER(:q)', { q: `%${qTrimmed}%` })
      hasWhere = true
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

  async getByTokenId(tokenId: number) {
    const item = await this.itemRepo.findOne({ where: { tokenId } })
    if (!item) return null
    const detail = await this.detailRepo.findOne({
      where: { itemId: item.id },
      relations: ['attributeRows', 'dataRows', 'infoRows']
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
      .orderBy('item.equipmentType', 'ASC')
      .getRawMany()
    return rows.map((r) => r.equipmentType as string).filter(Boolean)
  }

  async getDistinctGradeEffects(): Promise<string[]> {
    const rows = await this.itemRepo
      .createQueryBuilder('item')
      .select('DISTINCT item.gradeEffect', 'gradeEffect')
      .where("item.gradeEffect IS NOT NULL AND TRIM(item.gradeEffect) != ''")
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

  async upsertFromApi(raw: {
    id: number // item_id reuse as PK per user
    tokenId: number
    ownerId: string
    ownerName: string
    sellerId: string
    imageUrl: string
    name: string
    currency?: string
    price: number
    gradeEffect: string
    level: number
    enchant: number
    equipmentType: string
    createdAt: Date // timestamptz from created_at epoch
    detail?: {
      attributes?: unknown
      datas?: unknown
      infos?: unknown
      mintTime?: string | null
      marketTime?: string | null
    }
  }) {
    let item = await this.itemRepo.findOne({ where: { id: raw.id } })
    if (!item) {
      item = this.itemRepo.create({
        id: raw.id,
        tokenId: raw.tokenId,
        ownerId: raw.ownerId,
        ownerName: raw.ownerName,
        sellerId: raw.sellerId,
        imageUrl: raw.imageUrl,
        name: raw.name,
        currency: raw.currency ?? 'NUMI',
        price: raw.price,
        gradeEffect: raw.gradeEffect,
        level: raw.level,
        enchant: raw.enchant,
        equipmentType: raw.equipmentType,
        createdAt: raw.createdAt
      })
    } else {
      Object.assign(item, {
        tokenId: raw.tokenId,
        ownerId: raw.ownerId,
        ownerName: raw.ownerName,
        sellerId: raw.sellerId,
        imageUrl: raw.imageUrl,
        name: raw.name,
        currency: raw.currency ?? item.currency,
        price: raw.price,
        gradeEffect: raw.gradeEffect,
        level: raw.level,
        enchant: raw.enchant,
        equipmentType: raw.equipmentType,
        createdAt: raw.createdAt
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
          infos: raw.detail.infos ?? null,
          mintTime: raw.detail.mintTime ? new Date(raw.detail.mintTime) : null,
          marketTime: raw.detail.marketTime ? new Date(raw.detail.marketTime) : null
        })
      } else {
        detail.attributes = raw.detail.attributes ?? detail.attributes
        detail.datas = raw.detail.datas ?? detail.datas
        detail.infos = raw.detail.infos ?? detail.infos
        if (raw.detail.mintTime) detail.mintTime = new Date(raw.detail.mintTime)
        if (raw.detail.marketTime) detail.marketTime = new Date(raw.detail.marketTime)
      }
      await this.detailRepo.save(detail)
    }
    return item
  }
}
