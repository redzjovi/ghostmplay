import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { SyncJobEntity } from './entities'
import { SyncOrchestratorService } from './sync-orchestrator.service'
import { SyncSchedulerService } from './sync-scheduler.service'
import { SyncAdminController } from './controllers/sync-admin.controller'
import { MarketplaceModule } from '../marketplace/marketplace.module'

@Module({
  imports: [TypeOrmModule.forFeature([SyncJobEntity]), MarketplaceModule],
  controllers: [SyncAdminController],
  providers: [SyncOrchestratorService, SyncSchedulerService],
  exports: [SyncOrchestratorService],
})
export class SyncModule {}
