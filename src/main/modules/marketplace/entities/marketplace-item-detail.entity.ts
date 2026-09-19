import { Entity, PrimaryColumn, Column, OneToOne, JoinColumn, OneToMany } from 'typeorm'
import { MarketplaceItemEntity } from './marketplace-item.entity'
import { MarketplaceItemAttributeEntity } from './marketplace-item-attribute.entity'
import { MarketplaceItemDataEntity } from './marketplace-item-data.entity'
import { MarketplaceItemInfoEntity } from './marketplace-item-info.entity'

@Entity('marketplace_item_detail')
export class MarketplaceItemDetailEntity {
  @PrimaryColumn({ type: 'integer', name: 'item_id' }) itemId!: number

  @OneToOne(() => MarketplaceItemEntity, (i) => i.detail, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'item_id' })
  item!: MarketplaceItemEntity

  // raw jsonb mirrors from note.txt — kept for fidelity + fast read
  @Column({ type: 'simple-json', nullable: true }) attributes!: unknown
  @Column({ type: 'simple-json', nullable: true }) datas!: unknown
  @Column({ type: 'simple-json', nullable: true }) infos!: unknown

  @Column({ type: 'datetime', nullable: true, name: 'mint_time' }) mintTime!: Date | null
  @Column({ type: 'datetime', nullable: true, name: 'market_time' }) marketTime!: Date | null

  @OneToMany(() => MarketplaceItemAttributeEntity, (a) => a.item, { cascade: true })
  attributeRows!: MarketplaceItemAttributeEntity[]

  @OneToMany(() => MarketplaceItemDataEntity, (d) => d.item, { cascade: true })
  dataRows!: MarketplaceItemDataEntity[]

  @OneToMany(() => MarketplaceItemInfoEntity, (i) => i.item, { cascade: true })
  infoRows!: MarketplaceItemInfoEntity[]
}
