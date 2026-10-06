import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm'

export type AccountRole = 'user' | 'admin'

/**
 * A login identity. Distinct from the `users` table, which holds the NFT seller /
 * buyer wallets scraped from the upstream API and has nothing to do with sign-in.
 *
 * Deliberately holds no credential: there is no username and no password hash, so
 * `id` and `role` are all an account has. Google is the only way in, the verified
 * address lives on AccountIdentityEntity, and admin is granted per sign-in from the
 * GOOGLE_ADMIN_EMAILS allowlist rather than being stored as something you could log
 * into. Nothing can be forgotten, guessed or reset.
 */
@Entity('accounts')
export class AccountEntity {
  @PrimaryGeneratedColumn({ type: 'integer' }) id!: number

  @Column({ type: 'text', default: 'user', name: 'role' })
  role!: AccountRole

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date
}
