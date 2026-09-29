import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ScheduleModule } from '@nestjs/schedule'
import { ServeStaticModule } from '@nestjs/serve-static'
import { join } from 'path'
import { env } from './config/env'
import { MarketplaceModule } from './modules/marketplace/marketplace.module'
import { HealthModule } from './modules/health/health.module'
import { AuthModule } from './modules/auth/auth.module'
import { AccountEntity, SessionEntity } from './modules/auth/entities'
import { SyncModule } from './modules/sync/sync.module'
import { SyncStateEntity } from './modules/sync/entities'
import { CommonModule } from './common/common.module'
import {
  MarketplaceItemEntity,
  MarketplaceItemDetailEntity,
  MarketplaceFavoriteEntity,
  UserEntity,
  MarketplaceTokenTransferEntity,
} from './modules/marketplace/entities'

/**
 * Entities are registered explicitly (not globbed) so the compiled output has no
 * filesystem dependency on the build layout.
 */
export const ENTITIES = [
  MarketplaceItemEntity,
  MarketplaceItemDetailEntity,
  MarketplaceFavoriteEntity,
  UserEntity,
  MarketplaceTokenTransferEntity,
  AccountEntity,
  SessionEntity,
  SyncStateEntity,
]

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: env.databaseUrl,
      entities: ENTITIES,
      migrations: [join(__dirname, 'database/migrations/*{.ts,.js}')],
      // Schema is owned by migrations. synchronize must never be true against a shared DB.
      synchronize: false,
      // Single-container deployment means there is no concurrent-migration race, and
      // running on boot removes a whole class of "forgot to migrate" deploy bugs.
      // Set MIGRATIONS_RUN=false to require an explicit `migration:run` instead.
      migrationsRun: process.env.MIGRATIONS_RUN !== 'false',
      migrationsTransactionMode: 'each',
      // The public box is small and shared; a large pool buys nothing.
      poolSize: 5,
      extra: {
        max: 5,
        // DomCloud's PostgreSQL is reached over the container host bridge (10.0.2.2),
        // which is not exposed to the internet, so TLS is not required there.
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
        application_name: 'ghostmplay-api',
      },
      logging: env.logQuery ? ['query', 'error', 'warn'] : ['error', 'warn'],
    }),
    MarketplaceModule,
    HealthModule,
    AuthModule,
    CommonModule,
    SyncModule,
    ...(env.webRoot
      ? [
          ServeStaticModule.forRoot({
            rootPath: env.webRoot,
            // Keeps /api out of BOTH the static middleware and the built-in SPA
            // render fallback, so controllers always win. Note the v0.2 pattern
            // syntax: @nestjs/serve-static resolves path-to-regexp 0.2, not v6.
            exclude: ['/api/(.*)'],
            serveStaticOptions: {
              index: ['index.html'],
              // Must call next() on a miss so the request reaches the Nest router;
              // ServeStaticModule's own renderPath then serves index.html.
              fallthrough: true,
              setHeaders(res, filePath) {
                // Bundlers emit content-hashed filenames into a dedicated assets
                // directory, so those are safe to cache forever. Everything else
                // (notably index.html) must stay revalidatable. `immutable` and
                // `_nuxt` cover SvelteKit and Nuxt in case the web app is ever
                // swapped out for one of them.
                const posix = filePath.replace(/\\/g, '/')
                const hashed =
                  posix.includes('/assets/') ||
                  posix.includes('/immutable/') ||
                  posix.includes('/_nuxt/')
                res.setHeader(
                  'Cache-Control',
                  hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
                )
              },
            },
          }),
        ]
      : []),
  ],
})
export class AppModule {}
