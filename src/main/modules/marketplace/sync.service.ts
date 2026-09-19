import { Inject, Injectable, Logger } from '@nestjs/common'
import { GhostMarketplaceClient, SearchRedisItem } from './api/ghost-marketplace.client'
import { MarketplaceService } from './marketplace.service'

function parseTraitPairs(traitPairs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of traitPairs ?? []) {
    const [k, ...rest] = p.split('=')
    if (k) out[k.trim()] = rest.join('=').trim()
  }
  return out
}

export function buildImageUrl(ipfsBase: string, raw: string): string {
  if (!raw) return ''
  raw = raw.trim()
  if (!raw) return ''
  if (raw.includes('/ipfs/')) return raw.replace(/([^:]\/)\/+/g, '$1')
  const cidMatch = raw.match(/^(https?:\/\/[^\/]+)\/(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+.*|bafk[a-z0-9]+.*)$/i)
  if (cidMatch) return `${cidMatch[1]}/ipfs/${cidMatch[2]}`
  const normalizedBase = (ipfsBase || '').replace(/\/$/, '').replace(/\/ipfs\/?$/, '')
  if (normalizedBase && raw.startsWith(normalizedBase)) {
    const suffix = raw.slice(normalizedBase.length).replace(/^\//, '')
    if (suffix) return `${normalizedBase}/ipfs/${suffix}`
  }
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z0-9]+|bafk[a-z0-9]+)/i.test(raw)) {
    if (normalizedBase) return `${normalizedBase}/ipfs/${raw}`
    return raw
  }
  if (/^https?:\/\//.test(raw) || raw.startsWith('data:')) return raw
  return raw
}

export type SyncMode = 'all' | 'latest'

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name)

  constructor(
    @Inject(GhostMarketplaceClient) private readonly client: GhostMarketplaceClient,
    @Inject(MarketplaceService) private readonly marketplace: MarketplaceService
  ) {}

  /** Map API item -> DB entity fields (camelCase props, snake columns) */
  private mapItem(it: SearchRedisItem, ipfsBase = '') {
    const traits = parseTraitPairs(it.trait_pairs)
    const level = Number(it.trait_nums?.Level ?? traits['Level'] ?? 0)
    const enchant = Number(it.trait_nums?.Enchant ?? traits['Enchant'] ?? 0)
    const equipmentType = String(traits['Equipment Type'] ?? 'Item').trim()
    const gradeEffect = String(traits['Grade Effect'] ?? 'Normal').trim()
    // created_at is epoch seconds -> timestamptz Date
    const createdAt = new Date(Number(it.created_at) * 1000)
    return {
      id: Number(it.item_id), // reuse id as item_id per user
      tokenId: Number(it.token_id),
      ownerId: String(it.seller ?? ''),
      ownerName: String(it.uid ?? ''),
      sellerId: String(it.seller ?? ''),
      imageUrl: buildImageUrl(ipfsBase, String(it.image_url ?? '')),
      name: String(it.item_name ?? ''),
      currency: String(it.currency ?? 'NUMI'),
      price: Number(it.price ?? 0),
      gradeEffect,
      level: Number.isFinite(level) ? level : 0,
      enchant: Number.isFinite(enchant) ? enchant : 0,
      equipmentType,
      createdAt
    }
  }

  /**
   * Scrap with sort=created_at_desc, limit 12 (offset=page).
   * - latest: no limit page, break after found id+price same in DB
   * - all: infinite until end (items.length < limit)
   */
  async refresh(opts: { itemName?: string; maxPages?: number; mode?: SyncMode } = {}) {
    const mode = opts.mode ?? 'latest'
    const limit = 12
    let page = 0
    let totalSynced = 0
    let pages = 0
    // latest: no limit page (infinite until break), all: infinite until end
    // offset = page per API (offset 0,1,2...), not item count
    const maxPages = mode === 'latest' ? Number.MAX_SAFE_INTEGER : (opts.maxPages ?? Number.MAX_SAFE_INTEGER)

    while (pages < maxPages) {
      const logApi = process.env.LOG_API === '1' || process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1'
      if (logApi) this.logger.log(`[Sync] → searchRedis page=${page} mode=${mode} itemName=${opts.itemName ?? ''} limit=${limit}`)
      const res = await this.client.searchRedis({
        serviceName: 'GhostMGlobal',
        itemName: opts.itemName,
        sort: 'created_at_desc',
        offset: page,
        limit
      })
      if (logApi) {
        const c = (res as unknown as { count?: number }).count ?? res.count
        this.logger.log(`[Sync] ← searchRedis page=${page} count=${String(c)} items=${res.items?.length ?? 0}`)
      }
      const ipfsBase = (res as unknown as { ipfs?: string }).ipfs ?? ''
      const items = res.items ?? []
      if (items.length === 0) {
        this.logger.log(`Scrap done: no items at page ${page}`)
        break
      }

      let foundSamePrice = false
      // For latest: batch fetch prices for break check id+price same; for all: no break check
      const priceMap = mode === 'latest' ? await this.marketplace.findPricesMap(items.map((it) => Number((it as SearchRedisItem).item_id))) : new Map<number, number>()

      for (const it of items) {
        const incomingId = Number((it as SearchRedisItem).item_id)
        const incomingPrice = Number((it as SearchRedisItem).price ?? 0)
        if (mode === 'latest') {
          const existingPrice = priceMap.get(incomingId)
          if (existingPrice !== undefined) {
            if (existingPrice === incomingPrice) {
              foundSamePrice = true
              this.logger.log(`Break scrap: id ${incomingId} price ${incomingPrice} same as DB at page ${page}`)
              break
            }
            this.logger.log(`Price changed id ${incomingId}: ${existingPrice} -> ${incomingPrice}, updating`)
          }
        }
        const mapped = this.mapItem(it as SearchRedisItem, ipfsBase)
        await this.marketplace.upsertFromApi(mapped)
        totalSynced++
        if (mode === 'latest') priceMap.set(incomingId, incomingPrice)
      }

      if (mode === 'latest' && foundSamePrice) break

      // if less than limit, no more pages
      if (items.length < limit) {
        this.logger.log(`Scrap done: last page ${pages} (page ${page}) with ${items.length} < ${limit}`)
        break
      }

      page += 1
      pages++
    }

    this.logger.log(`Scrap finished: synced ${totalSynced} new items`)
    return { synced: totalSynced }
  }

  // Keep for IPC compat: refresh with page/limit/q maps to itemName search
  async refreshLegacy(opts: { page?: number; limit?: number; q?: string } = {}) {
    const limit = opts.limit ?? 20
    const page = opts.page ?? 1
    const offset = (page - 1) * limit
    const logApi = process.env.LOG_API === '1' || process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1'
    if (logApi) this.logger.log(`[Sync] → searchRedis(legacy) page=${page} q=${opts.q ?? ''}`)
    // single page fetch
    const res = await this.client.searchRedis({
      serviceName: 'GhostMGlobal',
      itemName: opts.q,
      sort: 'created_at_desc',
      offset,
      limit
    })
    if (logApi) this.logger.log(`[Sync] ← searchRedis(legacy) items=${res.items?.length ?? 0}`)
    let synced = 0
    const ipfsBase2 = (res as unknown as { ipfs?: string }).ipfs ?? ''
    for (const it of res.items ?? []) {
      const mapped = this.mapItem(it as SearchRedisItem, ipfsBase2)
      await this.marketplace.upsertFromApi(mapped)
      synced++
    }
    return { synced }
  }
}
