import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ScheduleModule } from '@nestjs/schedule'
import { MarketplaceModule } from './modules/marketplace/marketplace.module'
import { MarketplaceItemEntity } from './modules/marketplace/entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from './modules/marketplace/entities/marketplace-item-detail.entity'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqljs',
      // Electron prod: userData path is injected at runtime in main.ts via GHOSTMPLAY_DB
      // sql.js uses WASM, no native, avoids GLIBC_2.38 / ABI mismatch on Linux
      location: process.env.GHOSTMPLAY_DB ?? 'ghostmplay.db',
      autoSave: true,
      entities: [MarketplaceItemEntity, MarketplaceItemDetailEntity],
      synchronize: true, // dev auto-create; for prod use migrations (synchronize:false + migrationRun)
      logging: process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1' ? ['query', 'error', 'warn'] : ['error', 'warn']
    }),
    MarketplaceModule
  ]
})
export class AppModule {}
