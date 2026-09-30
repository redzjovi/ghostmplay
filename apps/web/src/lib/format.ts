export function formatNumber(value: number | string | null | undefined, opts: Intl.NumberFormatOptions = {}): string {
  if (value === null || value === undefined || value === '') return '-'
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return String(value)
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, ...opts }).format(num)
}

export function formatPrice(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return String(value)
  // Prices are integer NUMI but keep 0 decimals handling; if decimals, show up to 2
  const hasDecimals = String(num).includes('.')
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: hasDecimals ? 2 : 0,
  }).format(num)
}

/** The zone every timestamp is rendered in. See formatDateTime. */
const DISPLAY_ZONE = 'UTC'

/**
 * Every visible timestamp renders as `YYYY-MM-DD HH:mm:ss UTC`.
 *
 * One helper, because there used to be three hand-rolled variants that disagreed:
 * a hand-built UTC string in the history table, an `en-CA` `Intl` call on item
 * detail (which emitted a comma, `2026-12-31, 00:00:00 UTC`), and
 * `toLocaleString()` in four other places, which is the worst of them — it renders
 * in the *visitor's* zone and flips to a 12-hour clock in en-US, so one row showed
 * a different time to each person looking at it.
 *
 * UTC is deliberate rather than a default. These are scrape and market timestamps,
 * and a value that shifts with the reader's browser is not comparable between
 * operators, nor reproducible in a screenshot. UTC also needs no zone-name lookup
 * and no DST handling, which is why this reads `getUTC*` fields directly instead of
 * going through `Intl` — a formatter would be locale-dependent again, which is the
 * thing being removed.
 *
 * Hours are 00-23, so midnight is `00:00:00`. ISO 8601 does allow a `24:00:00`
 * end-of-day, but that is not a clock time and no timestamp here means it.
 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-'
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) return String(value)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  return `${date} ${time} ${DISPLAY_ZONE}`
}
