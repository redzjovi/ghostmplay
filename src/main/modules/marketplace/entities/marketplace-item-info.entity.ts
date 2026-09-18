import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm'
import { MarketplaceItemEntity } from './marketplace-item.entity'

@Entity('marketplace_item_infos')
export class MarketplaceItemInfoEntity {
  @PrimaryGeneratedColumn() id!: number

  @Index()
  @Column({ type: 'integer' })
  itemId!: number

  @ManyToOne(() => MarketplaceItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'itemId' })
  item!: MarketplaceItemEntity

  @Column({ type: 'text' }) title!: string
  @Column({ type: 'text' }) valueName!: string
  @Column({ type: 'text' }) value!: string
}
