import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm'
import { AccountEntity } from './account.entity'

/** Only the provider that is actually wired up, but stored as text to stay extensible. */
export type IdentityProvider = 'google'

/**
 * An external identity belonging to an account — currently only Google.
 *
 * Kept separate from `accounts` so the login identity stays provider-agnostic and an
 * account can hold several identities (a password plus a Google account) without the
 * accounts table growing a column set per provider.
 *
 * Identity is `(provider, providerSubject)`, never the email. Google's `sub` is a
 * stable, never-reassigned id for the Google account; an email can change, can be
 * absent, and — critically — is not something an account's owner controls. Keying on
 * it would let anyone who can register an address matching someone else's claim
 * their account.
 */
@Entity('account_identities')
@Index('UQ_identity_provider_subject', ['provider', 'providerSubject'], { unique: true })
export class AccountIdentityEntity {
  @PrimaryGeneratedColumn({ type: 'integer' }) id!: number

  @Index()
  @Column({ type: 'integer', name: 'account_id' })
  accountId!: number

  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: AccountEntity

  @Column({ type: 'text' }) provider!: IdentityProvider

  /** The provider's own stable identifier for the user — Google's `sub`. */
  @Column({ type: 'text', name: 'provider_subject' }) providerSubject!: string

  @Column({ type: 'citext', nullable: true }) email!: string | null

  /** Informational only; never used to look an account up. */
  @Column({ type: 'text', nullable: true, name: 'picture_url' }) pictureUrl!: string | null

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date
}
