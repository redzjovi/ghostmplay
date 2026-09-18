import { Injectable, Logger } from '@nestjs/common'
import { GhostMarketplaceClient } from './api/ghost-marketplace.client'
import { MarketplaceService } from './marketplace.service'

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name)

  constructor(
    private readonly client: GhostMarketplaceClient,
    private readonly marketplace: MarketplaceService
  ) {}

  /**
   * Pull from ghostmplay API -> upsert into SQLite.
   * Normalizer: adapt raw API shape to note.txt columns. TODO: adjust mapping once real response is pasted.
   */
  async refresh(opts: { page?: number; limit?: number; q?: string } = {}) {
    const raw = await this.client.list({ page: opts.page ?? 1, limit: opts.limit ?? 20, q: opts.q })
    // Normalize: handle both { data: [...] } and { items: [...] } shapes
    const items: unknown[] = (raw?.data ?? raw?.items ?? raw ?? []) as unknown[]
    if (!Array.isArray(items)) {
      this.logger.warn(`Unexpected list shape: ${JSON.stringify(raw).slice(0, 400)}`)
      return { synced: 0 }
    }
    let synced = 0
    for (const it of items) {
      const r = it as Record<string, unknown>
      // Map common API fields — override once real shape known
      try {
        const tokenId = Number(r.tokenId ?? r.token_id ?? r.id)
        if (!Number.isFinite(tokenId)) continue
        await this.marketplace.upsertFromApi({
          tokenId,
          ownerId: String(r.ownerId ?? r.owner_id ?? ''),
          ownerName: String(r.ownerName ?? r.owner_name ?? ''),
          sellerId: String(r.sellerId ?? r.seller_id ?? ''),
          imageUrl: String(r.imageUrl ?? r.image_url ?? r.image ?? ''),
          name: String(r.name ?? r.title ?? ''),
          currency: String((r.currency as string) ?? 'NUMI'),
          price: Number(r.price ?? 0),
          gradeEffect: String(r.gradeEffect ?? r.grade_effect ?? 'Normal'),
          level: Number(r.level ?? 0),
          enchant: Number(r.enchant ?? 0),
          equipmentType: String(r.equipmentType ?? r.equipment_type ?? ''),
          detail: r.detail as never
        })
        synced++
      } catch (e) {
        this.logger.warn(`skip item normalize: ${(e as Error).message}`)
      }
    }
    this.logger.log(`Synced ${synced}/${items.length} items`)
    return { synced }
  }
}
