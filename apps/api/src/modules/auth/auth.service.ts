import { Injectable, Logger } from '@nestjs/common'
import { SessionService } from './session.service'
import type { AccountRole } from './entities'

/**
 * What `/api/auth/me` returns about the caller.
 *
 * There is no username and no password any more: Google is the only way in, so the
 * address is the sole identifier and `role` is the only thing that matters to a guard.
 */
export interface AccountPublic {
  id: number
  email: string | null
  role: AccountRole
}

/**
 * Anything that carries an id and a role — an `AccountEntity`, the `AuthenticatedAccount`
 * the session resolves, or an already-public object. Kept structural so `me()` can pass
 * what the guard produced without downcasting to an entity shape it does not have.
 */
type HasRole = { id: number; role: AccountRole }

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(private readonly sessions: SessionService) {}

  static toPublic(account: HasRole, email: string | null = null): AccountPublic {
    return { id: account.id, email, role: account.role }
  }

  async purgeExpiredSessions(): Promise<void> {
    const n = await this.sessions.purgeExpired()
    if (n > 0) this.logger.log(`Purged ${n} expired sessions`)
  }
}
