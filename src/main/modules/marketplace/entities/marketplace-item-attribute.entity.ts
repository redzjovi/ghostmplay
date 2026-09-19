import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm'
import { MarketplaceItemEntity } from './marketplace-item.entity'

@Entity('marketplace_item_attributes')
export class MarketplaceItemAttributeEntity {
  @PrimaryGeneratedColumn() id!: number

  @Index()
  @Column({ type: 'integer', name: 'item_id' })
  itemId!: number

  @ManyToOne(() => MarketplaceItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: MarketplaceItemEntity

  @Column({ type: 'text' }) type!: string // Level | Equipment Type | Enchant | Grade Effect
  @Column({ type: 'text' }) value!: string
}
