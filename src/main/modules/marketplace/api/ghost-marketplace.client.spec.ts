import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GhostMarketplaceClient, SearchRedisResponse } from './ghost-marketplace.client'
import { HttpService } from '@nestjs/axios'
import { of } from 'rxjs'

function createClient(mockGet: ReturnType<typeof vi.fn>, mockPost?: ReturnType<typeof vi.fn>) {
  const httpService = {
    get: mockGet,
    post: mockPost ?? vi.fn(),
    // HttpService has other methods but not needed
  } as unknown as HttpService
  const client = new GhostMarketplaceClient(httpService)
  // silence logger
  vi.spyOn(client['logger'], 'log').mockImplementation(() => {})
  vi.spyOn(client['logger'], 'error').mockImplementation(() => {})
  vi.spyOn(client['logger'], 'debug').mockImplementation(() => {})
  return client
}

const sampleItems = [
  {
    item_id: 1,
    view_count: 10,
    price: 1250,
    created_at: 1700000000,
    token_id: '1001',
    uid: 'player1',
    game_name: 'Ghost',
    seller: 'seller1',
    item_name: 'Blade of Ghost +7',
    currency: 'NUMI',
    image_url: 'https://example.com/img.png',
    trait_pairs: ['Level=65', 'Equipment Type=Weapon', 'Grade Effect=Rare', 'Enchant=7'],
    trait_nums: { Level: 65, Enchant: 7 },
  },
]

const wrappedResponse = {
  data: {
    message: 'ok',
    data: {
      count: 1,
      ipfs: 'https://ipfs.example.com',
      items: sampleItems,
    } as SearchRedisResponse,
  },
}

const unwrappedResponse = {
  data: {
    count: 1,
    ipfs: 'https://ipfs.example.com',
    items: sampleItems,
  } as SearchRedisResponse,
}

describe('GhostMarketplaceClient', () => {
  let mockGet: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGet = vi.fn()
  })

  describe('searchRedis', () => {
    it('uses default params (serviceName GhostMGlobal, sort created_at_desc, offset 0, limit 12)', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.searchRedis()
      expect(mockGet).toHaveBeenCalledTimes(1)
      const [, config] = mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }]
      expect(config.params).toEqual({
        serviceName: 'GhostMGlobal',
        sort: 'created_at_desc',
        offset: 0,
        limit: 12,
      })
    })

    it('passes custom sort/offset/limit', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.searchRedis({ sort: 'price_desc', offset: 2, limit: 24 })
      const [, config] = mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }]
      expect(config.params).toMatchObject({ sort: 'price_desc', offset: 2, limit: 24 })
    })

    it('includes itemName when provided, omits when undefined', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.searchRedis({ itemName: 'Blade' })
      let params = (mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }])[1].params
      expect(params.itemName).toBe('Blade')

      mockGet.mockClear()
      mockGet.mockReturnValue(of(wrappedResponse))
      await client.searchRedis({ itemName: undefined })
      params = (mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }])[1].params
      expect(params.itemName).toBeUndefined()

      mockGet.mockClear()
      mockGet.mockReturnValue(of(wrappedResponse))
      await client.searchRedis({ itemName: '' })
      params = (mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }])[1].params
      expect(params.itemName).toBeUndefined()
    })

    it('uses custom serviceName when provided', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.searchRedis({ serviceName: 'CustomService' })
      const params = (mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }])[1].params
      expect(params.serviceName).toBe('CustomService')
    })

    it('hits correct URL and timeout/headers', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.searchRedis()
      const [url, config] = mockGet.mock.calls[0] as [string, { headers: Record<string, string>; params: unknown; timeout: number }]
      expect(url).toBe('https://market-api.numine.io/api/users/market/search-redis')
      expect(config.timeout).toBe(15000)
      expect(config.headers.Accept).toBe('application/json')
    })

    it('unwraps {data:{count,ipfs,items}} wrapped response', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      const res = await client.searchRedis()
      expect(res.count).toBe(1)
      expect(res.ipfs).toBe('https://ipfs.example.com')
      expect(res.items).toHaveLength(1)
      expect(res.items[0].item_id).toBe(1)
    })

    it('handles unwrapped response directly', async () => {
      mockGet.mockReturnValue(of(unwrappedResponse))
      const client = createClient(mockGet)
      const res = await client.searchRedis()
      expect(res.count).toBe(1)
      expect(res.items[0].item_name).toBe('Blade of Ghost +7')
    })

    it('returns empty items when API returns no data (defensive)', async () => {
      mockGet.mockReturnValue(of({ data: { data: { count: 0, ipfs: '', items: [] } } }))
      const client = createClient(mockGet)
      const res = await client.searchRedis()
      expect(res.items).toEqual([])
      expect(res.count).toBe(0)
    })
  })

  describe('list (backward compat wrapper)', () => {
    it('maps q/page/limit to itemName/offset/limit with created_at_desc', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.list({ q: 'Ghost', page: 2, limit: 20 })
      const params = (mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }])[1].params
      expect(params).toMatchObject({ itemName: 'Ghost', offset: 20, limit: 20, sort: 'created_at_desc' })
    })

    it('uses defaults when no query provided', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.list()
      const params = (mockGet.mock.calls[0] as [string, { params: Record<string, unknown> }])[1].params
      expect(params).toMatchObject({ offset: 0, limit: 20 })
      expect(params.itemName).toBeUndefined()
    })

    it('calculates offset as (page-1)*limit', async () => {
      mockGet.mockReturnValue(of(wrappedResponse))
      const client = createClient(mockGet)
      await client.list({ page: 1, limit: 12 })
      expect((mockGet.mock.calls[0] as [string, { params: Record<string, number> }])[1].params.offset).toBe(0)
      mockGet.mockClear()
      mockGet.mockReturnValue(of(wrappedResponse))
      await client.list({ page: 3, limit: 12 })
      expect((mockGet.mock.calls[0] as [string, { params: Record<string, number> }])[1].params.offset).toBe(24)
    })
  })

  describe('detail', () => {
    it('POSTs to item-detail with tokenId and serviceName', async () => {
      const mockPost = vi.fn().mockReturnValue(of({ data: { tokenId: 61988, details: { name: '+4 Spectersoul Greaves (Fire)', image: 'Qmcz...', attributes: [] }, viewData: { datas: [], infos: [] }, ipfs: 'https://blue-known-cobra-732.mypinata.cloud', mintTime: '2026-09-20 00:06:31 +0900 KST', marketTime: '2026-09-20 00:06:31 +0900 KST' } }))
      const client = createClient(mockGet, mockPost)
      const res = await client.detail(61988)
      expect(mockPost).toHaveBeenCalledTimes(1)
      const [url, body, config] = mockPost.mock.calls[0] as [string, string, { headers: Record<string, string>; timeout: number }]
      expect(url).toBe('https://market-api.numine.io/api/users/nft/item-detail')
      expect(body).toBe('tokenId=61988&serviceName=GhostMGlobal')
      expect(config.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
      expect(config.timeout).toBe(15000)
      expect(res?.tokenId).toBe(61988)
    })

    it('uses custom serviceName when provided', async () => {
      const mockPost = vi.fn().mockReturnValue(of({ data: { tokenId: 1, details: { name: 'x', image: '', attributes: [] }, viewData: { datas: [], infos: [] } } }))
      const client = createClient(mockGet, mockPost)
      await client.detail(1, 'CustomService')
      const body = mockPost.mock.calls[0][1] as string
      expect(body).toContain('serviceName=CustomService')
    })

    it('returns null on error', async () => {
      const mockPost = vi.fn().mockReturnValue({ pipe: () => { throw new Error('network') } } as unknown as never)
      // mock to throw via firstValueFrom: make post return observable that throws
      const mockPost2 = vi.fn().mockImplementation(() => { throw new Error('network') })
      const client = createClient(mockGet, mockPost2)
      const res = await client.detail(123)
      expect(res).toBeNull()
    })

    it('unwraps {data:{...}} wrapper', async () => {
      const mockPost = vi.fn().mockReturnValue(of({ data: { data: { tokenId: 1, details: { name: 'y', image: '', attributes: [] }, viewData: { datas: [], infos: [] } } } }))
      const client = createClient(mockGet, mockPost)
      const res = await client.detail(1)
      expect(res?.details.name).toBe('y')
    })
  })
})
