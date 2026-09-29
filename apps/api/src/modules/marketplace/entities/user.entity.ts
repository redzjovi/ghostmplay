import { Entity, PrimaryColumn, Column } from 'typeorm'

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase()
}

@Entity('users')
export class UserEntity {
  // Wallet address, lowercased for case-insensitive joins
  @PrimaryColumn({ type: 'text' }) id!: string

  @Column({ type: 'text', nullable: true }) username!: string | null
}
