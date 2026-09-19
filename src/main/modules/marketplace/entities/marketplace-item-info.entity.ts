import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm'
import { MarketplaceItemEntity } from './marketplace-item.entity'

@Entity('marketplace_item_infos')
export class MarketplaceItemInfoEntity {
  @PrimaryGeneratedColumn() id!: number

  @Index()
  @Column({ type: 'integer', name: 'item_id' })
  itemId!: number

  @ManyToOne(() => MarketplaceItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: MarketplaceItemEntity

  @Column({ type: 'text' }) title!: string
  @Column({ type: 'text', name: 'value_name' }) valueName!: string
  @Column({ type: 'text' }) value!: string
}
