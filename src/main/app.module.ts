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
      type: 'sqljs',
      // Electron prod: userData path is injected at runtime in main.ts via GHOSTMPLAY_DB
      // sql.js uses WASM, no native, avoids GLIBC_2.38 / ABI mismatch on Linux
      location: process.env.GHOSTMPLAY_DB ?? 'ghostmplay.db',
      autoSave: true,
      entities: [
        MarketplaceItemEntity,
        MarketplaceItemDetailEntity,
        MarketplaceItemAttributeEntity,
        MarketplaceItemDataEntity,
        MarketplaceItemInfoEntity
      ],
      synchronize: true, // dev auto-create; for prod use migrations (synchronize:false + migrationRun)
      logging: process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1' ? ['query', 'error', 'warn'] : ['error', 'warn']
    }),
    MarketplaceModule
  ]
})
export class AppModule {}
