import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { Transform } from 'class-transformer'
import { toOptionalInt } from '../../../common/transforms'
import { SyncOrchestratorService, type SyncStatusSnapshot } from '../sync-orchestrator.service'
import { AdminGuard } from '../../auth/guards'
import type { SyncJobEntity } from '../entities'

export class EnqueueSyncDto {
  @IsIn(['marketplace', 'history'])
  kind!: 'marketplace' | 'history'

  @IsOptional()
  @IsIn(['all', 'latest', 'full'])
  mode?: 'all' | 'latest' | 'full'

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

export class JobListQueryDto {
  @IsOptional()
  @Transform(toOptionalInt)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number
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

  @Get('status')
  status(): Promise<SyncStatusSnapshot> {
    return this.orchestrator.status()
  }

  @Get('jobs')
  jobs(@Query() query: JobListQueryDto): Promise<SyncJobEntity[]> {
    return this.orchestrator.recentJobs(query.limit)
  }

  @Get('jobs/:id')
  async job(@Param('id', ParseIntPipe) id: number): Promise<SyncJobEntity> {
    const job = await this.orchestrator.getJob(id)
    if (!job) throw new NotFoundException(`Sync job ${id} not found`)
    return job
  }

  /** Enqueues and returns immediately; poll `jobs/:id` or `status` for progress. */
  @Post()
  @HttpCode(202)
  async enqueue(@Body() dto: EnqueueSyncDto) {
    // History uses "full" for a backfill and "latest" for incremental;
    // marketplace uses "all"/"latest". Default each to its own latest mode.
    const mode = dto.mode ?? 'latest'
    const { job, deduped } = await this.orchestrator.enqueue({
      kind: dto.kind,
      mode,
      trigger: 'admin',
      itemName: dto.itemName ?? null,
      maxPages: dto.maxPages,
    })
    return { job, deduped }
  }
}
