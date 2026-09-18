import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ScheduleModule } from '@nestjs/schedule'
import { MarketplaceModule } from './modules/marketplace/marketplace.module'
import { MarketplaceItemEntity } from './modules/marketplace/entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from './modules/marketplace/entities/marketplace-item-detail.entity'
import { MarketplaceItemAttributeEntity } from './modules/marketplace/entities/marketplace-item-attribute.entity'
import { MarketplaceItemDataEntity } from './modules/marketplace/entities/marketplace-item-data.entity'
import { MarketplaceItemInfoEntity } from './modules/marketplace/entities/marketplace-item-info.entity'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      // Electron prod: userData path is injected at runtime in main.ts via GHOSTMPLAY_DB
      database: process.env.GHOSTMPLAY_DB ?? 'ghostmplay.db',
      entities: [
        MarketplaceItemEntity,
        MarketplaceItemDetailEntity,
        MarketplaceItemAttributeEntity,
        MarketplaceItemDataEntity,
        MarketplaceItemInfoEntity
      ],
      synchronize: true, // dev auto-create; for prod use migrations (synchronize:false + migrationRun)
      logging: false
    }),
    MarketplaceModule
  ]
})
export class AppModule {}
