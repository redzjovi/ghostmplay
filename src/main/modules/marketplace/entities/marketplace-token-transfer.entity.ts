import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm'

@Entity('marketplace_token_transfers')
export class MarketplaceTokenTransferEntity {
  @PrimaryGeneratedColumn() id!: number

  @Index()
  @Column({ type: 'integer', name: 'token_id' })
  tokenId!: number

  @Index()
  @Column({ type: 'text', nullable: true, name: 'game_name' })
  gameName!: string | null

  @Index()
  @Column({ type: 'text', name: 'seller_id' })
  sellerId!: string

  @Index()
  @Column({ type: 'text', name: 'buyer_id' })
  buyerId!: string

  @Index()
  @Column({ type: 'text', name: 'item_name' })
  itemName!: string

  @Column({ type: 'real' }) price!: number

  @Column({ type: 'text', default: 'NUMI' }) currency!: string

  @Index({ unique: true })
  @Column({ type: 'text', name: 'tx_hash' })
  txHash!: string

  @Column({ type: 'text', nullable: true, name: 'image_url' })
  imageUrl!: string | null

  @Index()
  @Column({ type: 'datetime', name: 'created_at' })
  createdAt!: Date

  @Index()
  @Column({ type: 'boolean', default: false })
  claimed!: boolean
}
