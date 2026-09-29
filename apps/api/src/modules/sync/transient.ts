/**
 * Retry classification for scraper work.
 *
 * The upstream API is reached from inside a rootless container, where DNS goes
 * through Docker's embedded resolver and the network driver is documented as
 * weak for outbound traffic. Both produce transient failures that resolve on
 * their own within seconds — a single blip should not abort a sync job.
 *
 * Only genuinely transient conditions are retried. A 400 (malformed request) or
 * 404 (item gone) means the request itself is wrong, and retrying it just burns
 * the upstream's rate limit.
 */

/** Node/axios error codes that indicate a temporary network or DNS condition. */
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'EAI_NONAME',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'ERR_NETWORK',
])

const TRANSIENT_MESSAGE = /socket hang up|network timeout|getaddrinfo|read ECONNRESET|timeout of/i

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  const e = err as {
    code?: unknown
    message?: unknown
    status?: unknown
    response?: { status?: unknown }
    cause?: { code?: unknown }
  }

  // An HTTP response was received: retry on rate limits and server-side faults.
  const status = typeof e.response?.status === 'number' ? e.response.status : undefined
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || status >= 500
  }

  const code = e.code ?? e.cause?.code
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true

  const message = typeof e.message === 'string' ? e.message : ''
  return TRANSIENT_MESSAGE.test(message)
}

export function describeError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const e = err as { code?: unknown; message?: unknown; response?: { status?: unknown } }
  const status = e.response?.status
  const code = typeof e.code === 'string' ? e.code : undefined
  const message = typeof e.message === 'string' ? e.message : String(err)
  return [code, status ? `HTTP ${status}` : null, message].filter(Boolean).join(': ')
}
