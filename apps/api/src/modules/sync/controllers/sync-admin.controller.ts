import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import { SyncOrchestratorService, type SyncStatusSnapshot, type ClearResult } from '../sync-orchestrator.service'
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
}

export class ClearSyncDataDto {
  @IsIn(['marketplace', 'history'])
  kind!: SyncKind

  /**
   * Must be sent as `true`. Not a UI affordance — the dialog in DataView does its
   * own confirming — but a body field that a stale script or a replayed request
   * cannot satisfy by accident, so the table is only ever emptied deliberately.
   */
  @IsBoolean()
  confirm!: boolean
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
    })
  }

  /**
   * Deletes everything one kind of scraper owns. Irreversible.
   *
   * POST rather than DELETE because it carries a body, which DELETE does not
   * reliably support. Refused with 409 while that kind is being scraped, so a
   * clear can never race an in-flight run.
   */
  @Post('clear')
  @HttpCode(200)
  clear(@Body() dto: ClearSyncDataDto): Promise<ClearResult> {
    return this.orchestrator.clear(dto.kind)
  }
}
