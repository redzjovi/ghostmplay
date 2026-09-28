import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { MarketplaceTokenTransferEntity } from './entities/marketplace-token-transfer.entity'
import { UserEntity, normalizeAddress } from './entities/user.entity'
import type { HistoryListQuery, MarketplaceTokenTransfer } from '@shared/types'

export function parseTransferTime(s: string): Date {
  // API: "2026-09-25 01:45:59" — treat as UTC ("2026-09-25T01:45:59Z")
  const t = s.trim().replace(' ', 'T')
  const withZ = /[Z+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`
  const d = new Date(withZ)
  return d
}

function toDto(
  e: MarketplaceTokenTransferEntity,
  sellerUsername?: string | null,
  buyerUsername?: string | null
): MarketplaceTokenTransfer {
  return {
    id: e.id,
    tokenId: e.tokenId,
    gameName: e.gameName ?? null,
    sellerId: e.sellerId,
    sellerUsername: sellerUsername ?? null,
    buyerId: e.buyerId,
    buyerUsername: buyerUsername ?? null,
    itemName: e.itemName,
    price: Number(e.price),
    currency: e.currency,
    txHash: e.txHash,
    imageUrl: e.imageUrl,
    createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
    claimed: !!e.claimed
  }
}

@Injectable()
export class HistoryService {
  constructor(
    @InjectRepository(MarketplaceTokenTransferEntity)
    private readonly transferRepo: Repository<MarketplaceTokenTransferEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>
  ) {}

  async list(query: HistoryListQuery = {}) {
    const page = Math.max(1, query.page ?? 1)
    const limit = Math.min(100, Math.max(1, query.limit ?? 15))
    const skip = (page - 1) * limit

    const qb = this.transferRepo.createQueryBuilder('t')
    qb.leftJoin(UserEntity, 'su', 'su.id = LOWER(t.sellerId)')
    qb.leftJoin(UserEntity, 'bu', 'bu.id = LOWER(t.buyerId)')
    let hasWhere = false
    const andWhere = (sql: string, params?: Record<string, unknown>) => {
      if (hasWhere) qb.andWhere(sql, params)
      else {
        qb.where(sql, params)
        hasWhere = true
      }
    }

    const seller = query.seller?.trim()
    if (seller) {
      andWhere('(LOWER(t.sellerId) LIKE LOWER(:seller) OR LOWER(su.username) LIKE LOWER(:seller))', {
        seller: `%${seller}%`
      })
    }
    const buyer = query.buyer?.trim()
    if (buyer) {
      andWhere('(LOWER(t.buyerId) LIKE LOWER(:buyer) OR LOWER(bu.username) LIKE LOWER(:buyer))', {
        buyer: `%${buyer}%`
      })
    }
    const sellerName = query.sellerName?.trim()
    if (sellerName) {
      andWhere('su.username = :sellerName', { sellerName })
    }
    const buyerName = query.buyerName?.trim()
    if (buyerName) {
      andWhere('bu.username = :buyerName', { buyerName })
    }
    const itemName = (query.itemName ?? query.q)?.trim()
    if (itemName) {
      andWhere('LOWER(t.itemName) LIKE LOWER(:itemName)', { itemName: `%${itemName}%` })
    }
    if (query.tokenId !== undefined && query.tokenId !== null && String(query.tokenId).trim() !== '' && Number.isFinite(Number(query.tokenId))) {
      andWhere('t.tokenId = :tokenId', { tokenId: Number(query.tokenId) })
    }
    if (query.txHash?.trim()) {
      andWhere('LOWER(t.txHash) LIKE LOWER(:txHash)', { txHash: `%${query.txHash.trim()}%` })
    }
    if (query.priceMin !== undefined && query.priceMin !== null && Number.isFinite(Number(query.priceMin))) {
      andWhere('t.price >= :priceMin', { priceMin: Number(query.priceMin) })
    }
    if (query.priceMax !== undefined && query.priceMax !== null && Number.isFinite(Number(query.priceMax))) {
      andWhere('t.price <= :priceMax', { priceMax: Number(query.priceMax) })
    }
    // Date-only bounds in YYYY-MM-DD (UTC day). `to` is exclusive next-day midnight so the whole day is included.
    const parseDay = (v: unknown): Date | null => {
      if (typeof v !== 'string') return null
      const day = v.slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
      const d = new Date(`${day}T00:00:00Z`)
      return isNaN(d.getTime()) ? null : d
    }
    if (query.createdFrom) {
      const d = parseDay(query.createdFrom)
      if (d) andWhere('t.createdAt >= :createdFrom', { createdFrom: d })
    }
    if (query.createdTo) {
      const d = parseDay(query.createdTo)
      if (d) andWhere('t.createdAt < :createdTo', { createdTo: new Date(d.getTime() + 24 * 3600 * 1000) })
    }
    if (query.claimed !== undefined) {
      andWhere('t.claimed = :claimed', { claimed: !!query.claimed })
    }

    if (query.sort === 'price_asc') qb.orderBy('t.price', 'ASC')
    else if (query.sort === 'price_desc') qb.orderBy('t.price', 'DESC')
    else if (query.sort === 'created_at_asc') qb.orderBy('t.createdAt', 'ASC')
    else qb.orderBy('t.createdAt', 'DESC')

    qb.skip(skip).take(limit)
    qb.addSelect(['su.username', 'bu.username'])

    const [rows, total] = await qb.getManyAndCount()
    // getMany ignores added selects from joins without relation; fetch usernames via raw map
    const raw = await qb.getRawMany<{ t_id: number; su_username: string | null; bu_username: string | null }>().catch(() => [])
    const nameMap = new Map<number, { su: string | null; bu: string | null }>()
    for (const r of raw ?? []) {
      const id = Number((r as Record<string, unknown>).t_id ?? (r as Record<string, unknown>).id)
      if (Number.isFinite(id)) {
        nameMap.set(id, {
          su: ((r as Record<string, unknown>).su_username as string | null) ?? null,
          bu: ((r as Record<string, unknown>).bu_username as string | null) ?? null
        })
      }
    }
    // Fallback: batch load users for rows when raw map empty
    let userMap = new Map<string, string | null>()
    if (nameMap.size === 0 && rows.length) {
      const addrs = new Set<string>()
      for (const t of rows) {
        addrs.add(normalizeAddress(t.sellerId))
        addrs.add(normalizeAddress(t.buyerId))
      }
      const users = await this.userRepo.find({ where: [...addrs].map((id) => ({ id })) } as never).catch(() => [])
      userMap = new Map((users as UserEntity[]).map((u) => [u.id, u.username]))
    }

    const data = rows.map((t) => {
      const fromRaw = nameMap.get(t.id)
      const su = fromRaw ? fromRaw.su : (userMap.get(normalizeAddress(t.sellerId)) ?? null)
      const bu = fromRaw ? fromRaw.bu : (userMap.get(normalizeAddress(t.buyerId)) ?? null)
      return toDto(t, su, bu)
    })
    return { data, total, page, limit }
  }

  async ensureUser(address: string): Promise<UserEntity> {
    const id = normalizeAddress(address)
    let u = await this.userRepo.findOne({ where: { id } })
    if (!u) {
      u = this.userRepo.create({ id, username: null })
      try {
        u = await this.userRepo.save(u)
      } catch {
        // race: re-read
        u = (await this.userRepo.findOne({ where: { id } })) ?? u
      }
    }
    return u
  }

  async existsByTxHash(txHash: string): Promise<boolean> {
    return (await this.transferRepo.count({ where: { txHash } as never })) > 0
  }

  async getDistinctGameNames(): Promise<string[]> {
    const rows = await this.transferRepo
      .createQueryBuilder('t')
      .select('DISTINCT t.gameName', 'gameName')
      .where("t.gameName IS NOT NULL AND TRIM(t.gameName) != ''")
      .orderBy('t.gameName', 'ASC')
      .getRawMany()
    return rows.map((r) => r.gameName as string).filter(Boolean)
  }

  async getDistinctSellerNames(): Promise<string[]> {
    const rows = await this.transferRepo
      .createQueryBuilder('t')
      .select('DISTINCT su.username', 'username')
      .innerJoin(UserEntity, 'su', 'su.id = LOWER(t.sellerId)')
      .where("su.username IS NOT NULL AND TRIM(su.username) != ''")
      .orderBy('su.username', 'ASC')
      .getRawMany()
    return rows.map((r) => r.username as string).filter(Boolean)
  }

  async getDistinctBuyerNames(): Promise<string[]> {
    const rows = await this.transferRepo
      .createQueryBuilder('t')
      .select('DISTINCT bu.username', 'username')
      .innerJoin(UserEntity, 'bu', 'bu.id = LOWER(t.buyerId)')
      .where("bu.username IS NOT NULL AND TRIM(bu.username) != ''")
      .orderBy('bu.username', 'ASC')
      .getRawMany()
    return rows.map((r) => r.username as string).filter(Boolean)
  }

  async getDistinctHistoryFilters(): Promise<{ gameNames: string[]; sellerNames: string[]; buyerNames: string[] }> {
    const [gameNames, sellerNames, buyerNames] = await Promise.all([
      this.getDistinctGameNames(),
      this.getDistinctSellerNames(),
      this.getDistinctBuyerNames()
    ])
    return { gameNames, sellerNames, buyerNames }
  }

  async upsertFromApi(raw: {
    tokenId: number
    gameName?: string | null
    sellerId: string
    buyerId: string
    buyerUsername?: string | null
    itemName: string
    price: number
    currency?: string
    txHash: string
    imageUrl?: string | null
    createdAt: Date
    claimed?: boolean
  }) {
    await this.ensureUser(raw.sellerId)
    await this.ensureUser(raw.buyerId)
    const buyerUsername = raw.buyerUsername?.trim() ? raw.buyerUsername.trim() : null
    if (buyerUsername) {
      await this.userRepo.update({ id: normalizeAddress(raw.buyerId) } as never, { username: buyerUsername } as never)
    }
    let ent = await this.transferRepo.findOne({ where: { txHash: raw.txHash } as never })
    if (!ent) {
      ent = this.transferRepo.create({
        tokenId: raw.tokenId,
        gameName: raw.gameName ?? null,
        sellerId: raw.sellerId,
        buyerId: raw.buyerId,
        itemName: raw.itemName,
        price: raw.price,
        currency: raw.currency ?? 'NUMI',
        txHash: raw.txHash,
        imageUrl: raw.imageUrl ?? null,
        createdAt: raw.createdAt,
        claimed: raw.claimed ?? false
      })
    } else {
      Object.assign(ent, {
        tokenId: raw.tokenId,
        ...(raw.gameName ? { gameName: raw.gameName } : {}),
        sellerId: raw.sellerId,
        buyerId: raw.buyerId,
        itemName: raw.itemName,
        price: raw.price,
        currency: raw.currency ?? ent.currency,
        imageUrl: raw.imageUrl ?? ent.imageUrl,
        createdAt: raw.createdAt,
        ...(raw.claimed !== undefined ? { claimed: raw.claimed } : {})
        // never reset claimed back to false unless explicitly passed (400 inline path)
      })
    }
    return this.transferRepo.save(ent)
  }
}
