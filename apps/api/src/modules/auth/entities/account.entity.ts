import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm'

export type AccountRole = 'user' | 'admin'

/**
 * A login identity. Distinct from the `users` table, which holds the NFT seller /
 * buyer wallets scraped from the upstream API and has nothing to do with sign-in.
 */
@Entity('accounts')
export class AccountEntity {
  @PrimaryGeneratedColumn({ type: 'integer' }) id!: number

  @Index({ unique: true })
  @Column({ type: 'citext' }) username!: string

  @Column({ type: 'text', name: 'password_hash' }) passwordHash!: string

  @Column({ type: 'text', default: 'user', name: 'role' })
  role!: AccountRole

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' }) createdAt!: Date
}
