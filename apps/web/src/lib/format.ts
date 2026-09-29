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
