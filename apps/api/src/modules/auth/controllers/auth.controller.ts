import { Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common'
import { Request, Response } from 'express'
import { AuthService, type AccountPublic } from '../auth.service'
import { SessionService, SESSION_COOKIE, type AuthenticatedAccount } from '../session.service'
import { AuthGuard, CurrentAccount } from '../guards'
import { RateLimiterService } from '../../../common/rate-limiter.service'
import { GoogleAuthService } from '../google/google-auth.service'
import { env } from '../../../config/env'

/**
 * Generous, because a real user gets here once. It exists to stop the callback
 * being used as a free oracle for guessing state values.
 */
const GOOGLE_LIMIT = 30
const GOOGLE_WINDOW_SECONDS = 10 * 60

/** Failure codes the SPA maps to copy. Never reflect Google's own error text back. */
const GOOGLE_ERROR_PARAM = 'oauth'

/**
 * Sign-in is Google-only: there is no username, no password and no register
 * endpoint. Admin is decided per sign-in from GOOGLE_ADMIN_EMAILS, which is why
 * nothing here consults a credential.
 */
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiterService,
    private readonly google: GoogleAuthService
  ) {}

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE]
    await this.sessions.destroy(token, res, env.isProd)
  }

  /** Cheap endpoint the SPA calls on boot to decide whether to show the login wall. */
  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentAccount() account: AuthenticatedAccount | undefined): Promise<{ account: AccountPublic | null }> {
    if (!account) return { account: null }
    // The address lives on the identity table, which is deliberately not joined onto
    // every authenticated request; only this endpoint and the callback need it.
    const email = await this.google.emailFor(account.id)
    return { account: AuthService.toPublic(account, email) }
  }

  /**
   * Which sign-in methods are on offer, so the login page can hide the Google
   * button when the deployment has not configured it rather than sending the user
   * to an error page.
   */
  @Get('providers')
  providers(): { googleEnabled: boolean } {
    return { googleEnabled: this.google.enabled }
  }

  /**
   * Entry point for Google sign-in: bounce the browser to Google.
   *
   * A redirect rather than an in-page button because the CSP at apps/web/index.html
   * is `script-src 'self'`, and top-level navigation is not something it restricts.
   */
  @Get('google')
  async googleStart(
    @Req() req: Request,
    @Query('next') next: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    if (!(await this.allowGoogle(req))) return this.failGoogle(res, 'oauth_throttled')
    const result = this.google.start(next)
    if ('error' in result) return this.failGoogle(res, result.error)
    res.redirect(302, result.url)
  }

  /**
   * Google's redirect target. Verifies the code, applies the admin allowlist, mints a
   * session, and sends the browser back into the SPA.
   *
   * The session cookie is set here rather than read from the request: this is a
   * cross-site navigation, so SameSite=Strict means any existing cookie is withheld,
   * which is fine because a fresh session is exactly what is wanted here.
   */
  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    if (!(await this.allowGoogle(req))) return this.failGoogle(res, 'oauth_throttled')
    const result = await this.google.complete({ code, state, oauthError })
    if (!result.ok) return this.failGoogle(res, result.error)

    await this.sessions.create(result.account.id, res, env.isProd)
    res.redirect(302, result.next)
  }

  private async allowGoogle(req: Request): Promise<boolean> {
    return this.limiter.consume(
      `rl:google:${req.ip ?? 'unknown'}`,
      GOOGLE_LIMIT,
      GOOGLE_WINDOW_SECONDS
    )
  }
  /**
   * Bounces back to the login page with a code rather than a message, so nothing
   * from Google or from an exception reaches the UI unescaped.
   */
  private failGoogle(res: Response, error: string): void {
    res.redirect(302, `/login?${GOOGLE_ERROR_PARAM}=${encodeURIComponent(error)}`)
  }
}
