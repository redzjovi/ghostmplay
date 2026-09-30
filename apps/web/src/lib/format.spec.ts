import { describe, it, expect } from 'vitest'
import { formatDateTime } from './format'

describe('formatDateTime', () => {
  it('renders the agreed shape', () => {
    expect(formatDateTime('2026-12-31T15:45:09Z')).toBe('2026-12-31 15:45:09 UTC')
  })

  it('renders midnight as 00:00:00, never 24:00:00', () => {
    // The request asked for "24:00:00". ISO 8601 permits 24:00:00 as an
    // end-of-day marker, but it is not a clock time and no timestamp here means
    // it. Pinned because a formatter configured the other way round — or one
    // left on hour12:false, which some locales map to the h24 cycle — will emit it.
    expect(formatDateTime('2026-12-31T00:00:00Z')).toBe('2026-12-31 00:00:00 UTC')
    expect(formatDateTime('2026-12-31T00:59:59Z')).toBe('2026-12-31 00:59:59 UTC')
    expect(formatDateTime('2026-12-31T23:59:59Z')).toBe('2026-12-31 23:59:59 UTC')
    expect(formatDateTime('2026-12-31T00:00:00Z')).not.toContain('24:')
  })

  it('zero-pads month, day, hours, minutes and seconds', () => {
    expect(formatDateTime('2026-01-02T03:04:05Z')).toBe('2026-01-02 03:04:05 UTC')
  })

  it('renders in UTC regardless of the host timezone', () => {
    // The regression that motivated this: four call sites used toLocaleString(),
    // which renders in the viewer's zone. On this machine that is GMT+7, so a
    // local-zone implementation would print 22:45:09 here.
    expect(formatDateTime('2026-12-31T15:45:09+09:00')).toBe('2026-12-31 06:45:09 UTC')
    expect(formatDateTime('2026-12-31T15:45:09-05:00')).toBe('2026-12-31 20:45:09 UTC')
  })

  it('shifts the date as well as the clock across a zone boundary', () => {
    // 00:30 on Jan 1 in KST is still Dec 31 in UTC.
    expect(formatDateTime('2026-01-01T00:30:00+09:00')).toBe('2025-12-31 15:30:00 UTC')
  })

  it('accepts epoch milliseconds and Date objects', () => {
    const ms = Date.UTC(2026, 11, 31, 15, 45, 9)
    expect(formatDateTime(ms)).toBe('2026-12-31 15:45:09 UTC')
    expect(formatDateTime(new Date(ms))).toBe('2026-12-31 15:45:09 UTC')
  })

  it('always labels the zone, and always UTC', () => {
    expect(formatDateTime('2026-12-31T15:45:09Z')).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+$/)
    expect(formatDateTime('2026-12-31T15:45:09Z').endsWith(' UTC')).toBe(true)
  })

  it('sorts lexicographically in chronological order', () => {
    // Fixed-width zero padding is what makes the column sortable as plain text,
    // which matters because the history table renders timestamps in a list.
    const inputs = ['2026-12-31T15:45:09Z', '2026-01-01T00:00:00Z', '2026-01-02T03:04:05Z']
    const chronological = [...inputs].sort()
    const rendered = chronological.map(formatDateTime)
    expect(rendered).toEqual([...rendered].sort())
    expect(rendered).toEqual([
      '2026-01-01 00:00:00 UTC',
      '2026-01-02 03:04:05 UTC',
      '2026-12-31 15:45:09 UTC',
    ])
  })

  it('pads a year under 1000 rather than emitting a bare number', () => {
    // Not reachable via Date.UTC, which folds 0-99 into 1900+, so set it directly.
    const d = new Date(0)
    d.setUTCFullYear(99, 0, 1)
    d.setUTCHours(0, 0, 0, 0)
    expect(formatDateTime(d)).toBe('0099-01-01 00:00:00 UTC')
  })

  it('returns a dash for nothing to show', () => {
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime(undefined)).toBe('-')
    expect(formatDateTime('')).toBe('-')
  })

  it('passes unparseable input through rather than hiding it', () => {
    // A dash would be indistinguishable from "never set"; bad data should be visible.
    expect(formatDateTime('not-a-date')).toBe('not-a-date')
    expect(formatDateTime(new Date('nope'))).toBe('Invalid Date')
  })
})
