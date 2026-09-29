import { Controller, Get, Param, Query } from '@nestjs/common'
import { MarketplaceService } from '../marketplace.service'
import { GhostMarketplaceClient } from '../api/ghost-marketplace.client'
import { MarketplaceListQueryDto } from '../dto/marketplace-list-query.dto'
import { TokenIdParam } from '../dto/token-id.param'
import { env } from '../../../config/env'
import type { LiveItemDetailResponse } from '@ghostmplay/shared'

@Controller('api/marketplace')
export class MarketplaceController {
  constructor(
    private readonly marketplace: MarketplaceService,
    private readonly client: GhostMarketplaceClient
  ) {}

  @Get('items')
  async list(@Query() query: MarketplaceListQueryDto) {
    const res = await this.marketplace.list(query)
    if (env.logQuery) {
      console.log(`[GET /api/marketplace/items] total=${res.total} returned=${res.data.length} page=${res.page}`)
    }
    return res
  }

  @Get('filters')
  filters() {
    return this.marketplace.getDistinctFilters()
  }

  @Get('items/:tokenId')
  get(@Param('tokenId', TokenIdParam) tokenId: number) {
    return this.marketplace.getByTokenId(tokenId)
  }

  /**
   * Display-only live fetch straight from the upstream API — never persisted.
   * A null body means the item is no longer listed, which the client renders as "sold".
   */
  @Get('items/:tokenId/live')
  async getLive(@Param('tokenId', TokenIdParam) tokenId: number): Promise<LiveItemDetailResponse | null> {
    return this.client.detail(tokenId).catch(() => null)
  }
}
