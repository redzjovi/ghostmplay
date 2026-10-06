import { describe, it, expect } from 'vitest'
import { isSafeNextPath, safeNextPath, signState, verifyState, newStatePayload } from './oauth-state'

const SECRET = 'test-state-secret'

describe('isSafeNextPath', () => {
  it('accepts same-origin paths', () => {
    expect(isSafeNextPath('/marketplaces/list')).toBe(true)
    expect(isSafeNextPath('/admin/data')).toBe(true)
    expect(isSafeNextPath('/items/4949?tab=x')).toBe(true)
  })

  it('rejects anything that could leave the origin', () => {
    // Protocol-relative: the browser reads this as another host.
    expect(isSafeNextPath('//evil.com')).toBe(false)
    expect(isSafeNextPath('//evil.com/path')).toBe(false)
    expect(isSafeNextPath('https://evil.com')).toBe(false)
    expect(isSafeNextPath('http://evil.com')).toBe(false)
    // Some browsers normalise a backslash into a slash, which would turn this
    // into the protocol-relative case above.
    expect(isSafeNextPath('/\\evil.com')).toBe(false)
    expect(isSafeNextPath('/path\\to')).toBe(false)
    // A colon can introduce a scheme once a browser treats the rest as relative.
    expect(isSafeNextPath('/javascript:alert(1)')).toBe(false)
  })

  it('rejects non-strings, empties and absurd lengths', () => {
    expect(isSafeNextPath(undefined)).toBe(false)
    expect(isSafeNextPath(null)).toBe(false)
    expect(isSafeNextPath(42)).toBe(false)
    expect(isSafeNextPath(['/a'])).toBe(false)
    expect(isSafeNextPath('')).toBe(false)
    expect(isSafeNextPath('/' + 'a'.repeat(300))).toBe(false)
  })
})

describe('safeNextPath', () => {
  it('falls back rather than passing an unsafe destination through', () => {
    expect(safeNextPath('//evil.com')).toBe('/marketplaces/list')
    expect(safeNextPath('https://evil.com')).toBe('/marketplaces/list')
    expect(safeNextPath(undefined)).toBe('/marketplaces/list')
    expect(safeNextPath('/history/list', '/fallback')).toBe('/history/list')
    expect(safeNextPath('//evil.com', '/fallback')).toBe('/fallback')
  })
})

describe('signState / verifyState', () => {
  it('round-trips a payload', () => {
    const payload = newStatePayload('/marketplaces/list', 'verifier-abc', 1_000_000)
    const verified = verifyState(signState(payload, SECRET), SECRET, 1_000_000)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.payload).toEqual(payload)
  })

  it('mints a fresh nonce each time but passes the verifier through untouched', () => {
    // The nonce is the payload's job. The PKCE verifier is not: it is minted by the
    // provider, and re-deriving one here is what let the challenge and the verifier
    // drift apart and broke every token exchange.
    const a = newStatePayload('/x', 'verifier-one', 1_000_000)
    const b = newStatePayload('/x', 'verifier-two', 1_000_000)
    expect(a.n).not.toBe(b.n)
    expect(a.v).toBe('verifier-one')
    expect(b.v).toBe('verifier-two')
  })

  it('rejects a payload signed with a different secret', () => {
    const state = signState(newStatePayload('/x', 'verifier-abc', 1_000_000), 'other-secret')
    const verified = verifyState(state, SECRET, 1_000_000)
    expect(verified).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects a tampered destination', () => {
    // Re-signing is not possible without the secret, so this is the realistic attack:
    // take a genuine state and swap the payload for one pointing off-site.
    const genuine = signState(newStatePayload('/marketplaces/list', 'verifier-abc', 1_000_000), SECRET)
    const [body, mac] = genuine.split('.')
    const forged = Buffer.from(JSON.stringify(newStatePayload('//evil.com', 'verifier-abc', 1_000_000))).toString('base64url')
    const verified = verifyState(`${forged}.${mac}`, SECRET, 1_000_000)
    expect(verified).toEqual({ ok: false, reason: 'bad-signature' })
    expect(body).not.toBe(forged)
  })

  it('rejects an expired state', () => {
    const state = signState(newStatePayload('/x', 'verifier-abc', 1_000_000), SECRET)
    const verified = verifyState(state, SECRET, 1_000_000 + 11 * 60 * 1000)
    expect(verified).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects malformed input without throwing', () => {
    // A truncated MAC must be a rejected login, not a 500: timingSafeEqual throws
    // on a length mismatch.
    const state = signState(newStatePayload('/x', 'verifier-abc', 1_000_000), SECRET)
    const [body, mac] = state.split('.')
    for (const bad of [
      undefined,
      null,
      '',
      'no-dot',
      `${body}.`,
      `.${mac}`,
      `${body}.${mac.slice(0, 4)}`,
      `${body}.${mac}extra`,
      `${body}.not-base64url!!`,
      42,
    ]) {
      expect(verifyState(bad, SECRET, 1_000_000).ok).toBe(false)
    }
  })

  it('rejects a payload whose destination is unsafe even though it is signed', () => {
    // The signature means we wrote it, so this only fires if a bug upstream signed
    // something unsafe — but the browser is finally sent here, so it is re-checked.
    const state = signState({ ...newStatePayload('/x', 'verifier-abc', 1_000_000), x: '//evil.com' }, SECRET)
    const verified = verifyState(state, SECRET, 1_000_000)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.payload.x).toBe('/marketplaces/list')
  })

  it('rejects a signed payload with the wrong shape', () => {
    for (const bad of [{ e: 1 }, { n: 'a', v: 'b' }, { n: 1, v: 2, e: 9e15 }]) {
      const verified = verifyState(signState(bad as never, SECRET), SECRET, 1_000_000)
      expect(verified.ok).toBe(false)
    }
  })
})
