import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, LessThan } from 'typeorm'
import { createHash, randomBytes } from 'crypto'
import type { Request, Response } from 'express'
import { SessionEntity } from './entities'
import { AccountEntity, type AccountRole } from './entities'

export const SESSION_COOKIE = 'gm_session'
/** 30 days. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface AuthenticatedAccount {
  id: number
  role: AccountRole
}

/** Sessions are stored as a SHA-256 hash so a DB leak does not yield usable cookies. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function getCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    path: '/',
    maxAge: SESSION_TTL_MS,
  }
}

@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(AccountEntity)
    private readonly accountRepo: Repository<AccountEntity>
  ) {}

  async create(accountId: number, res: Response, secure: boolean): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    await this.sessionRepo.insert({
      accountId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    res.cookie(SESSION_COOKIE, token, getCookieOptions(secure))
    return token
  }

  async resolve(token: string | undefined): Promise<AuthenticatedAccount | null> {
    if (!token) return null

    const session = await this.sessionRepo.findOne({
      where: { tokenHash: hashToken(token) },
      relations: { account: true },
    })
    if (!session?.account) return null

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.sessionRepo.delete({ id: session.id })
      return null
    }

    const { id, role } = session.account
    return { id, role }
  }

  async destroy(token: string | undefined, res: Response, secure: boolean): Promise<void> {
    if (token) {
      await this.sessionRepo.delete({ tokenHash: hashToken(token) })
    }
    res.clearCookie(SESSION_COOKIE, getCookieOptions(secure))
  }

  async purgeExpired(): Promise<number> {
    const result = await this.sessionRepo.delete({ expiresAt: LessThan(new Date()) })
    return result.affected ?? 0
  }

  /** Invalidates every session for an account. */
  async purgeForAccount(accountId: number): Promise<void> {
    await this.sessionRepo.delete({ accountId })
  }

  extractToken(req: Request): string | undefined {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies
    return cookies?.[SESSION_COOKIE]
  }
}
