/**
 * Query-string transforms shared by the list DTOs.
 *
 * Express parses `?a=1&a=2` into `['1','2']` but `?a=1,2` into `'1,2'`. Services
 * already understand both, but ValidationPipe needs a single declared type per
 * property — so arrays are folded into a comma-joined string here and the
 * services split them back out.
 */

/** `['A','B']` or `'A,B'` -> `'A,B'`. Empty/absent stays undefined. */
export const toCsv = ({ value }: { value: unknown }): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (Array.isArray(value)) {
    const joined = value
      .map((v) => String(v).trim())
      .filter(Boolean)
      .join(',')
    return joined || undefined
  }
  const trimmed = String(value).trim()
  return trimmed || undefined
}

/** Keeps empty strings as `undefined` so `?level=` is ignored rather than becoming 0. */
export const toOptionalInt = ({ value }: { value: unknown }): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** Keeps empty strings as `undefined` so `?priceMin=` is ignored rather than becoming 0. */
export const toOptionalNumber = ({ value }: { value: unknown }): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Trims a string, collapsing whitespace-only values to `undefined`. */
export const toOptionalString = ({ value }: { value: unknown }): string | undefined => {
  if (value === undefined || value === null) return undefined
  const trimmed = String(value).trim()
  return trimmed || undefined
}

/** Accepts `?flag` (bare) and `?flag=true/false`. Only explicit true is true. */
export const toOptionalBoolean = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const v = Array.isArray(value) ? value[0] : value
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  return undefined
}
