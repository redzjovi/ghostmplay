import { describe, it, expect } from 'vitest'
import {
  MARKET_PAGE_SIZES,
  MARKET_DEFAULT_LIMIT,
  HISTORY_PAGE_SIZES,
  HISTORY_DEFAULT_LIMIT,
  asText,
  parseArrayParam,
  joinCsv,
  parsePage,
  resolveLimit,
  normalizeSort,
  normalizeHistorySort,
  totalPageCount,
  clampPage,
  parseQueryDate,
  marketStateFromQuery,
  buildMarketQuery,
  historyStateFromQuery,
  buildHistoryQuery,
  type MarketListState,
  type HistoryListState,
} from './listQuery'

describe('asText', () => {
  it('trims scalars and flattens arrays to the first entry', () => {
    expect(asText('  a  ')).toBe('a')
    expect(asText(['a', 'b'])).toBe('a')
    expect(asText(null)).toBe('')
    expect(asText(undefined)).toBe('')
    expect(asText(7)).toBe('7')
  })
})

describe('parseArrayParam', () => {
  it('accepts CSV, repeated params and mixtures', () => {
    expect(parseArrayParam('A,B')).toEqual(['A', 'B'])
    expect(parseArrayParam(['A', 'B'])).toEqual(['A', 'B'])
    expect(parseArrayParam(['A,B', 'C'])).toEqual(['A', 'B', 'C'])
    expect(parseArrayParam(' A , ,B ')).toEqual(['A', 'B'])
  })

  it('returns [] for missing or empty values', () => {
    expect(parseArrayParam(undefined)).toEqual([])
    expect(parseArrayParam('')).toEqual([])
    expect(parseArrayParam(',,')).toEqual([])
  })
})

describe('joinCsv', () => {
  it('drops blanks and round-trips through parseArrayParam', () => {
    expect(joinCsv(['A', '', ' B '])).toBe('A,B')
    expect(parseArrayParam(joinCsv(['A', 'B']))).toEqual(['A', 'B'])
    expect(joinCsv([])).toBe('')
  })
})

describe('parsePage', () => {
  it('keeps valid 1-based pages', () => {
    expect(parsePage('3')).toBe(3)
    expect(parsePage(7)).toBe(7)
  })

  it('falls back to the first page for junk or out-of-range values', () => {
    expect(parsePage(undefined)).toBe(1)
    expect(parsePage('')).toBe(1)
    expect(parsePage('0')).toBe(1)
    expect(parsePage('-4')).toBe(1)
    expect(parsePage('2.5')).toBe(1)
    expect(parsePage('abc')).toBe(1)
  })
})

describe('resolveLimit', () => {
  it('prefers the query over the stored preference', () => {
    expect(resolveLimit('24', '48', MARKET_PAGE_SIZES, 12)).toBe(24)
  })

  it('falls back to the stored preference when the query is absent', () => {
    expect(resolveLimit(undefined, '48', MARKET_PAGE_SIZES, 12)).toBe(48)
  })

  it('rejects off-list limits from either source', () => {
    expect(resolveLimit('7', '13', MARKET_PAGE_SIZES, 12)).toBe(12)
    expect(resolveLimit('7', undefined, MARKET_PAGE_SIZES, 12)).toBe(12)
  })
})

describe('normalizeSort', () => {
  it('accepts whitelisted values and rejects everything else', () => {
    expect(normalizeSort('price_asc', ['recent', 'price_asc'] as const, 'recent')).toBe('price_asc')
    expect(normalizeSort('bogus', ['recent', 'price_asc'] as const, 'recent')).toBe('recent')
    expect(normalizeSort(undefined, ['recent'] as const, 'recent')).toBe('recent')
  })
})

describe('normalizeHistorySort', () => {
  it('folds the legacy created_at_desc alias onto recent', () => {
    expect(normalizeHistorySort('created_at_desc')).toBe('recent')
    expect(normalizeHistorySort('created_at_asc')).toBe('created_at_asc')
    expect(normalizeHistorySort('nope')).toBe('recent')
  })
})

describe('totalPageCount / clampPage', () => {
  it('never drops below one page', () => {
    expect(totalPageCount(0, 12)).toBe(1)
    expect(totalPageCount(24, 12)).toBe(2)
    expect(totalPageCount(25, 12)).toBe(3)
    expect(totalPageCount(-5, 12)).toBe(1)
  })

  it('pulls an out-of-range page back to the last one', () => {
    expect(clampPage(999, 25, 12)).toBe(3)
    expect(clampPage(2, 25, 12)).toBe(2)
    expect(clampPage(0, 25, 12)).toBe(1)
  })
})

describe('parseQueryDate', () => {
  it('keeps only well-formed UTC days', () => {
    expect(parseQueryDate('2026-01-31')).toBe('2026-01-31')
    expect(parseQueryDate('2026-01-31T10:00:00Z')).toBe('2026-01-31')
    expect(parseQueryDate('31-01-2026')).toBe('')
    expect(parseQueryDate('not-a-date')).toBe('')
    expect(parseQueryDate('2026-13-45')).toBe('')
    expect(parseQueryDate(undefined)).toBe('')
  })
})

describe('marketplace codec', () => {
  const base: MarketListState = {
    page: 1, limit: MARKET_DEFAULT_LIMIT, sort: 'recent', q: '', equipmentType: '', gradeEffect: '', fav: null,
  }

  it('reads defaults from an empty query', () => {
    expect(marketStateFromQuery({})).toEqual(base)
  })

  it('reads page, limit, sort and csv filters', () => {
    expect(marketStateFromQuery({ page: '2', limit: '48', sort: 'price_desc', q: ' sword ', equipment_type: 'Armor,Boots', grade_effect: ['Fire', 'Rare'] }, '96')).toEqual({
      page: 2, limit: 48, sort: 'price_desc', q: 'sword', equipmentType: 'Armor,Boots', gradeEffect: 'Fire,Rare', fav: null,
    })
  })

  it('falls back to the stored limit when the query has none', () => {
    expect(marketStateFromQuery({}, '96').limit).toBe(96)
  })

  it('omits every default so page one is a bare path', () => {
    expect(buildMarketQuery(base)).toEqual({})
    expect(buildMarketQuery({ ...base, page: 2, limit: 24, sort: 'price_asc', q: 'a', equipmentType: 'X', gradeEffect: 'Y', fav: 3 })).toEqual({
      page: '2', limit: '24', sort: 'price_asc', q: 'a', equipment_type: 'X', grade_effect: 'Y', fav: '3',
    })
  })

  it('reads the open favorite id and rejects junk ones', () => {
    expect(marketStateFromQuery({ fav: '7' }).fav).toBe(7)
    expect(marketStateFromQuery({ fav: '0' }).fav).toBeNull()
    expect(marketStateFromQuery({ fav: 'abc' }).fav).toBeNull()
  })

  it('round-trips a non-default state', () => {
    const s: MarketListState = { page: 4, limit: 96, sort: 'price_asc', q: 'gold', equipmentType: 'Armor,Boots', gradeEffect: 'Fire', fav: 12 }
    expect(marketStateFromQuery(buildMarketQuery(s))).toEqual(s)
  })

  it('round-trips the default state', () => {
    expect(marketStateFromQuery(buildMarketQuery(base))).toEqual(base)
  })
})

describe('history codec', () => {
  const base: HistoryListState = {
    page: 1, limit: HISTORY_DEFAULT_LIMIT, sort: 'recent', seller: '', buyer: '', sellerName: 'all', buyerName: 'all',
    itemName: '', tokenId: '', txHash: '', priceMin: '', priceMax: '', createdFrom: '', createdTo: '', claimed: 'all',
  }

  it('reads defaults from an empty query', () => {
    expect(historyStateFromQuery({})).toEqual(base)
  })

  it('reads every filter', () => {
    expect(historyStateFromQuery({
      page: '3', limit: '60', sort: 'created_at_asc',
      seller: '0xa', buyer: '0xb', sellerName: 'herwan', buyerName: 'zed',
      itemName: 'Gold Box', tokenId: '4949', txHash: '0xdead',
      priceMin: '10', priceMax: '1000', createdFrom: '2026-01-01', createdTo: '2026-02-01', claimed: 'claimed',
    }, '30')).toEqual({
      page: 3, limit: 60, sort: 'created_at_asc', seller: '0xa', buyer: '0xb', sellerName: 'herwan', buyerName: 'zed',
      itemName: 'Gold Box', tokenId: '4949', txHash: '0xdead', priceMin: '10', priceMax: '1000',
      createdFrom: '2026-01-01', createdTo: '2026-02-01', claimed: 'claimed',
    })
  })

  it('accepts the legacy q alias for itemName', () => {
    expect(historyStateFromQuery({ q: 'Gold Box' }).itemName).toBe('Gold Box')
    expect(historyStateFromQuery({ q: 'a', itemName: 'b' }).itemName).toBe('b')
  })

  it('normalises an unknown claimed filter and a bad date', () => {
    expect(historyStateFromQuery({ claimed: 'maybe' }).claimed).toBe('all')
    expect(historyStateFromQuery({ createdFrom: 'oops' }).createdFrom).toBe('')
  })

  it('omits every default', () => {
    expect(buildHistoryQuery(base)).toEqual({})
  })

  it('omits the all sentinels for the name selects', () => {
    const q = buildHistoryQuery({ ...base, sellerName: 'all', buyerName: 'zed' })
    expect(q).toEqual({ buyerName: 'zed' })
  })

  it('round-trips a non-default state', () => {
    const s: HistoryListState = {
      page: 5, limit: 100, sort: 'price_desc', seller: '0xa', buyer: '0xb', sellerName: 'herwan', buyerName: 'zed',
      itemName: 'Gold Box', tokenId: '4949', txHash: '0xdead', priceMin: '10', priceMax: '1000',
      createdFrom: '2026-01-01', createdTo: '2026-02-01', claimed: 'unclaimed',
    }
    expect(historyStateFromQuery(buildHistoryQuery(s))).toEqual(s)
  })

  it('round-trips the default state', () => {
    expect(historyStateFromQuery(buildHistoryQuery(base))).toEqual(base)
  })

  it('folds the legacy sort alias back to recent on a round-trip', () => {
    expect(historyStateFromQuery({ sort: 'created_at_desc' })).toEqual(base)
  })
})
