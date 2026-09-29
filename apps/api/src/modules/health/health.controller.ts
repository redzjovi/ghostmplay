import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

@Controller('api/health')
export class HealthController {
  private readonly startedAt = Date.now()

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async check() {
    let database: 'up' | 'down' = 'up'
    try {
      await this.dataSource.query('SELECT 1')
    } catch {
      database = 'down'
    }

    if (database === 'down') {
      throw new ServiceUnavailableException('database unreachable')
    }

    return {
      status: 'ok',
      database,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    }
  }
}
