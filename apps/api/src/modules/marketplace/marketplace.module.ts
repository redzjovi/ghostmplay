import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { HttpModule } from '@nestjs/axios'
import { MarketplaceItemEntity } from './entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from './entities/marketplace-item-detail.entity'
import { MarketplaceFavoriteEntity } from './entities/marketplace-favorite.entity'
import { UserEntity } from './entities/user.entity'
import { MarketplaceTokenTransferEntity } from './entities/marketplace-token-transfer.entity'
import { MarketplaceService } from './marketplace.service'
import { GhostMarketplaceClient } from './api/ghost-marketplace.client'
import { SyncService } from './sync.service'
import { HistoryService } from './history.service'
import { HistorySyncService } from './history-sync.service'
import { MarketplaceController } from './controllers/marketplace.controller'
import { HistoryController } from './controllers/history.controller'
import { FavoritesController } from './controllers/favorites.controller'

@Module({
  imports: [
    TypeOrmModule.forFeature([MarketplaceItemEntity, MarketplaceItemDetailEntity, MarketplaceFavoriteEntity, UserEntity, MarketplaceTokenTransferEntity]),
    HttpModule.register({ timeout: 15000, maxRedirects: 3 })
  ],
  controllers: [MarketplaceController, HistoryController, FavoritesController],
  providers: [MarketplaceService, GhostMarketplaceClient, SyncService, HistoryService, HistorySyncService],
  exports: [MarketplaceService, SyncService, GhostMarketplaceClient, HistoryService, HistorySyncService]
})
export class MarketplaceModule {}
