import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, Like } from 'typeorm'
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

    const where: Record<string, unknown>[] | Record<string, unknown> = {}
    const andWhere: Record<string, unknown> = {}

    if (query.equipmentType) andWhere['equipmentType'] = query.equipmentType
    if (query.gradeEffect) andWhere['gradeEffect'] = query.gradeEffect
    if (query.level !== undefined) andWhere['level'] = query.level

    const qb = this.itemRepo.createQueryBuilder('item')

    if (query.q) {
      qb.where('item.name LIKE :q OR item.ownerName LIKE :q', { q: `%${query.q}%` })
      if (Object.keys(andWhere).length) {
        Object.entries(andWhere).forEach(([k, v]) => qb.andWhere(`item.${k} = :${k}`, { [k]: v }))
      }
    } else if (Object.keys(andWhere).length) {
      qb.where(andWhere)
    }

    if (query.sort === 'price_asc') qb.orderBy('item.price', 'ASC')
    else if (query.sort === 'price_desc') qb.orderBy('item.price', 'DESC')
    else qb.orderBy('item.createdAt', 'DESC')

    qb.skip(skip).take(limit)

    const [data, total] = await qb.getManyAndCount()
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

  async upsertFromApi(raw: {
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
    detail?: {
      attributes?: unknown
      datas?: unknown
      infos?: unknown
      mintTime?: string | null
      marketTime?: string | null
    }
  }) {
    let item = await this.itemRepo.findOne({ where: { tokenId: raw.tokenId } })
    if (!item) {
      item = this.itemRepo.create({
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
        equipmentType: raw.equipmentType
      })
    } else {
      Object.assign(item, {
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
        equipmentType: raw.equipmentType
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
