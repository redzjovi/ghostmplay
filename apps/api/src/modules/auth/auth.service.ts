import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { randomBytes } from 'crypto'
import type { Response } from 'express'
import { AccountEntity, SessionEntity } from './entities'
import type { LoginDto, RegisterDto } from './dto/auth.dto'
import { SessionService } from './session.service'

// OWASP-recommended argon2id parameters.
const ARGON_OPTS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export interface AccountPublic {
  id: number
  username: string
  role: 'user' | 'admin'
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    @InjectRepository(AccountEntity)
    private readonly accountRepo: Repository<AccountEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    private readonly sessions: SessionService
  ) {}

  static toPublic(a: AccountEntity): AccountPublic {
    return { id: a.id, username: a.username, role: a.role }
  }

  async register(dto: RegisterDto): Promise<AccountPublic> {
    const username = dto.username.trim().toLowerCase()
    if (await this.accountRepo.findOne({ where: { username } })) {
      throw new ConflictException(`Username "${username}" is taken`)
    }
    const account = this.accountRepo.create({
      username,
      passwordHash: await argonHash(dto.password, ARGON_OPTS),
      role: 'user' as const,
    })
    try {
      return AuthService.toPublic(await this.accountRepo.save(account))
    } catch (e) {
      // The unique index is the real guard against a concurrent duplicate.
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException(`Username "${username}" is taken`)
      }
      throw e
    }
  }

  async login(dto: LoginDto, res: Response, secure: boolean): Promise<AccountPublic> {
    const username = dto.username.trim().toLowerCase()
    const account = await this.accountRepo.findOne({ where: { username } })

    // Always run a verify so a missing account and a wrong password take the
    // same amount of time, and neither reveals which one it was.
    const hash = account?.passwordHash ?? (await getDummyHash())
    const ok = await argonVerify(hash, dto.password).catch(() => false)

    if (!account || !ok) throw new UnauthorizedException('Invalid username or password')

    await this.sessions.create(account.id, res, secure)
    return AuthService.toPublic(account)
  }

  /**
   * Seeds the first admin from the environment exactly once. If an admin already
   * exists this is a no-op, so the env vars can be removed after the first boot
   * without breaking anything.
   */
  async bootstrapAdmin(username: string | undefined, password: string | undefined): Promise<void> {
    if (!username || !password) return
    const existing = await this.accountRepo.findOne({ where: { role: 'admin' } })
    if (existing) {
      this.logger.log('Admin account already exists, skipping bootstrap')
      return
    }
    const name = username.trim().toLowerCase()
    if (await this.accountRepo.findOne({ where: { username: name } })) {
      this.logger.warn(`ADMIN_USERNAME "${name}" already exists as a non-admin; not promoting it`)
      return
    }
    await this.accountRepo.save(
      this.accountRepo.create({
        username: name,
        passwordHash: await argonHash(password, ARGON_OPTS),
        role: 'admin' as const,
      })
    )
    this.logger.log(`Bootstrapped admin account "${name}"`)
  }

  async countAdmins(): Promise<number> {
    return this.accountRepo.count({ where: { role: 'admin' } })
  }

  async purgeExpiredSessions(): Promise<void> {
    const n = await this.sessions.purgeExpired()
    if (n > 0) this.logger.log(`Purged ${n} expired sessions`)
  }
}

/**
 * A valid argon2 hash of a random throwaway string, computed once on first use.
 * Verifying against it makes a failed login cost the same as a successful one
 * regardless of whether the account exists. It is not a usable credential.
 */
let dummyHashPromise: Promise<string> | null = null
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argonHash(randomBytes(32).toString('base64url'), ARGON_OPTS)
  return dummyHashPromise
}
