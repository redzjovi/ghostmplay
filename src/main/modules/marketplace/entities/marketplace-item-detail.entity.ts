import { Entity, PrimaryColumn, Column, OneToOne, JoinColumn } from 'typeorm'
import { MarketplaceItemEntity } from './marketplace-item.entity'

@Entity('marketplace_item_detail')
export class MarketplaceItemDetailEntity {
  @PrimaryColumn({ type: 'integer', name: 'item_id' }) itemId!: number

  @OneToOne(() => MarketplaceItemEntity, (i) => i.detail, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: MarketplaceItemEntity

  // raw jsonb mirrors from note.txt — kept for fidelity + fast read (market_time removed: duplicate of marketplace_items.created_at)
  @Column({ type: 'simple-json', nullable: true }) attributes!: unknown
  @Column({ type: 'simple-json', nullable: true }) datas!: unknown
  @Column({ type: 'simple-json', nullable: true }) infos!: unknown
}
