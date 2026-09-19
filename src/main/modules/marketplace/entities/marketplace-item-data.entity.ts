import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm'
import { MarketplaceItemEntity } from './marketplace-item.entity'

@Entity('marketplace_item_datas')
export class MarketplaceItemDataEntity {
  @PrimaryGeneratedColumn() id!: number

  @Index()
  @Column({ type: 'integer', name: 'item_id' })
  itemId!: number

  @ManyToOne(() => MarketplaceItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: MarketplaceItemEntity

  @Column({ type: 'text' }) title!: string // Basic Effect | Set Composition | Set Effect
  @Column({ type: 'simple-json', nullable: true }) values!: string[] | null
}
