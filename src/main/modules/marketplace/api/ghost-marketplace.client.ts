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
    // Log BEFORE hit API (debug)
    const logApi = process.env.LOG_API === '1' || process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1'
    if (logApi) {
      this.logger.log(`[API] → GET ${url} params=${JSON.stringify(params)} opts=${JSON.stringify(opts)}`)
      this.logger.debug(`[API] headers keys=${Object.keys(this.headers).join(',')}`)
    } else {
      this.logger.log(`GET ${url} offset=${params.offset} limit=${params.limit} sort=${params.sort}`)
    }
    let data: { message?: string; data?: SearchRedisResponse } & SearchRedisResponse
    try {
      const res = await firstValueFrom(
        this.http.get<{ message?: string; data?: SearchRedisResponse } & SearchRedisResponse>(url, {
          headers: this.headers,
          params,
          timeout: 15000
        })
      )
      data = res.data
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`[API] ✗ GET ${url} params=${JSON.stringify(params)} error=${msg}`)
      throw e
    }
    if (logApi) {
      const preview = data as unknown as Record<string, unknown>
      const inner = (preview.data as Record<string, unknown> | undefined) ?? preview
      const count = (inner as Record<string, unknown>).count
      const itemsLen = Array.isArray((inner as Record<string, unknown>).items) ? ((inner as Record<string, unknown>).items as unknown[]).length : 'n/a'
      this.logger.log(`[API] ← GET ${url} count=${String(count)} items=${String(itemsLen)}`)
    }
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

  async detail(tokenId: number, serviceName = 'GhostMGlobal'): Promise<ItemDetailResponse | null> {
    const url = `${this.baseURL}/api/users/nft/item-detail`
    const body = new URLSearchParams({ tokenId: String(tokenId), serviceName }).toString()
    const logApi = process.env.LOG_API === '1' || process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1'
    if (logApi) this.logger.log(`[API] → POST ${url} tokenId=${tokenId} serviceName=${serviceName}`)
    try {
      const { data } = await firstValueFrom(
        this.http.post<{ data?: ItemDetailResponse } & ItemDetailResponse>(url, body, {
          headers: { ...this.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000
        })
      )
      const unwrapped = (data as { data?: ItemDetailResponse }).data ?? (data as ItemDetailResponse)
      if (logApi) this.logger.log(`[API] ← POST ${url} tokenId=${tokenId} name=${(unwrapped as ItemDetailResponse).details?.name ?? 'n/a'} attrs=${(unwrapped as ItemDetailResponse).details?.attributes?.length ?? 'n/a'}`)
      return unwrapped as ItemDetailResponse
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`[API] ✗ POST ${url} tokenId=${tokenId} error=${msg}`)
      return null
    }
  }
}

export interface ItemDetailResponse {
  tokenId: number
  indexId: string
  serviceName: string
  ipfs: string
  owner: string
  ownerName: string
  viewCount: number
  price: number
  details: {
    name: string
    description: string
    image: string // CID e.g. Qmcz...
    external_url: string
    tag: unknown
    attributes: { trait_type: string; value: string }[]
  }
  viewData: {
    datas: { title: string; values: unknown[]; class?: string }[]
    infos: Record<string, unknown>[]
    viewType?: string
  }
  mintTime: string | null // "2026-09-20 00:06:31 +0900 KST"
  marketTime: string | null
  state: string
  descriptionStyle?: unknown[]
}
