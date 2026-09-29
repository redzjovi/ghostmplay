import { Inject, Injectable, Logger } from '@nestjs/common'
import { GhostMarketplaceClient, TokenTransferItem } from './api/ghost-marketplace.client'
import { HistoryService, parseTransferTime } from './history.service'

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

function httpStatus(e: unknown): number | null {
  const r = (e as { response?: { status?: number }; status?: number }) ?? {}
  if (typeof r.status === 'number') return r.status
  if (r.response && typeof r.response.status === 'number') return r.response.status
  return null
}

export type HistorySyncMode = 'full' | 'latest'

type MappedTransfer = ReturnType<HistorySyncService['mapItem']>

@Injectable()
export class HistorySyncService {
  private readonly logger = new Logger(HistorySyncService.name)

  constructor(
    @Inject(GhostMarketplaceClient) private readonly client: GhostMarketplaceClient,
    @Inject(HistoryService) private readonly history: HistoryService
  ) {}

  mapItem(it: TokenTransferItem) {
    return {
      tokenId: Number(it.token_id),
      gameName: String(it.game_name ?? '').trim() || null,
      sellerId: String(it.seller ?? ''),
      buyerId: String(it.buyer ?? ''),
      itemName: String(it.item_name ?? ''),
      price: Number(it.price ?? 0),
      currency: String(it.currency ?? 'NUMI'),
      txHash: String(it.tx_hash ?? ''),
      imageUrl: String(it.image_url ?? '') || null,
      createdAt: parseTransferTime(String(it.time ?? ''))
    }
  }

  /**
   * Inline owner resolution during sync: detail 200 → buyer username = ownerName;
   * detail 400 → claimed = true (skip forever). Network/5xx → retry on next full backfill.
   */
  private async resolveOwnerInline(
    tokenId: number,
    gameName: string | null,
    fallbackService = 'GhostMGlobal'
  ): Promise<{ buyerUsername: string | null; claimed: boolean }> {
    try {
      const detail = await this.client.detailStrict(tokenId, gameName ?? fallbackService)
      const ownerName = detail?.ownerName?.trim()
      return { buyerUsername: ownerName ? ownerName : null, claimed: false }
    } catch (e) {
      if (httpStatus(e) === 400) {
        this.logger.log(`[HistorySync] token ${tokenId} 400 → claimed=true`)
        return { buyerUsername: null, claimed: true }
      }
      return { buyerUsername: null, claimed: false }
    }
  }

  /** Full backfill: offset is a 0-based page index (0 = page 1), like search-redis. Only GhostMGlobal transfers are saved. */
  async backfill(opts: { limit?: number; concurrency?: number; maxPages?: number } = {}) {
    const limit = opts.limit ?? 150
    const concurrency = opts.concurrency ?? 3
    // A full scan of the upstream API is unbounded by nature. Cap it so a single
    // admin click cannot monopolise a small shared box indefinitely.
    const maxPages = opts.maxPages ?? 200
    let page = 0
    let synced = 0
    let enriched = 0
    let claimed = 0
    let skipped = 0
    let truncated = false
    let total = Number.MAX_SAFE_INTEGER
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.client.tokenTransfers({ limit, offset: page })
      total = Number(res.count ?? 0)
      const lists = res.lists ?? []
      if (lists.length === 0) break
      const mapped = lists.map((it) => this.mapItem(it))
      skipped += mapped.filter((m) => m.gameName !== 'GhostMGlobal').length
      const valid = mapped.filter((m) => m.txHash && !isNaN(m.createdAt.getTime()) && m.gameName === 'GhostMGlobal')
      const resolved = await pool(concurrency, valid, (m) => this.resolveOwnerInline(m.tokenId, m.gameName))
      for (const m of valid) {
        const r = resolved.get(m) ?? { buyerUsername: null, claimed: false }
        await this.history.upsertFromApi({ ...m, buyerUsername: r.buyerUsername, claimed: r.claimed })
        synced++
        if (r.buyerUsername) enriched++
        if (r.claimed) claimed++
      }
      page += 1
      this.logger.log(`[HistorySync] backfill page=${page}/${maxPages} synced=${synced}/${total} skipped=${skipped}`)
      if (lists.length < limit || page * limit >= total) break
      if (page >= maxPages) {
        truncated = true
        this.logger.warn(`[HistorySync] backfill stopped at page cap ${maxPages} with ${synced}/${total} synced`)
        break
      }
    }
    return { synced, total, enriched, claimed, skipped, truncated, pages: page }
  }

  /** Latest: fetch first page only, stop at first known txHash. Only GhostMGlobal transfers are saved. */
  async refreshLatest(opts: { limit?: number; concurrency?: number } = {}) {
    const limit = opts.limit ?? 150
    const concurrency = opts.concurrency ?? 3
    const res = await this.client.tokenTransfers({ limit, offset: 0 })
    const lists = res.lists ?? []
    const fresh: MappedTransfer[] = []
    let skipped = 0
    for (const it of lists) {
      const mapped = this.mapItem(it)
      if (!mapped.txHash) continue
      if (mapped.gameName !== 'GhostMGlobal') {
        skipped++
        continue
      }
      if (await this.history.existsByTxHash(mapped.txHash)) {
        this.logger.log(`[HistorySync] latest break at known tx ${mapped.txHash}`)
        break
      }
      if (isNaN(mapped.createdAt.getTime())) continue
      fresh.push(mapped)
    }
    const resolved = await pool(concurrency, fresh, (m) => this.resolveOwnerInline(m.tokenId, m.gameName))
    let synced = 0
    let enriched = 0
    let claimed = 0
    for (const m of fresh) {
      const r = resolved.get(m) ?? { buyerUsername: null, claimed: false }
      await this.history.upsertFromApi({ ...m, buyerUsername: r.buyerUsername, claimed: r.claimed })
      synced++
      if (r.buyerUsername) enriched++
      if (r.claimed) claimed++
    }
    return { synced, total: Number(res.count ?? 0), enriched, claimed, skipped }
  }
}
