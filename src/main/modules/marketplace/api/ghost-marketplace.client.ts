import { Injectable, Logger } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
import { firstValueFrom } from 'rxjs'
import type { MarketplaceListQuery } from '@shared/types'

/**
 * Direct hit ghostmplay API — inspected from DevTools.
 * TODO: paste real curl: baseURL, headers (Authorization/cookie), list+detail endpoints.
 * This stub uses env GHOSTMPLAY_API_BASE + GHOSTMPLAY_API_HEADERS_JSON.
 * SyncService will call list() / detail().
 */
@Injectable()
export class GhostMarketplaceClient {
  private readonly logger = new Logger(GhostMarketplaceClient.name)
  private readonly baseURL = process.env.GHOSTMPLAY_API_BASE ?? 'https://api.ghostmplay.example'
  private readonly headers: Record<string, string> = (() => {
    try {
      return process.env.GHOSTMPLAY_API_HEADERS_JSON ? JSON.parse(process.env.GHOSTMPLAY_API_HEADERS_JSON) : {}
    } catch {
      return {}
    }
  })()

  constructor(private readonly http: HttpService) {}

  /** List marketplace items — map API pagination to local DB */
  async list(query: MarketplaceListQuery = {}) {
    // TODO: replace path + params with real DevTools inspection
    // Example: GET /marketplace/items?page=1&limit=20&equipmentType=Weapon&q=
    const url = `${this.baseURL}/marketplace/items`
    this.logger.debug(`GET ${url} ${JSON.stringify(query)}`)
    const { data } = await firstValueFrom(
      this.http.get(url, {
        headers: this.headers,
        params: {
          page: query.page ?? 1,
          limit: query.limit ?? 20,
          q: query.q,
          equipmentType: query.equipmentType,
          gradeEffect: query.gradeEffect,
          level: query.level
        },
        timeout: 15000
      })
    )
    // Expect { data: [...], total, page } or { items: [...] } — normalize downstream
    return data
  }

  async detail(tokenId: number) {
    const url = `${this.baseURL}/marketplace/items/${tokenId}`
    this.logger.debug(`GET ${url}`)
    const { data } = await firstValueFrom(
      this.http.get(url, { headers: this.headers, timeout: 15000 })
    )
    return data
  }
}
