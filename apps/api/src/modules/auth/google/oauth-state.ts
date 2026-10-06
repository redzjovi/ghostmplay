import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

/**
 * Signed, self-contained OAuth `state`.
 *
 * The callback arrives as a cross-site top-level navigation, so a SameSite=Strict
 * cookie cannot carry anything to it and the correlation has to travel in the URL.
 * Everything the callback needs therefore lives inside `state`: a nonce, the PKCE
 * verifier and the post-login destination, all authenticated by an HMAC so none of
 * it can be tampered with. Nothing is stored server-side, so there is no table to
 * sweep and no single-use bookkeeping.
 *
 * This deviates from the OAuth 2.0 spec's "state SHOULD NOT exceed 20 characters"
 * guidance. Google does not enforce a limit and passing a signed blob is common
 * practice; the alternative is a short random state plus a server-side row, which
 * trades a stateless flow for state that needs a cleanup job.
 */

/** Ten minutes is long enough for a login and short enough to blunt replay. */
export const STATE_TTL_MS = 10 * 60 * 1000

export interface OAuthStatePayload {
  /** Random nonce binding this authorization attempt to one callback. */
  n: string
  /** PKCE verifier; Google requires the matching challenge sent at authorize time. */
  v: string
  /** Where to land the browser once signed in. Validated as same-origin on the way in. */
  x: string
  /** Expiry as epoch ms. */
  e: number
}

/**
 * True only for a path that stays on this origin.
 *
 * Rejects `//evil.com` (protocol-relative), `https://evil.com` (absolute), and
 * anything containing `\` or `:`, which some browsers normalise back into a
 * leading `//`. Without this the callback is an open redirect.
 */
export function isSafeNextPath(next: unknown): next is string {
  if (typeof next !== 'string') return false
  if (next.length === 0 || next.length > 200) return false
  if (!next.startsWith('/')) return false
  if (next.startsWith('//')) return false
  if (next.includes('\\') || next.includes(':')) return false
  return true
}

/** Collapses an untrusted `next` to a same-origin path, or the given fallback. */
export function safeNextPath(next: unknown, fallback = '/marketplaces/list'): string {
  return isSafeNextPath(next) ? next : fallback
}

/**
 * Mints the payload for one authorization attempt.
 *
 * `verifier` is required rather than defaulted, and is the PKCE verifier whose
 * SHA-256 became the `code_challenge` sent to Google. It has to be threaded in from
 * the caller for exactly that reason: an earlier version generated its own random
 * value here, so the challenge and the verifier drifted apart and every exchange
 * came back `invalid_grant`.
 */
export function newStatePayload(x: string, verifier: string, now = Date.now()): OAuthStatePayload {
  return {
    n: randomBytes(16).toString('base64url'),
    v: verifier,
    x,
    e: now + STATE_TTL_MS,
  }
}

export function signState(payload: OAuthStatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export type StateFailure = 'malformed' | 'bad-signature' | 'expired'
export type StateResult = { ok: true; payload: OAuthStatePayload } | { ok: false; reason: StateFailure }

export function verifyState(state: unknown, secret: string, now = Date.now()): StateResult {
  if (typeof state !== 'string') return { ok: false, reason: 'malformed' }
  const dot = state.indexOf('.')
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: 'malformed' }
  const body = state.slice(0, dot)
  const mac = state.slice(dot + 1)

  const expected = createHmac('sha256', secret).update(body).digest()
  let given: Buffer
  try {
    given = Buffer.from(mac, 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  // Length is checked first: timingSafeEqual throws on a mismatch, which would turn
  // a truncated state into a 500 instead of a rejected login. The comparison is
  // constant-time so a wrong signature leaks nothing about how wrong it was.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' }
  }

  let payload: OAuthStatePayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof payload?.n !== 'string' || typeof payload?.v !== 'string') {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof payload.e !== 'number' || payload.e <= now) return { ok: false, reason: 'expired' }
  // Re-validated here as well as on the way in: the state was signed by us, but the
  // destination is what the browser is finally sent to, so it gets a second check.
  payload.x = safeNextPath(payload.x)
  return { ok: true, payload }
}
