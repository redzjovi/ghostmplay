import { Injectable, UnauthorizedException, ForbiddenException, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import { Request } from 'express'
import { SessionService, type AuthenticatedAccount } from './session.service'

declare module 'express' {
  interface Request {
    account?: AuthenticatedAccount
  }
}

/**
 * Attaches `req.account` when a valid session cookie is present, but does not
 * reject. Use `@UseGuards(AuthGuard)` on top to make the route actually require
 * a login, or leave it off entirely for routes that are readable while logged out.
 */
@Injectable()
export class AuthGuard {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()
    req.account = (await this.sessions.resolve(this.sessions.extractToken(req))) ?? undefined
    return true
  }
}

@Injectable()
export class RequireAuthGuard {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()
    const account = await this.sessions.resolve(this.sessions.extractToken(req))
    if (!account) throw new UnauthorizedException('Authentication required')
    req.account = account
    return true
  }
}

@Injectable()
export class AdminGuard {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()
    const account = await this.sessions.resolve(this.sessions.extractToken(req))
    if (!account) throw new UnauthorizedException('Authentication required')
    if (account.role !== 'admin') throw new ForbiddenException('Admin access required')
    req.account = account
    return true
  }
}

/** Resolves the account; only valid together with RequireAuthGuard/AdminGuard. */
export const CurrentAccount = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const req = context.switchToHttp().getRequest<Request>()
  return req.account
})
