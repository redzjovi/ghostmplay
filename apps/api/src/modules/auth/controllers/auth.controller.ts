import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common'
import { Request, Response } from 'express'
import { AuthService, type AccountPublic } from '../auth.service'
import { LoginDto, RegisterDto } from '../dto/auth.dto'
import { SessionService, SESSION_COOKIE, type AuthenticatedAccount } from '../session.service'
import { AuthGuard, CurrentAccount } from '../guards'
import { RateLimiterService } from '../../../common/rate-limiter.service'
import { env } from '../../../config/env'

/** Registration is open to anyone, so it is the endpoint that actually needs a limit. */
const REGISTER_LIMIT = 5
const REGISTER_WINDOW_SECONDS = 60 * 60

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly limiter: RateLimiterService
  ) {}

  @Post('register')
  @HttpCode(201)
  async register(@Req() req: Request, @Body() dto: RegisterDto): Promise<AccountPublic> {
    const ip = req.ip ?? 'unknown'
    const allowed = await this.limiter.consume(
      `rl:register:${ip}`,
      REGISTER_LIMIT,
      REGISTER_WINDOW_SECONDS
    )
    if (!allowed) {
      // Nest 10 has no TooManyRequestsException, so raise 429 directly.
      throw new HttpException(
        `Too many accounts created from this address. Try again in ${Math.round(REGISTER_WINDOW_SECONDS / 60)} minutes.`,
        HttpStatus.TOO_MANY_REQUESTS
      )
    }
    return this.auth.register(dto)
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<AccountPublic> {
    return this.auth.login(dto, res, env.isProd)
  }

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
  me(@CurrentAccount() account: AuthenticatedAccount | undefined): { account: AccountPublic | null } {
    if (!account) return { account: null }
    return { account: { id: account.id, username: account.username, role: account.role } }
  }
}
