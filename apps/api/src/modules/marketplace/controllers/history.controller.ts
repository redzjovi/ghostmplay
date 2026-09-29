import { Controller, Get, Query } from '@nestjs/common'
import { HistoryService } from '../history.service'
import { HistoryListQueryDto } from '../dto/history-list-query.dto'
import { env } from '../../../config/env'

@Controller('api/history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('transfers')
  async list(@Query() query: HistoryListQueryDto) {
    const res = await this.history.list(query)
    if (env.logQuery) {
      console.log(`[GET /api/history/transfers] total=${res.total} returned=${res.data.length} page=${res.page}`)
    }
    return res
  }

  @Get('filters')
  filters() {
    return this.history.getDistinctHistoryFilters()
  }
}
