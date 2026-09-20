import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { MarketplaceItemEntity } from '../modules/marketplace/entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from '../modules/marketplace/entities/marketplace-item-detail.entity'
import { MarketplaceFavoriteEntity } from '../modules/marketplace/entities/marketplace-favorite.entity'

const dbPath = process.env.GHOSTMPLAY_DB ?? 'ghostmplay.db'

export const AppDataSource = new DataSource({
  type: 'sqljs',
  location: dbPath,
  autoSave: true,
  entities: [MarketplaceItemEntity, MarketplaceItemDetailEntity, MarketplaceFavoriteEntity],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1' ? ['query', 'error'] : false
})

export default AppDataSource
