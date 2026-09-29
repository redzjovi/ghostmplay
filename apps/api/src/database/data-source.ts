import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { config as loadEnv } from 'dotenv'
import { ENTITIES } from '../app.module'

loadEnv()

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('Missing required environment variable: DATABASE_URL')
}

/**
 * Standalone DataSource for the TypeORM CLI (`migration:generate` / `migration:run`).
 *
 * The TypeORM CLI requires the data source file to export exactly one DataSource,
 * so this must stay a default export only.
 */
const AppDataSource = new DataSource({
  type: 'postgres',
  url,
  entities: ENTITIES,
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true' || process.env.LOG_QUERY === '1' ? ['query', 'error'] : false,
})

export default AppDataSource
