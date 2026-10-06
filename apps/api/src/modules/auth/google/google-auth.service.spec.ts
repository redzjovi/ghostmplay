import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { GoogleAuthService, wantedRole } from './google-auth.service'
import type { GoogleProfile } from './google-identity.provider'
import { signState, newStatePayload, verifyState } from './oauth-state'

/**
 * A Google identity is keyed on Google's `sub` and on nothing else.
 *
 * The rule this file exists to protect: a verified Google account must never be
 * matched to an existing account by email. Email is not something an account owner
 * controls, so matching on it would let anyone who can register an address
 * resembling someone else's — an admin's included — sign straight into that
 * account. Every "returns the existing account" test therefore pins the lookup to
 * `provider` + `providerSubject`, and the email-matching tests pin the opposite.
 */
const SECRET = 'test-state-secret'

function harness(opts: {
  enabled?: boolean
  identity?: Record<string, unknown> | null
  profile?: Partial<GoogleProfile> | null
  verifyError?: string
  identityInsertError?: unknown
  /** GOOGLE_ADMIN_EMAILS, already lowercased as the env loader does it. */
  adminEmails?: string[]
} = {}) {
  const profile: GoogleProfile = {
    sub: 'google-sub-1',
    email: 'person@example.com',
    name: 'Person',
    picture: null,
    ...opts.profile,
  }

  const accountRepo = {
    findOne: vi.fn(async () => null),
    create: vi.fn((x: Record<string, unknown>) => ({ ...x })),
    save: vi.fn(async (a: Record<string, unknown>) => ({ ...a, id: 42, createdAt: new Date() })),
  }
  const identityRepo = {
    findOne: vi.fn(async () => (opts.identity ?? null)),
    create: vi.fn((x: Record<string, unknown>) => ({ ...x })),
    save: vi.fn(async (x: Record<string, unknown>) => {
      if (opts.identityInsertError) throw opts.identityInsertError
      return { ...x, id: 7, createdAt: new Date() }
    }),
    update: vi.fn(async () => ({ affected: 1 })),
  }

  const provider = {
    enabled: opts.enabled ?? true,
    stateSecret: SECRET,
    adminEmails: opts.adminEmails ?? [],
    // Faithful to GoogleIdentityProvider: the challenge is the hash of the verifier.
    // A made-up pairing would let a real drift between the two pass this suite.
    newPkce: () => {
      const verifier = 'verifier-123'
      return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
    },
    authorizeUrl: vi.fn(
      (state: string, challenge: string) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`
    ),
    authenticate: vi.fn(async () => {
      if (opts.verifyError) throw new Error(opts.verifyError)
      return profile
    }),
  }

  // GoogleAuthService uses the static AuthService.toPublic, so it is no longer a
  // constructor dependency and the harness has nothing to pass for it.
  const svc = new GoogleAuthService(provider as never, accountRepo as never, identityRepo as never)
  return { svc, provider, accountRepo, identityRepo, profile }
}

/** A stored identity as a relations:{account:true} query returns it. */
function identityRow(
  over: { id?: number; accountId: number; email?: string | null; role?: 'user' | 'admin' } = { accountId: 1 }
) {
  return {
    id: over.id ?? 7,
    accountId: over.accountId,
    provider: 'google',
    providerSubject: 'google-sub-1',
    email: over.email === undefined ? 'person@example.com' : over.email,
    pictureUrl: null,
    createdAt: new Date(),
    account: { id: over.accountId, role: over.role ?? 'user', createdAt: new Date() },
  }
}

function goodState(next = '/marketplaces/list', now = Date.now()): string {
  return signState(newStatePayload(next, 'verifier-abc', now), SECRET)
}

describe('GoogleAuthService.start', () => {
  it('redirects to Google with a signed state and a PKCE challenge', () => {
    const { svc, provider } = harness()
    const result = svc.start('/history/list')
    expect('url' in result && result.url).toContain('https://accounts.google.com/')
    expect(provider.authorizeUrl).toHaveBeenCalledWith(
      expect.any(String),
      createHash('sha256').update('verifier-123').digest('base64url')
    )
    const state = provider.authorizeUrl.mock.calls[0][0] as string
    expect(state.split('.')).toHaveLength(2)
  })

  it('signs the destination into the state so the callback can honour it', () => {
    const { svc, provider } = harness()
    svc.start('/marketplaces/favorites')
    const state = provider.authorizeUrl.mock.calls[0][0] as string
    const body = Buffer.from(state.split('.')[0], 'base64url').toString('utf8')
    expect(JSON.parse(body).x).toBe('/marketplaces/favorites')
  })

  it('refuses to sign an off-site destination', () => {
    const { svc, provider } = harness()
    svc.start('//evil.com')
    const state = provider.authorizeUrl.mock.calls[0][0] as string
    const body = Buffer.from(state.split('.')[0], 'base64url').toString('utf8')
    expect(JSON.parse(body).x).toBe('/marketplaces/list')
  })

  it('signs the verifier whose hash became the code challenge', () => {
    // The invariant that broke sign-in: the `code_challenge` sent at authorize time
    // is the SHA-256 of the `code_verifier` that has to come back at the callback.
    // When these are minted independently every exchange is rejected by Google with
    // `invalid_grant`, so they are tied together across both halves of the flow here.
    const { svc, provider } = harness()
    svc.start('/marketplaces/list')
    const [state, challenge] = provider.authorizeUrl.mock.calls[0] as [string, string]
    const verified = verifyState(state, SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    const hashed = createHash('sha256').update(verified.payload.v).digest('base64url')
    expect(hashed).toBe(challenge)
  })

  it('reports the feature as off rather than redirecting when unconfigured', () => {
    const { svc, provider } = harness({ enabled: false })
    expect(svc.start('/x')).toEqual({ error: 'oauth_disabled' })
    expect(provider.authorizeUrl).not.toHaveBeenCalled()
  })
})

describe('GoogleAuthService.complete — provisioning', () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  it('creates an account carrying nothing but the role for a new identity', async () => {
    const res = await h.svc.complete({ code: 'code-1', state: goodState() })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Accounts hold id, role and created_at — there is no credential left to carry.
    expect(h.accountRepo.create).toHaveBeenCalledWith({ role: 'user' })
    expect(h.identityRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 42,
        provider: 'google',
        providerSubject: 'google-sub-1',
        email: 'person@example.com',
      })
    )
    expect(res.next).toBe('/marketplaces/list')
  })

  it('looks an identity up by provider and sub, never by email', async () => {
    await h.svc.complete({ code: 'code-1', state: goodState() })
    expect(h.identityRepo.findOne).toHaveBeenCalledWith({
      where: { provider: 'google', providerSubject: 'google-sub-1' },
      // Joined: without it every sign-in costs a second query, and a row whose
      // account is gone is indistinguishable from a first-time visitor.
      relations: { account: true },
    })
  })

  it('reuses the account on a second sign-in instead of creating another', async () => {
    h = harness({ identity: identityRow({ accountId: 99, email: 'person@example.com' }) })
    const res = await h.svc.complete({ code: 'code-2', state: goodState() })
    expect(res.ok).toBe(true)
    expect(h.accountRepo.save).not.toHaveBeenCalled()
    expect(h.identityRepo.save).not.toHaveBeenCalled()
    expect(res.ok && res.account.id).toBe(99)
  })

  it('keeps the stored address current when Google reports a new one', async () => {
    h = harness({ identity: identityRow({ accountId: 99, email: 'old@example.com' }) })
    await h.svc.complete({ code: 'c', state: goodState() })
    expect(h.identityRepo.update).toHaveBeenCalledWith({ id: 7 }, { email: 'person@example.com' })
  })

  it('does not link a Google identity to an existing account that shares the email', async () => {
    // The whole point: an admin registered as admin@example.com must not be adopted
    // by anyone who controls a Google account with that address.
    h = harness({ identity: null })
    await h.svc.complete({ code: 'c', state: goodState() })
    expect(h.accountRepo.findOne).not.toHaveBeenCalledWith({ where: { username: 'person@example.com' } })
    expect(h.accountRepo.findOne).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ email: expect.anything() }) })
    )
    expect(h.accountRepo.save).toHaveBeenCalledTimes(1)
    expect(h.identityRepo.save).toHaveBeenCalledTimes(1)
  })

  it('re-resolves the winner when two first sign-ins race on the unique index', async () => {
    h = harness({ identityInsertError: Object.assign(new Error('duplicate key'), { code: '23505' }) })
    // The loser's identity lookup misses first, then the insert fails, then it
    // re-reads and finds the row the winner created.
    h.identityRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identityRow({ id: 8, accountId: 77 }))
    const res = await h.svc.complete({ code: 'c', state: goodState() })
    expect(res.ok).toBe(true)
    expect(res.ok && res.account.id).toBe(77)
  })

  it('propagates a non-unique insert failure instead of pretending to sign in', async () => {
    h = harness({ identityInsertError: Object.assign(new Error('boom'), { code: 'XX000' }) })
    const res = await h.svc.complete({ code: 'c', state: goodState() })
    expect(res).toEqual({ ok: false, error: 'oauth_failed' })
  })

  it('recreates the account when an identity outlives the row it pointed at', async () => {
    // No joined account: the FK cascades, so this is only reachable if rows were
    // removed by hand. It must not 500 on every later sign-in.
    const dangling = { ...identityRow({ accountId: 404 }), account: undefined }
    h = harness({ identity: dangling })
    const res = await h.svc.complete({ code: 'c', state: goodState() })
    expect(res.ok).toBe(true)
    expect(h.accountRepo.save).toHaveBeenCalledTimes(1)
    expect(h.identityRepo.save).toHaveBeenCalledTimes(1)
  })

  it('exposes the stored address for /auth/me', async () => {
    h = harness({ identity: identityRow({ accountId: 99, email: 'a@b.c' }) })
    expect(await h.svc.emailFor(99)).toBe('a@b.c')
    h.identityRepo.findOne.mockResolvedValueOnce(null)
    expect(await h.svc.emailFor(1)).toBeNull()
  })
})

describe('GoogleAuthService.complete — refusals', () => {
  it('treats a user clicking Cancel as a denial, not a failure', async () => {
    const { svc, provider } = harness()
    const res = await svc.complete({ oauthError: 'access_denied', state: goodState() })
    expect(res).toEqual({ ok: false, error: 'oauth_denied' })
    expect(provider.authenticate).not.toHaveBeenCalled()
  })

  it('reports the feature as off without touching Google', async () => {
    const { svc, provider } = harness({ enabled: false })
    expect(await svc.complete({ code: 'c', state: goodState() })).toEqual({ ok: false, error: 'oauth_disabled' })
    expect(provider.authenticate).not.toHaveBeenCalled()
  })

  it('rejects a bad, tampered or expired state before exchanging the code', async () => {
    for (const state of ['garbage', '', goodState('/x', Date.now() - 11 * 60 * 1000)]) {
      const { svc, provider } = harness()
      const res = await svc.complete({ code: 'c', state })
      expect(res).toEqual({ ok: false, error: 'oauth_state' })
      expect(provider.authenticate).not.toHaveBeenCalled()
    }
  })

  it('requires a code', async () => {
    const { svc } = harness()
    expect(await svc.complete({ state: goodState() })).toEqual({ ok: false, error: 'oauth_failed' })
    expect(await svc.complete({ code: '', state: goodState() })).toEqual({ ok: false, error: 'oauth_failed' })
  })

  it('distinguishes an unverified address and creates nothing', async () => {
    const { svc, accountRepo } = harness({ verifyError: 'Google email is not verified' })
    const res = await svc.complete({ code: 'c', state: goodState() })
    expect(res).toEqual({ ok: false, error: 'oauth_unverified' })
    expect(accountRepo.save).not.toHaveBeenCalled()
  })

  it('refuses a token the provider rejects, for any reason', async () => {
    for (const message of [
      'Wrong recipient, payload, or signature.',
      'Token used too late',
      'Invalid token',
      'invalid_grant',
    ]) {
      const { svc, accountRepo } = harness({ verifyError: message })
      const res = await svc.complete({ code: 'c', state: goodState() })
      expect(res).toEqual({ ok: false, error: 'oauth_failed' })
      expect(accountRepo.save).not.toHaveBeenCalled()
    }
  })

  it('never honours an off-site destination that survived the state check', async () => {
    // The state is re-validated on the way out, so this lands on the fallback.
    const { svc } = harness()
    const res = await svc.complete({ code: 'c', state: goodState('//evil.com') })
    expect(res.ok).toBe(true)
    expect(res.ok && res.next).toBe('/marketplaces/list')
  })
})

/**
 * Admin is granted by allowlist on every sign-in and by nothing else: there is no
 * password account left, so this is the entire admin mechanism. Two properties worth
 * pinning — it must both promote and demote, and a listed address is only reachable
 * through Google's email_verified token.
 */
describe('GoogleAuthService — admin allowlist', () => {
  it('creates the account as admin when the token address is allowlisted', async () => {
    const { svc, accountRepo } = harness({ adminEmails: ['boss@example.com'], profile: { email: 'boss@example.com' } })
    await svc.complete({ code: 'c', state: goodState() })
    expect(accountRepo.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }))
  })

  it('leaves everyone else a plain user', async () => {
    const { svc, accountRepo } = harness({ adminEmails: ['boss@example.com'], profile: { email: 'nobody@example.com' } })
    await svc.complete({ code: 'c', state: goodState() })
    expect(accountRepo.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }))
  })

  it('matches case-insensitively and on the token address, not the stored one', async () => {
    const { svc, accountRepo } = harness({
      adminEmails: ['boss@example.com'],
      profile: { email: 'BoSS@Example.COM' },
    })
    await svc.complete({ code: 'c', state: goodState() })
    expect(accountRepo.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }))
  })

  it('demotes an admin who has left the allowlist', async () => {
    const { svc, accountRepo } = harness({
      identity: identityRow({ accountId: 9, email: 'former@example.com', role: 'admin' }),
      adminEmails: [],
      profile: { email: 'former@example.com' },
    })
    await svc.complete({ code: 'c', state: goodState() })
    expect(accountRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 9, role: 'user' }))
  })

  it('never promotes an account when the token carries no address', async () => {
    const { svc, accountRepo } = harness({ adminEmails: ['boss@example.com'], profile: { email: null } })
    await svc.complete({ code: 'c', state: goodState() })
    expect(accountRepo.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }))
  })

  it('applies the allowlist to the row the race winner created too', async () => {
    const h = harness({
      adminEmails: ['boss@example.com'],
      profile: { email: 'boss@example.com' },
      identityInsertError: Object.assign(new Error('dup'), { code: '23505' }),
    })
    h.identityRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identityRow({ id: 8, accountId: 77, role: 'user' }))
    await h.svc.complete({ code: 'c', state: goodState() })
    expect(h.accountRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 77, role: 'admin' }))
  })

  it('writes nothing when the role is already correct', async () => {
    const { svc, accountRepo } = harness({
      identity: identityRow({ accountId: 9, email: 'person@example.com', role: 'user' }),
      profile: { email: 'person@example.com' },
    })
    await svc.complete({ code: 'c', state: goodState() })
    expect(accountRepo.save).not.toHaveBeenCalled()
  })
})

describe('wantedRole', () => {
  it('is admin only for a listed address', () => {
    expect(wantedRole('boss@example.com', ['boss@example.com'])).toBe('admin')
    expect(wantedRole('other@example.com', ['boss@example.com'])).toBe('user')
    expect(wantedRole('boss@example.com', [])).toBe('user')
  })

  it('ignores case and surrounding whitespace on the incoming address', () => {
    expect(wantedRole('  BoSS@Example.COM ', ['boss@example.com'])).toBe('admin')
  })

  it('treats an absent address as a user, never as an admin', () => {
    expect(wantedRole(null, ['boss@example.com'])).toBe('user')
    expect(wantedRole(undefined, ['boss@example.com'])).toBe('user')
    expect(wantedRole('', ['boss@example.com'])).toBe('user')
    expect(wantedRole('   ', ['boss@example.com'])).toBe('user')
  })
})
