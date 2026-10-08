/**
 * URL <-> state codec for the two paginated list views.
 *
 * Both views treat the URL as the single source of truth: refs are derived from
 * the query string on every route change, and a change the user commits pushes a
 * history entry so Back/Forward walk the list. Everything here is pure so that
 * mapping can be unit tested without mounting a component.
 *
 * List state holds CSV strings rather than arrays. That keeps `sameState` a flat
 * field comparison, which is what lets the views recognise their own navigation
 * and skip the refetch that a popstate would otherwise trigger.
 */

export type LocationQueryLike = Record<string, string | (string | null)[] | null | undefined>

export const MARKET_PAGE_SIZES = [12, 24, 48, 96] as const
export const MARKET_DEFAULT_LIMIT = 12
export const MARKET_LIMIT_KEY = 'ghostmplay:marketplace:limit'

export const HISTORY_PAGE_SIZES = [15, 30, 60, 120] as const
export const HISTORY_DEFAULT_LIMIT = 15
export const HISTORY_LIMIT_KEY = 'ghostmplay:history:limit'

/** Trimmed string, or '' for null/undefined/non-scalars. */
export function asText(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return asText(v[0])
  return String(v).trim()
}

/**
 * Accepts both CSV (`?equipment_type=A,B`) and repeated params
 * (`?equipment_type=A&equipment_type=B`), which is what vue-router produces for
 * an array query value.
 */
export function parseArrayParam(v: unknown): string[] {
  if (!v) return []
  const raw = Array.isArray(v) ? v : [v]
  return raw.flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean)
}

/** Canonical CSV form: order preserved, blanks dropped, no trailing separator. */
export function joinCsv(values: readonly string[]): string {
  return values.map((s) => s.trim()).filter(Boolean).join(',')
}

/** 1-based page; anything unparseable or below 1 falls back to the first page. */
export function parsePage(v: unknown): number {
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/**
 * First of the query value then the stored preference that is actually one of
 * the offered page sizes, else the default. An off-list limit (hand-edited URL,
 * stale localStorage) is rejected rather than trusted.
 */
export function resolveLimit(queryValue: unknown, storedValue: unknown, sizes: readonly number[], fallback: number): number {
  for (const candidate of [queryValue, storedValue]) {
    const n = Number(Array.isArray(candidate) ? candidate[0] : candidate)
    if (Number.isInteger(n) && (sizes as readonly number[]).includes(n)) return n
  }
  return fallback
}

/** Whitelist sort against the query; unknown or missing values take the default. */
export function normalizeSort<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = asText(v)
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback
}

export function totalPageCount(total: number, limit: number): number {
  const per = Number.isFinite(limit) && limit > 0 ? limit : 1
  return Math.max(1, Math.ceil(Math.max(0, total) / per))
}

/** Last reachable page. A page past the end (out-of-range link, smaller limit). */
export function clampPage(page: number, total: number, limit: number): number {
  return Math.min(Math.max(1, page), totalPageCount(total, limit))
}

/** `YYYY-MM-DD` only; anything else is dropped so the API never sees junk. */
export function parseQueryDate(v: unknown): string {
  const s = asText(v).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const d = new Date(`${s}T00:00:00Z`)
  return isNaN(d.getTime()) ? '' : s
}

// ---------------------------------------------------------------- marketplace

export type MarketSort = 'recent' | 'price_asc' | 'price_desc'

export type MarketListState = {
  page: number
  limit: number
  sort: MarketSort
  q: string
  /** CSV of equipment types. */
  equipmentType: string
  /** CSV of grade effects. */
  gradeEffect: string
  /** Open favorite id; only meaningful under /marketplaces/favorites. */
  fav: number | null
}

const MARKET_SORTS: readonly MarketSort[] = ['recent', 'price_asc', 'price_desc']

export function marketStateFromQuery(query: LocationQueryLike, storedLimit?: unknown): MarketListState {
  const favRaw = asText(query.fav)
  const fav = Number(favRaw)
  return {
    page: parsePage(query.page),
    limit: resolveLimit(query.limit, storedLimit, MARKET_PAGE_SIZES, MARKET_DEFAULT_LIMIT),
    sort: normalizeSort(query.sort, MARKET_SORTS, 'recent'),
    q: asText(query.q),
    equipmentType: joinCsv(parseArrayParam(query.equipment_type)),
    gradeEffect: joinCsv(parseArrayParam(query.grade_effect)),
    fav: favRaw && Number.isInteger(fav) && fav > 0 ? fav : null,
  }
}

/** Defaults are omitted so page 1 with no filters stays a bare path. */
export function buildMarketQuery(s: MarketListState): Record<string, string> {
  const query: Record<string, string> = {}
  if (s.page !== 1) query.page = String(s.page)
  if (s.limit !== MARKET_DEFAULT_LIMIT) query.limit = String(s.limit)
  if (s.sort !== 'recent') query.sort = s.sort
  if (s.q) query.q = s.q
  if (s.equipmentType) query.equipment_type = s.equipmentType
  if (s.gradeEffect) query.grade_effect = s.gradeEffect
  if (s.fav != null) query.fav = String(s.fav)
  return query
}

// -------------------------------------------------------------------- history

export type HistorySort = 'recent' | 'created_at_asc' | 'price_asc' | 'price_desc'
export type ClaimedFilter = 'all' | 'claimed' | 'unclaimed'

export type HistoryListState = {
  page: number
  limit: number
  sort: HistorySort
  seller: string
  buyer: string
  /** The literal 'all' means unset; it is what the select shows as "All". */
  sellerName: string
  buyerName: string
  itemName: string
  tokenId: string
  txHash: string
  priceMin: string
  priceMax: string
  createdFrom: string
  createdTo: string
  claimed: ClaimedFilter
}

const HISTORY_SORTS: readonly HistorySort[] = ['recent', 'created_at_asc', 'price_asc', 'price_desc']

/**
 * `created_at_desc` was the original default sort and still appears in old
 * links; it means the same thing as `recent`, which is what this returns.
 */
export function normalizeHistorySort(v: unknown): HistorySort {
  return normalizeSort(v === 'created_at_desc' ? 'recent' : v, HISTORY_SORTS, 'recent')
}

function normalizeClaimed(v: unknown): ClaimedFilter {
  const s = asText(v)
  return s === 'claimed' || s === 'unclaimed' ? s : 'all'
}

export function historyStateFromQuery(query: LocationQueryLike, storedLimit?: unknown): HistoryListState {
  return {
    page: parsePage(query.page),
    limit: resolveLimit(query.limit, storedLimit, HISTORY_PAGE_SIZES, HISTORY_DEFAULT_LIMIT),
    sort: normalizeHistorySort(query.sort),
    seller: asText(query.seller),
    buyer: asText(query.buyer),
    sellerName: asText(query.sellerName) || 'all',
    buyerName: asText(query.buyerName) || 'all',
    // `q` is the older name for the same filter; old links still carry it.
    itemName: asText(query.itemName) || asText(query.q),
    tokenId: asText(query.tokenId),
    txHash: asText(query.txHash),
    priceMin: asText(query.priceMin),
    priceMax: asText(query.priceMax),
    createdFrom: parseQueryDate(query.createdFrom),
    createdTo: parseQueryDate(query.createdTo),
    claimed: normalizeClaimed(query.claimed),
  }
}

export function buildHistoryQuery(s: HistoryListState): Record<string, string> {
  const query: Record<string, string> = {}
  if (s.page !== 1) query.page = String(s.page)
  if (s.limit !== HISTORY_DEFAULT_LIMIT) query.limit = String(s.limit)
  if (s.sort !== 'recent') query.sort = s.sort
  if (s.seller) query.seller = s.seller
  if (s.buyer) query.buyer = s.buyer
  if (s.sellerName && s.sellerName !== 'all') query.sellerName = s.sellerName
  if (s.buyerName && s.buyerName !== 'all') query.buyerName = s.buyerName
  if (s.itemName) query.itemName = s.itemName
  if (s.tokenId) query.tokenId = s.tokenId
  if (s.txHash) query.txHash = s.txHash
  if (s.priceMin) query.priceMin = s.priceMin
  if (s.priceMax) query.priceMax = s.priceMax
  if (s.createdFrom) query.createdFrom = s.createdFrom
  if (s.createdTo) query.createdTo = s.createdTo
  if (s.claimed !== 'all') query.claimed = s.claimed
  return query
}
