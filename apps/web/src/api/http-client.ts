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

export type SyncKind = 'marketplace' | 'history'

/**
 * One row of sync state, per kind. There is no job list and no queue: the server
 * serialises runs with a lock keyed by kind, so a second trigger joins the run
 * already in flight instead of adding a row.
 */
export interface SyncKindStatus {
  kind: SyncKind
  running: boolean
  runningSince: string | null
  mode: string | null
  lastStatus: 'running' | 'done' | 'failed' | 'interrupted' | null
  lastFinishedAt: string | null
  /** Item count from the last completed run, lifted out of the stats blob. */
  lastSynced: number | null
  /** Raw scraper stats, for kind-specific extras such as history's enriched/claimed. */
  lastStats: Record<string, number> | null
  lastError: string | null
}

export interface SyncStatus {
  marketplace: SyncKindStatus
  history: SyncKindStatus
}

/** `deduped` means a run of this kind was already going and this call joined it. */
export interface EnqueueSyncResult {
  deduped: boolean
  kind: SyncKind
  mode: string
  runningSince: string | null
}

/** Per-kind row counts, so the UI can report what a clear actually removed. */
export interface ClearSyncDataResult {
  kind: SyncKind
  deleted: { items: number; details: number } | { transfers: number }
}

export interface WebApiAccount {
  id: number
  /** The verified Google address. */
  email: string | null
  role: 'user' | 'admin'
}

export interface WebApi {
  auth: {
    me(): Promise<WebApiAccount | null>
    logout(): Promise<void>
    /** URL to send the browser to, to begin Google sign-in. */
    googleStartUrl(next?: string): string
    /** Whether Google sign-in is offered at all. */
    googleEnabled(): Promise<boolean>
  }
  /** Admin-only. Scraper work is locked and not awaited — poll `sync.status` for progress. */
  admin: {
    sync: {
      status(): Promise<SyncStatus>
      /**
       * `mode` is narrowed rather than `string` because the server accepts all
       * three values for either kind but only dispatches on `all` for marketplace
       * and `full` for history — a mismatch is silently downgraded to the
       * incremental run instead of rejected. See lib/syncPanel.backfillMode.
       */
      enqueue(input: { kind: SyncKind; mode?: 'all' | 'latest' | 'full'; itemName?: string }): Promise<EnqueueSyncResult>
      /**
       * Deletes everything a kind of scraper owns. Irreversible, admin-only, and
       * 409 while that kind is running. `confirm` is a body field rather than a UI
       * affordance, so a stale script cannot empty a table by accident.
       */
      clear(input: { kind: SyncKind; confirm: true }): Promise<ClearSyncDataResult>
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
    logout: () => post('/auth/logout'),
    // A top-level navigation, not a fetch: the CSP is `script-src 'self'` and the
    // browser has to leave for accounts.google.com and come back to the callback.
    // `next` is validated server-side; an unsafe value simply falls back to the
    // marketplace list, so it is safe to pass the current path straight through.
    googleStartUrl: (next) =>
      `/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`,
    googleEnabled: async () => (await get<{ googleEnabled: boolean }>('/auth/providers')).googleEnabled,
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
      enqueue: (input) => post('/admin/sync', input),
      clear: (input) => post('/admin/sync/clear', input),
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
