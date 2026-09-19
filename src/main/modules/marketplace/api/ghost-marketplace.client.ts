import { Inject, Injectable, Logger } from '@nestjs/common'
import { HttpService } from '@nestjs/axios'
import { firstValueFrom } from 'rxjs'

export interface SearchRedisItem {
  item_id: number
  view_count: number
  price: number
  created_at: number // epoch seconds
  token_id: string
  uid: string
  game_name: string
  seller: string
  item_name: string
  currency: string
  image_url: string
  trait_pairs: string[] // ["Level=0","Grade Effect=Legacy"]
  trait_nums: Record<string, number>
}

export interface SearchRedisResponse {
  count: number
  ipfs: string
  items: SearchRedisItem[]
}

@Injectable()
export class GhostMarketplaceClient {
  private readonly logger = new Logger(GhostMarketplaceClient.name)
  private readonly baseURL = 'https://market-api.numine.io'
  private readonly headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Language': 'en,id;q=0.9',
    Connection: 'keep-alive',
    Origin: 'https://market.numine.io',
    Referer: 'https://market.numine.io/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"'
  }

  constructor(@Inject(HttpService) private readonly http: HttpService) {}

  /** Hit search-redis exactly as curl, with sort=created_at_desc, limit 12 (offset=page) */
  async searchRedis(opts: {
    serviceName?: string
    itemName?: string
    sort?: string
    offset?: number
    limit?: number
  } = {}): Promise<SearchRedisResponse> {
    const params = {
      serviceName: opts.serviceName ?? 'GhostMGlobal',
      sort: opts.sort ?? 'created_at_desc',
      offset: opts.offset ?? 0,
      limit: opts.limit ?? 12,
      ...(opts.itemName ? { itemName: opts.itemName } : {})
    }
    const url = `${this.baseURL}/api/users/market/search-redis`
    this.logger.log(`GET ${url} offset=${params.offset} limit=${params.limit} sort=${params.sort}`)
    const { data } = await firstValueFrom(
      this.http.get<{ message?: string; data?: SearchRedisResponse } & SearchRedisResponse>(url, {
        headers: this.headers,
        params,
        timeout: 15000
      })
    )
    // API wraps in {message, data:{count,ipfs,items}} (see curl response)
    const unwrapped = (data as { data?: SearchRedisResponse }).data ?? (data as SearchRedisResponse)
    return unwrapped as SearchRedisResponse
  }

  // Keep for backward compat, maps to searchRedis
  async list(query: { q?: string; page?: number; limit?: number } = {}) {
    const page = query.page ?? 1
    const limit = query.limit ?? 20
    const offset = (page - 1) * limit
    return this.searchRedis({ itemName: query.q, offset, limit, sort: 'created_at_desc' })
  }

  async detail(_tokenId: number) {
    // TODO: detail endpoint not yet provided
    return null
  }
}
