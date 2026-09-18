import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { HttpModule } from '@nestjs/axios'
import { MarketplaceItemEntity } from './entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from './entities/marketplace-item-detail.entity'
import { MarketplaceItemAttributeEntity } from './entities/marketplace-item-attribute.entity'
import { MarketplaceItemDataEntity } from './entities/marketplace-item-data.entity'
import { MarketplaceItemInfoEntity } from './entities/marketplace-item-info.entity'
import { MarketplaceService } from './marketplace.service'
import { GhostMarketplaceClient } from './api/ghost-marketplace.client'
import { SyncService } from './sync.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MarketplaceItemEntity,
      MarketplaceItemDetailEntity,
      MarketplaceItemAttributeEntity,
      MarketplaceItemDataEntity,
      MarketplaceItemInfoEntity
    ]),
    HttpModule.register({ timeout: 15000, maxRedirects: 3 })
  ],
  providers: [MarketplaceService, GhostMarketplaceClient, SyncService],
  exports: [MarketplaceService, SyncService, GhostMarketplaceClient]
})
export class MarketplaceModule {}
