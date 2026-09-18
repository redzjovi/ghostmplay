import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { MarketplaceItemEntity } from '../modules/marketplace/entities/marketplace-item.entity'
import { MarketplaceItemDetailEntity } from '../modules/marketplace/entities/marketplace-item-detail.entity'
import { MarketplaceItemAttributeEntity } from '../modules/marketplace/entities/marketplace-item-attribute.entity'
import { MarketplaceItemDataEntity } from '../modules/marketplace/entities/marketplace-item-data.entity'
import { MarketplaceItemInfoEntity } from '../modules/marketplace/entities/marketplace-item-info.entity'

const dbPath = process.env.GHOSTMPLAY_DB ?? 'ghostmplay.db'

export const AppDataSource = new DataSource({
  type: 'better-sqlite3',
  database: dbPath,
  entities: [
    MarketplaceItemEntity,
    MarketplaceItemDetailEntity,
    MarketplaceItemAttributeEntity,
    MarketplaceItemDataEntity,
    MarketplaceItemInfoEntity
  ],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  logging: false
})

export default AppDataSource
