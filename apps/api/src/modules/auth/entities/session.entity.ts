import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm'
import { AccountEntity } from './account.entity'

/**
 * Server-side session. Storing sessions in Postgres rather than in a signed
 * cookie means an account can be logged out server-side and keeps the cookie
 * opaque. Only a SHA-256 hash of the token is stored.
 */
@Entity('sessions')
export class SessionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id!: string

  @Index()
  @Column({ type: 'integer', name: 'account_id' })
  accountId!: number

  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: AccountEntity

  @Index({ unique: true })
  @Column({ type: 'text', name: 'token_hash' }) tokenHash!: string

  @Index()
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date

  @Index()
  @Column({ type: 'timestamptz', name: 'expires_at' }) expiresAt!: Date
}
