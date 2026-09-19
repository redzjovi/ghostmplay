import { Entity, PrimaryColumn, Column, OneToOne, Index } from 'typeorm'
import { MarketplaceItemDetailEntity } from './marketplace-item-detail.entity'

@Entity('marketplace_items')
export class MarketplaceItemEntity {
  // Reuse id as item_id from market-api (per user: Reuse id as item_id)
  @PrimaryColumn({ type: 'integer' }) id!: number

  @Index({ unique: true })
  @Column({ type: 'integer' })
  tokenId!: number

  @Column({ type: 'text' }) ownerId!: string
  @Column({ type: 'text' }) ownerName!: string
  @Column({ type: 'text' }) sellerId!: string
  @Column({ type: 'text' }) imageUrl!: string
  @Column({ type: 'text' }) name!: string
  @Column({ type: 'text', default: 'NUMI' }) currency!: string
  @Column({ type: 'real' }) price!: number
  @Index()
  @Column({ type: 'text' }) gradeEffect!: string // Normal | Rare
  @Column({ type: 'integer' }) level!: number
  @Column({ type: 'integer' }) enchant!: number
  @Index()
  @Column({ type: 'text' }) equipmentType!: string
  // created_at as timestamptz per user (API gives epoch seconds)
  @Column({ type: 'datetime' }) createdAt!: Date

  @OneToOne(() => MarketplaceItemDetailEntity, (d) => d.item, { cascade: true })
  detail?: MarketplaceItemDetailEntity
}
