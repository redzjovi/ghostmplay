import { Entity, PrimaryGeneratedColumn, Column, OneToOne, CreateDateColumn, Index } from 'typeorm'
import { MarketplaceItemDetailEntity } from './marketplace-item-detail.entity'

@Entity('marketplace_items')
export class MarketplaceItemEntity {
  @PrimaryGeneratedColumn() id!: number

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
  @Column({ type: 'text' }) gradeEffect!: string // Normal | Rare
  @Column({ type: 'integer' }) level!: number
  @Column({ type: 'integer' }) enchant!: number
  @Column({ type: 'text' }) equipmentType!: string
  @CreateDateColumn({ type: 'datetime' }) createdAt!: Date

  @OneToOne(() => MarketplaceItemDetailEntity, (d) => d.item, { cascade: true })
  detail?: MarketplaceItemDetailEntity
}
