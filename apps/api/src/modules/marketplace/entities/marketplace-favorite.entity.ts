import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm'

@Entity('marketplace_favorites')
@Index('UQ_favorites_account_name', ['accountId', 'name'], { unique: true })
export class MarketplaceFavoriteEntity {
  @PrimaryGeneratedColumn({ type: 'integer' }) id!: number

  /** Owner. Favorite names are unique per account, not globally. */
  @Index()
  @Column({ type: 'integer', name: 'account_id' })
  accountId!: number

  @Column({ type: 'text' }) name!: string

  @Column({ type: 'text', nullable: true }) q!: string | null

  @Column({ type: 'jsonb', nullable: true, name: 'equipment_types' })
  equipmentTypes!: string[] | null

  @Column({ type: 'jsonb', nullable: true, name: 'grade_effects' })
  gradeEffects!: string[] | null

  @Column({ type: 'text', default: 'recent', name: 'sort' })
  sort!: string

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date
}
