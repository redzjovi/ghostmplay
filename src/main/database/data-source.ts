import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { MarketplaceItemEntity } from '../modules/marketplace/entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from '../modules/marketplace/entities/marketplace-item-detail.entity'
import { MarketplaceFavoriteEntity } from '../modules/marketplace/entities/marketplace-favorite.entity'
import { UserEntity } from '../modules/marketplace/entities/user.entity'
import { MarketplaceTokenTransferEntity } from '../modules/marketplace/entities/marketplace-token-transfer.entity'

const dbPath = process.env.GHOSTMPLAY_DB ?? 'ghostmplay.db'

export const AppDataSource = new DataSource({
  type: 'sqljs',
  location: dbPath,
  autoSave: true,
  entities: [MarketplaceItemEntity, MarketplaceItemDetailEntity, MarketplaceFavoriteEntity, UserEntity, MarketplaceTokenTransferEntity],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1' ? ['query', 'error'] : false
})

export default AppDataSource
