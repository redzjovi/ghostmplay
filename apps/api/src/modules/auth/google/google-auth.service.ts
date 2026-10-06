import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { AuthService, type AccountPublic } from '../auth.service'
import { AccountEntity, AccountIdentityEntity, type AccountRole } from '../entities'
import { GoogleIdentityProvider, type GoogleProfile } from './google-identity.provider'
import { newStatePayload, safeNextPath, signState, verifyState } from './oauth-state'

export const GOOGLE_PROVIDER = 'google' as const

/**
 * The role the allowlist grants: `admin` only for a listed address.
 *
 * Deliberately pure so promotion is unit-testable without a provider, a repository or
 * process.env. Comparison is case-insensitive because addresses are; `adminEmails` is
 * already lowercased by the env loader. An absent address never promotes — that is the
 * conservative direction, and it is what makes an unverified field harmless.
 */
export function wantedRole(email: string | null | undefined, adminEmails: readonly string[]): AccountRole {
  if (!email) return 'user'
  return adminEmails.includes(email.trim().toLowerCase()) ? 'admin' : 'user'
}

/** Why a callback was refused. Maps to a stable code the SPA turns into copy. */
export type GoogleFailure =
  | 'oauth_disabled'
  | 'oauth_denied'
  | 'oauth_state'
  | 'oauth_unverified'
  | 'oauth_failed'

export type GoogleStartResult = { url: string } | { error: GoogleFailure }

export type GoogleCompleteResult =
  | { ok: true; account: AccountPublic; next: string }
  | { ok: false; error: GoogleFailure }

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name)

  constructor(
    private readonly provider: GoogleIdentityProvider,
    @InjectRepository(AccountEntity)
    private readonly accountRepo: Repository<AccountEntity>,
    @InjectRepository(AccountIdentityEntity)
    private readonly identityRepo: Repository<AccountIdentityEntity>
  ) {}

  get enabled(): boolean {
    return this.provider.enabled
  }

  /** Builds the URL the browser is sent to. `next` is validated before it is signed. */
  start(next: unknown): GoogleStartResult {
    if (!this.provider.enabled) return { error: 'oauth_disabled' }
    try {
      const { verifier, challenge } = this.provider.newPkce()
      // The signed state must carry the same verifier that produced the challenge,
      // or Google rejects the exchange.
      const state = signState(newStatePayload(safeNextPath(next), verifier), this.provider.stateSecret)
      return { url: this.provider.authorizeUrl(state, challenge) }
    } catch (err) {
      this.logger.error(`Could not build the Google authorize URL: ${(err as Error).message}`)
      return { error: 'oauth_failed' }
    }
  }

  async complete(params: {
    code?: unknown
    state?: unknown
    oauthError?: unknown
  }): Promise<GoogleCompleteResult> {
    if (!this.provider.enabled) return { ok: false, error: 'oauth_disabled' }
    // Google reports a user clicking "Cancel" as an error param, not a bad code.
    if (typeof params.oauthError === 'string' && params.oauthError.length > 0) {
      return { ok: false, error: 'oauth_denied' }
    }

    const verified = verifyState(params.state, this.provider.stateSecret)
    if (!verified.ok) {
      // A bad state is either a stale tab or someone probing the endpoint. Neither
      // is worth a log line per attempt, so only the shape is reported.
      this.logger.debug?.(`Google state rejected: ${verified.reason}`)
      return { ok: false, error: 'oauth_state' }
    }

    if (typeof params.code !== 'string' || !params.code) {
      return { ok: false, error: 'oauth_failed' }
    }

    let profile: GoogleProfile
    try {
      profile = await this.provider.authenticate(params.code, verified.payload.v)
    } catch (err) {
      // An unverified address is a distinct, actionable case; everything else the
      // library rejects (audience, signature, expiry, reused code) is just a refusal.
      const unverified = (err as Error).message.includes('not verified')
      this.logger.warn(`Google sign-in refused: ${(err as Error).message}`)
      return { ok: false, error: unverified ? 'oauth_unverified' : 'oauth_failed' }
    }

    try {
      const account = await this.resolveAccount(profile)
      return { ok: true, account: AuthService.toPublic(account.account, account.email), next: verified.payload.x }
    } catch (err) {
      this.logger.error(`Google sign-in failed after verification: ${(err as Error).message}`)
      return { ok: false, error: 'oauth_failed' }
    }
  }

  /**
   * Finds the account behind a verified Google identity, creating one if this is the
   * first time we have seen it.
   *
   * The lookup is by Google's `sub` and nothing else. In particular it never matches
   * on email: email is not something an account owner controls, so matching on it
   * would let anyone who can register an address resembling someone else's — an
   * admin's included — sign straight into that account.
   */
  private async resolveAccount(profile: GoogleProfile): Promise<{ account: AccountEntity; email: string | null }> {
    const existing = await this.findIdentity(profile.sub)
    if (existing) {
      if (existing.account) {
        // Keep the stored address current; Google allows it to change.
        if (profile.email && profile.email !== existing.email) {
          await this.identityRepo.update({ id: existing.id }, { email: profile.email })
          existing.email = profile.email
        }
        if (profile.picture && profile.picture !== existing.pictureUrl) {
          await this.identityRepo.update({ id: existing.id }, { pictureUrl: profile.picture })
        }
        return { account: await this.applyAdminRole(existing.account, profile.email ?? existing.email), email: existing.email }
      }
      // The identity outlived its account (only possible if rows were deleted by
      // hand, since the FK cascades). Fall through and make a new account rather
      // than 500 on every subsequent sign-in.
      this.logger.warn(`Identity ${existing.id} points at missing account ${existing.accountId}; recreating`)
    }

    const account = await this.accountRepo.save(
      this.accountRepo.create({ role: wantedRole(profile.email, this.provider.adminEmails) })
    )

    try {
      await this.identityRepo.save(
        this.identityRepo.create({
          accountId: account.id,
          provider: GOOGLE_PROVIDER,
          providerSubject: profile.sub,
          email: profile.email,
          pictureUrl: profile.picture,
        })
      )
    } catch (err) {
      // Two tabs finishing the first login at once both miss the lookup and both
      // try to insert; the unique index rejects the loser, which then re-reads and
      // lands on the account the winner created.
      if ((err as { code?: string }).code !== '23505') throw err
      const winner = await this.findIdentity(profile.sub)
      if (!winner?.account) throw err
      return { account: await this.applyAdminRole(winner.account, profile.email ?? winner.email), email: winner.email }
    }

    this.logger.log(`Provisioned account ${account.id} from a Google identity`)
    return { account, email: profile.email }
  }

  /**
   * Recomputes role from the allowlist and saves only when it actually changes.
   *
   * The allowlist is the single source of truth for admin, so this both promotes and
   * demotes: removing an address revokes access at that person's next sign-in. An
   * already-signed-in session sees the change on its next request regardless, because
   * AdminGuard reads role fresh from the joined account row every time.
   *
   * `email` is the address from the token we just verified; `?? stored` keeps a
   * verified admin from being demoted by an empty field.
   */
  private async applyAdminRole(account: AccountEntity, email: string | null): Promise<AccountEntity> {
    const role = wantedRole(email, this.provider.adminEmails)
    if (account.role === role) return account
    account.role = role
    this.logger.log(`role -> ${role} for account ${account.id}`)
    return this.accountRepo.save(account)
  }

  /**
   * Looks the identity up with its account already joined. The join is the point:
   * without it every sign-in costs a second round trip, and a row whose account is
   * gone is indistinguishable from a first-time visitor.
   */
  private findIdentity(sub: string): Promise<AccountIdentityEntity | null> {
    return this.identityRepo.findOne({
      where: { provider: GOOGLE_PROVIDER, providerSubject: sub },
      relations: { account: true },
    })
  }

  /** The verified address on an account's identity, for /auth/me. */
  async emailFor(accountId: number): Promise<string | null> {
    const identity = await this.identityRepo.findOne({ where: { accountId } })
    return identity?.email ?? null
  }
}
