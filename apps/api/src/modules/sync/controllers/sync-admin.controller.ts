import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { SyncOrchestratorService, type SyncStatusSnapshot } from '../sync-orchestrator.service'
import { AdminGuard } from '../../auth/guards'
import type { SyncKind, SyncMode } from '../entities'

export class EnqueueSyncDto {
  @IsIn(['marketplace', 'history'])
  kind!: SyncKind

  @IsOptional()
  @IsIn(['all', 'latest', 'full'])
  mode?: SyncMode

  @IsOptional()
  @IsString()
  @MaxLength(120)
  itemName?: string

  /** Upper bound for a backfill. The API has no natural end, so this is the guard rail. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  maxPages?: number
}

/**
 * Sync is admin-only. It is the only expensive, third-party-hammering operation
 * in the app, so leaving it to every signed-up visitor would be an easy way to
 * get the shared box rate-limited upstream.
 */
@Controller('api/admin/sync')
@UseGuards(AdminGuard)
export class SyncAdminController {
  constructor(private readonly orchestrator: SyncOrchestratorService) {}

  /** One entry per kind, so each page can render its own progress. */
  @Get('status')
  status(): Promise<SyncStatusSnapshot> {
    return this.orchestrator.status()
  }

  /** Claims the lock and returns immediately; poll `status` for progress. */
  @Post()
  @HttpCode(202)
  enqueue(@Body() dto: EnqueueSyncDto) {
    return this.orchestrator.enqueue({
      kind: dto.kind,
      // History uses "full" for a backfill and "latest" for incremental;
      // marketplace uses "all"/"latest". Default to the incremental one, which is
      // bounded by what is new rather than by the size of the history.
      mode: dto.mode ?? 'latest',
      itemName: dto.itemName,
      maxPages: dto.maxPages,
    })
  }
}
