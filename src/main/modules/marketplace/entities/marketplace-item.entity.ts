import { Entity, PrimaryColumn, Column, OneToOne, Index } from 'typeorm'
import { MarketplaceItemDetailEntity } from './marketplace-item-detail.entity'

@Entity('marketplace_items')
export class MarketplaceItemEntity {
  // Reuse id as item_id from market-api (per user: Reuse id as item_id)
  @PrimaryColumn({ type: 'integer' }) id!: number

  @Index({ unique: true })
  @Column({ type: 'integer', name: 'token_id' })
  tokenId!: number

  @Column({ type: 'text', name: 'owner_id' }) ownerId!: string
  @Column({ type: 'text', name: 'owner_name' }) ownerName!: string
  @Column({ type: 'text', name: 'seller_id' }) sellerId!: string
  @Column({ type: 'text', name: 'image_url' }) imageUrl!: string
  @Column({ type: 'text' }) name!: string
  @Column({ type: 'text', default: 'NUMI' }) currency!: string
  @Column({ type: 'real' }) price!: number
  @Index()
  @Column({ type: 'text', name: 'grade_effect' }) gradeEffect!: string // Normal | Rare
  @Column({ type: 'integer' }) level!: number
  @Column({ type: 'integer' }) enchant!: number
  @Index()
  @Column({ type: 'text', name: 'equipment_type' }) equipmentType!: string
  // created_at as timestamptz per user (API gives epoch seconds)
  @Column({ type: 'datetime', name: 'created_at' }) createdAt!: Date

  @OneToOne(() => MarketplaceItemDetailEntity, (d) => d.item, { cascade: true })
  detail?: MarketplaceItemDetailEntity
}
