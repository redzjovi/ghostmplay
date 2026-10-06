import { describe, it, expect, vi } from 'vitest'
import { ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { AdminGuard, AuthGuard } from './guards'
import { AuthController } from './controllers/auth.controller'

/**
 * `POST /api/auth/register` is now behind AdminGuard, so the guard is the thing
 * standing between the public internet and the ability to mint a password account.
 * These tests pin the guard's decisions directly, since the controller's decorators
 * are what wire it in and a handler test would never exercise it.
 */
function context() {
  const req: { cookies: Record<string, string>; ip: string; account?: unknown } = {
    cookies: {},
    ip: '10.0.0.1',
  }
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) }
  return { req, ctx: ctx as never, asRequest: req as never }
}

function sessionService(resolve: (token?: string) => unknown) {
  return { resolve, extractToken: (req: { cookies?: Record<string, string> }) => req.cookies?.gm_session } as never
}

describe('AdminGuard', () => {
  it('rejects a request with no session', async () => {
    const guard = new AdminGuard(sessionService(() => null))
    const { ctx } = context()
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException)
  })

  it('rejects a signed-in non-admin', async () => {
    const guard = new AdminGuard(sessionService(() => ({ id: 7, role: 'user' })))
    const { ctx } = context()
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('admits an admin and attaches the account', async () => {
    const account = { id: 1, role: 'admin' }
    const guard = new AdminGuard(sessionService(() => account))
    const { req, ctx } = context()
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.account).toEqual(account)
  })
})

describe('AuthGuard', () => {
  it('never rejects — it only attaches, so public routes stay public', async () => {
    const guard = new AuthGuard(sessionService(() => null))
    const { req, ctx } = context()
    await expect(guard.canActivate(ctx)).resolves.toBe(true)
    expect(req.account).toBeUndefined()
  })
})

/**
 * The Google callback is a browser-facing redirect, so what matters is that it
 * always ends in a redirect, that a session cookie is only minted on success, and
 * that a refusal carries a fixed code rather than any text from Google.
 */
function controller(opts: { google?: Record<string, unknown>; limiter?: Record<string, unknown> } = {}) {
  // Rest args so the assertion below can read the cookie-policy argument the
  // controller passes; an arity-0 mock types its calls as an empty tuple.
  const sessions = {
    create: vi.fn(async (..._args: unknown[]) => 'token'),
    destroy: vi.fn(async (..._args: unknown[]) => undefined),
  }
  const limiter = { consume: vi.fn(async () => true), ...opts.limiter }
  const google = {
    enabled: true,
    start: vi.fn(() => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc' })),
    complete: vi.fn(async () => ({ ok: true, account: { id: 7, username: null, email: 'a@b.c', role: 'user' }, next: '/history/list' })),
    emailFor: vi.fn(async () => 'a@b.c'),
    ...opts.google,
  }
  const ctrl = new AuthController(sessions as never, limiter as never, google as never)
  const res = { redirect: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn() }
  return { ctrl, res, sessions, limiter, google }
}

describe('AuthController google callback', () => {
  it('mints a session and lands on the destination from the state', async () => {
    const { ctrl, res, sessions } = controller()
    await ctrl.googleCallback(context().asRequest, 'code', 'state', undefined, res as never)
    expect(sessions.create).toHaveBeenCalledWith(7, res, expect.any(Boolean))
    expect(res.redirect).toHaveBeenCalledWith(302, '/history/list')
  })

  it('passes the production cookie policy through', async () => {
    const { ctrl, res, sessions } = controller()
    await ctrl.googleCallback(context().asRequest, 'code', 'state', undefined, res as never)
    expect(sessions.create.mock.calls[0][2] as boolean).toBe(process.env.NODE_ENV === 'production')
  })

  it('redirects a refusal to the login page with a code and mints no session', async () => {
    for (const error of ['oauth_denied', 'oauth_state', 'oauth_unverified', 'oauth_failed', 'oauth_disabled']) {
      const { ctrl, res, sessions } = controller({ google: { complete: vi.fn(async () => ({ ok: false, error })) } })
      await ctrl.googleCallback(context().asRequest, 'code', 'state', undefined, res as never)
      expect(res.redirect).toHaveBeenCalledWith(302, `/login?oauth=${error}`)
      expect(sessions.create).not.toHaveBeenCalled()
    }
  })

  it('never reflects text from Google into the redirect', async () => {
    const { ctrl, res } = controller({
      google: { complete: vi.fn(async () => ({ ok: false, error: 'oauth_failed' })) },
    })
    await ctrl.googleCallback(context().asRequest, 'code', 'state', 'access_denied', res as never)
    expect(res.redirect.mock.calls[0][1]).not.toContain('access_denied')
  })
})

describe('AuthController google start', () => {
  it('redirects to Google and passes the destination through for signing', async () => {
    const { ctrl, res, google } = controller()
    await ctrl.googleStart(context().asRequest, '/marketplaces/favorites', res as never)
    expect(google.start).toHaveBeenCalledWith('/marketplaces/favorites')
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://accounts.google.com/o/oauth2/v2/auth?state=abc')
  })

  it('reports the feature as off rather than redirecting to a broken URL', async () => {
    const { ctrl, res } = controller({ google: { start: vi.fn(() => ({ error: 'oauth_disabled' })) } })
    await ctrl.googleStart(context().asRequest, '/x', res as never)
    expect(res.redirect).toHaveBeenCalledWith(302, '/login?oauth=oauth_disabled')
  })

  it('rate limits the callback, and says so rather than claiming Google is off', async () => {
    // Telling a throttled visitor that Google is unavailable would be a lie that
    // sends them to the wrong remedy.
    const { ctrl, res, google } = controller({ limiter: { consume: vi.fn(async () => false) } })
    await ctrl.googleCallback(context().asRequest, 'code', 'state', undefined, res as never)
    expect(google.complete).not.toHaveBeenCalled()
    expect(res.redirect).toHaveBeenCalledWith(302, '/login?oauth=oauth_throttled')
  })

  it('rate limits the start route the same way', async () => {
    const { ctrl, res, google } = controller({ limiter: { consume: vi.fn(async () => false) } })
    await ctrl.googleStart(context().asRequest, '/x', res as never)
    expect(google.start).not.toHaveBeenCalled()
    expect(res.redirect).toHaveBeenCalledWith(302, '/login?oauth=oauth_throttled')
  })
})

describe('AuthController providers', () => {
  it('tells the login page whether to offer Google', () => {
    expect(controller().ctrl.providers()).toEqual({ googleEnabled: true })
    expect(controller({ google: { enabled: false } }).ctrl.providers()).toEqual({ googleEnabled: false })
  })
})

describe('AuthController me', () => {
  it('reports no account when signed out', async () => {
    const { ctrl } = controller()
    expect(await ctrl.me(undefined)).toEqual({ account: null })
  })

  it('includes the verified address for a Google account', async () => {
    const { ctrl } = controller()
    const res = await ctrl.me({ id: 7, role: 'user' })
    expect(res.account).toEqual({ id: 7, email: 'a@b.c', role: 'user' })
  })
})

