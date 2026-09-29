import type {
  CreateFavoriteInput,
  HistoryListQuery,
  LiveItemDetailResponse,
  MarketplaceFavorite,
  MarketplaceListQuery,
  UpdateFavoriteInput,
} from '@ghostmplay/shared'

const BASE = '/api'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Query values arrive as scalars or arrays. Arrays are folded to a comma-joined
 * string because that is what the API DTOs and services both understand.
 * Empty strings are dropped so `?q=` never becomes a "match everything empty" filter.
 */
function buildQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      const joined = value
        .map((v) => String(v).trim())
        .filter(Boolean)
        .join(',')
      if (joined) sp.set(key, joined)
      continue
    }
    if (typeof value === 'boolean') {
      sp.set(key, String(value))
      continue
    }
    const str = String(value).trim()
    if (str) sp.set(key, str)
  }
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      // Session cookie is first-party and SameSite=Strict, so this is enough.
      credentials: 'include',
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    })
  } catch (cause) {
    throw new ApiError(`Network error: ${(cause as Error).message}`, 0)
  }

  // Always drain the body, including for 204. Leaving the stream unread makes the
  // browser log ERR_ABORTED when the SPA navigates away mid-request.
  const text = await res.text()

  if (res.status === 204) return undefined as T

  const body = text ? safeJson(text) : null

  if (!res.ok) {
    const message =
      (body && typeof body === 'object' && 'message' in body
        ? Array.isArray((body as { message: unknown }).message)
          ? ((body as { message: string[] }).message).join(', ')
          : String((body as { message: unknown }).message)
        : null) ?? `Request failed with ${res.status}`
    throw new ApiError(message, res.status)
  }

  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const get = <T>(path: string, query?: Record<string, unknown>): Promise<T> =>
  request<T>(`${path}${buildQuery(query)}`)

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })

const del = (path: string): Promise<void> => request<void>(path, { method: 'DELETE' })

/**
 * Only the upstream NUMI item page may be opened in a new tab. The renderer
 * previously delegated this to Electron's `shell.openExternal`, which needed an
 * allow-list for exactly the same reason.
 */
const ALLOWED_EXTERNAL = /^https:\/\/market\.numine\.io\/games\/GhostM\/nfts\/\d+$/

export interface SyncJob {
  id: number
  kind: 'marketplace' | 'history'
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'
  trigger: 'cron' | 'admin'
  mode: string
  itemName: string | null
  maxPages: number
  stats: Record<string, number> | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface SyncStatus {
  running: SyncJob | null
  queued: SyncJob | null
  lastCompleted: { kind: string; finishedAt: string; stats: Record<string, number> | null } | null
  recent: SyncJob[]
}

export interface WebApiAccount {
  id: number
  username: string
  role: 'user' | 'admin'
}

export interface WebApi {
  auth: {
    me(): Promise<WebApiAccount | null>
    login(username: string, password: string): Promise<WebApiAccount>
    register(username: string, password: string): Promise<WebApiAccount>
    logout(): Promise<void>
  }
  /** Admin-only. Scraper work is queued, not awaited — poll `sync.status` for progress. */
  admin: {
    sync: {
      status(): Promise<SyncStatus>
      jobs(limit?: number): Promise<SyncJob[]>
      job(id: number): Promise<SyncJob>
      enqueue(input: { kind: 'marketplace' | 'history'; mode?: string; itemName?: string; maxPages?: number }): Promise<{ job: SyncJob; deduped: boolean }>
    }
  }
  marketplace: {
    list(query?: MarketplaceListQuery): Promise<{ data: unknown[]; total: number; page: number; limit: number }>
    get(tokenId: number): Promise<unknown>
    getLive(tokenId: number): Promise<LiveItemDetailResponse | null>
    filters(): Promise<{ equipmentTypes: string[]; gradeEffects: string[] }>
    equipmentTypes(): Promise<string[]>
    gradeEffects(): Promise<string[]>
  }
  favorites: {
    list(): Promise<MarketplaceFavorite[]>
    create(input: CreateFavoriteInput): Promise<MarketplaceFavorite>
    update(id: number, input: UpdateFavoriteInput): Promise<MarketplaceFavorite>
    remove(id: number): Promise<void>
    get(id: number): Promise<MarketplaceFavorite | null>
  }
  history: {
    list(query?: HistoryListQuery): Promise<{ data: unknown[]; total: number; page: number; limit: number }>
    filters(): Promise<{ gameNames: string[]; sellerNames: string[]; buyerNames: string[] }>
    gameNames(): Promise<string[]>
    sellerNames(): Promise<string[]>
    buyerNames(): Promise<string[]>
  }
  shell: {
    openExternal(url: string): Promise<void>
  }
}

export const api: WebApi = {
  auth: {
    me: async () => (await get<{ account: WebApiAccount | null }>('/auth/me')).account,
    login: (username, password) => post('/auth/login', { username, password }),
    register: (username, password) => post('/auth/register', { username, password }),
    logout: () => post('/auth/logout'),
  },

  marketplace: {
    list: (query) => get('/marketplace/items', query as Record<string, unknown>),
    get: (tokenId) => get(`/marketplace/items/${tokenId}`),
    getLive: (tokenId) => get(`/marketplace/items/${tokenId}/live`),
    filters: () => get('/marketplace/filters'),
    equipmentTypes: async () => (await get<{ equipmentTypes: string[] }>('/marketplace/filters')).equipmentTypes,
    gradeEffects: async () => (await get<{ gradeEffects: string[] }>('/marketplace/filters')).gradeEffects,
  },

  favorites: {
    list: () => get('/favorites'),
    create: (input) => post('/favorites', input),
    update: (id, input) => patch(`/favorites/${id}`, input),
    remove: (id) => del(`/favorites/${id}`),
    get: (id) => get(`/favorites/${id}`),
  },

  admin: {
    sync: {
      status: () => get('/admin/sync/status'),
      jobs: (limit = 10) => get('/admin/sync/jobs', { limit }),
      job: (id) => get(`/admin/sync/jobs/${id}`),
      enqueue: (input) => post('/admin/sync', input),
    },
  },

  history: {
    list: (query) => get('/history/transfers', query as Record<string, unknown>),
    filters: () => get('/history/filters'),
    gameNames: async () => (await get<{ gameNames: string[] }>('/history/filters')).gameNames,
    sellerNames: async () => (await get<{ sellerNames: string[] }>('/history/filters')).sellerNames,
    buyerNames: async () => (await get<{ buyerNames: string[] }>('/history/filters')).buyerNames,
  },

  shell: {
    openExternal: async (url) => {
      if (typeof url !== 'string' || !ALLOWED_EXTERNAL.test(url)) {
        throw new ApiError('Blocked external URL', 400)
      }
      window.open(url, '_blank', 'noopener,noreferrer')
    },
  },
}
