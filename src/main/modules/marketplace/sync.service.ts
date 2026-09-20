import { Inject, Injectable, Logger } from '@nestjs/common'
import { GhostMarketplaceClient, SearchRedisItem, ItemDetailResponse } from './api/ghost-marketplace.client'
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

function parseKST(s: string | null): Date | null {
  if (!s) return null
  // "2026-09-20 00:06:31 +0900 KST" -> "2026-09-20 00:06:31 +09:00"
  const t = s.replace(' KST', '').replace(/ ([+-]\d{2})(\d{2})$/, ' $1:$2')
  const d = new Date(t)
  return isNaN(d.getTime()) ? null : d
}

async function pool<T, R>(limit: number, items: T[], fn: (item: T) => Promise<R>): Promise<Map<T, R | null>> {
  const results = new Map<T, R | null>()
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++
      const item = items[cur]
      try {
        const res = await fn(item)
        results.set(item, res)
      } catch {
        results.set(item, null)
      }
    }
  })
  await Promise.all(workers)
  return results
}

export type SyncMode = 'all' | 'latest'

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name)

  constructor(
    @Inject(GhostMarketplaceClient) private readonly client: GhostMarketplaceClient,
    @Inject(MarketplaceService) private readonly marketplace: MarketplaceService
  ) {}

  /** Map API item -> DB entity fields (camelCase props, snake columns) with detail fallback */
  private mapItem(it: SearchRedisItem, ipfsBase = '', detail: ItemDetailResponse | null = null) {
    const traits = parseTraitPairs(it.trait_pairs)
    // Prefer detail attributes if available (more authoritative), fallback to trait_pairs
    const detailAttrs = new Map<string, string>()
    if (detail?.details?.attributes) {
      for (const a of detail.details.attributes as { trait_type: string; value: string }[]) {
        if (a.trait_type) detailAttrs.set(a.trait_type.trim(), String(a.value).trim())
      }
    }
    const getAttr = (key: string, fallback: string) => detailAttrs.get(key) ?? traits[key] ?? fallback

    const level = Number(it.trait_nums?.Level ?? getAttr('Level', '0') ?? 0)
    const enchant = Number(it.trait_nums?.Enchant ?? getAttr('Enchant', '0') ?? 0)
    const equipmentType = String(getAttr('Equipment Type', 'Item')).trim()
    const gradeEffect = String(getAttr('Grade Effect', 'Normal')).trim()
    // created_at is epoch seconds -> timestamptz Date
    const createdAt = new Date(Number(it.created_at) * 1000)

    // Image: detail.details.image CID fallback to searchRedis image_url
    const detailImage = (detail?.details?.image ?? '').trim()
    const detailIpfs = (detail?.ipfs ?? '').trim()
    const rawImage = detailImage || String(it.image_url ?? '')
    const baseForImage = detailImage ? (detailIpfs || ipfsBase) : ipfsBase
    const imageUrl = buildImageUrl(baseForImage, rawImage)

    // Use detail name if available (more precise, e.g. "+4 Spectersoul Greaves (Fire)")
    const name = detail?.details?.name?.trim() ? String(detail.details.name).trim() : String(it.item_name ?? '')

    // mintTime moved to marketplace_items (from detail), marketTime duplicate of createdAt (removed)
    const mintTime = parseKST(detail?.mintTime ?? null)

    // sellerName only from detail.ownerName (per user: not index id uid)
    const sellerName: string | null = detail?.ownerName?.trim() ? String(detail.ownerName).trim() : null
    return {
      id: Number(it.item_id), // reuse id as item_id per user
      tokenId: Number(it.token_id),
      sellerId: String(it.seller ?? ''),
      sellerName,
      imageUrl,
      name,
      currency: String(it.currency ?? 'NUMI'),
      price: Number(it.price ?? 0),
      gradeEffect,
      level: Number.isFinite(level) ? level : 0,
      enchant: Number.isFinite(enchant) ? enchant : 0,
      equipmentType,
      createdAt,
      mintTime
    }
  }

  /**
   * Scrap with sort=created_at_desc, limit 12 (offset=page).
   * - latest: no limit page, break after found id+price same in DB
   * - all: infinite until end (items.length < limit)
   * Fetch detail only for new or price-changed items, parallel limit 3.
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

      // Determine which items need detail fetch (new or price changed)
      const toFetch: SearchRedisItem[] = []
      if (mode === 'latest') {
        for (const it of items as SearchRedisItem[]) {
          const id = Number(it.item_id)
          const incomingPrice = Number(it.price ?? 0)
          const existing = priceMap.get(id)
          if (existing === undefined || existing !== incomingPrice) {
            toFetch.push(it)
          }
        }
      } else {
        // all mode: fetch detail for all items on page
        toFetch.push(...(items as SearchRedisItem[]))
      }

      // Parallel fetch details with limit 3 (only for toFetch)
      const detailsMap = new Map<number, ItemDetailResponse | null>()
      if (toFetch.length > 0) {
        if (logApi) this.logger.log(`[Sync] → detail fetch ${toFetch.length} items (parallel 3) page=${page}`)
        const results = await pool(3, toFetch, async (it) => {
          const tokenId = Number((it as SearchRedisItem).token_id)
          return this.client.detail(tokenId)
        })
        for (const [it, detail] of results.entries()) {
          detailsMap.set(Number((it as SearchRedisItem).item_id), detail)
        }
        if (logApi) this.logger.log(`[Sync] ← detail fetch done page=${page} fetched=${detailsMap.size}`)
      }

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
        const hasFetchedDetail = detailsMap.has(incomingId)
        const detail = hasFetchedDetail ? (detailsMap.get(incomingId) ?? null) : null
        const sold = hasFetchedDetail ? detail === null : undefined // only set sold when we fetched detail (price change) per user #2
        const mapped = this.mapItem(it as SearchRedisItem, ipfsBase, detail)
        // Prepare detail payload for upsert (only attributes/datas/infos, mintTime moved to item)
        const detailPayload = detail
          ? {
              attributes: detail.details?.attributes ?? null,
              datas: detail.viewData?.datas ?? null,
              infos: detail.viewData?.infos ?? null
            }
          : undefined
        if (hasFetchedDetail && sold) {
          this.logger.log(`[Sync] item ${incomingId} detail empty → sold=true`)
        }

        await this.marketplace.upsertFromApi({
          ...mapped,
          ...(sold !== undefined ? { sold } : {}),
          detail: detailPayload as never
        })
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
    // For legacy, fetch details for all items (parallel 3)
    const items = (res.items ?? []) as SearchRedisItem[]
    const detailsMap = new Map<number, ItemDetailResponse | null>()
    if (items.length > 0) {
      const results = await pool(3, items, async (it) => this.client.detail(Number(it.token_id)))
      for (const [it, detail] of results.entries()) {
        detailsMap.set(Number((it as SearchRedisItem).item_id), detail)
      }
    }
    for (const it of items) {
      const detail = detailsMap.get(Number(it.item_id)) ?? null
      const sold = detail === null
      if (sold) this.logger.log(`[Sync legacy] item ${it.item_id} detail empty → sold=true`)
      const mapped = this.mapItem(it, ipfsBase2, detail)
      const detailPayload = detail
        ? {
            attributes: detail.details?.attributes ?? null,
            datas: detail.viewData?.datas ?? null,
            infos: detail.viewData?.infos ?? null
          }
        : undefined
      await this.marketplace.upsertFromApi({ ...mapped, sold, detail: detailPayload as never })
      synced++
    }
    return { synced }
  }
}
